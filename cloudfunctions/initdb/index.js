// 初始化數據庫 + 數據遷移。只在雲開發控制台「雲端測試」執行；可重複執行，不會出錯，也不會重複修改
// 1. 建立所有集合和設定文檔
// 2. 數據遷移（舊版測試數據才需要；全新環境執行也無妨）：
//    - 訂單補上卡片清單 itemIds
//    - 核銷記錄補上客人 userId（刪除手機號時要用）
//    - 所有券碼登記到 coupon_codes；如有重複券碼，給較新的那張卡片換新碼
//    - 合併重複帳號（同一 OpenID 多個帳號，澄清 K4）：只合併、不刪除
// 3. 進度存在 settings/initdb_progress，超時後再執行會從上次的位置繼續（澄清 K12）
// 執行前把本函數「超時時間」設為 60 秒；返回結果裡 done 為 false 時再執行一次，直到 done 為 true
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COLLECTIONS = [
  'users', 'slot_locks', 'orders', 'order_items', 'products', 'prices',
  'business_hours', 'banners', 'refunds', 'audit_logs', 'invites', 'settings',
  'verify_logs', 'notices', 'user_pending', 'coupon_codes', 'locks'
]

const BUDGET_MS = 50 * 1000

function randomCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10)
  return s
}

async function getDoc(coll, id) {
  try {
    return (await db.collection(coll).doc(id).get()).data
  } catch (e) {
    return null
  }
}

// 按 _id 順序逐批處理，處理過的不會重複；每批處理完把位置存進 settings/initdb_progress，
// 時間不夠時返回 false，下次執行從存下的位置繼續（澄清 K12）
async function scan(progress, key, coll, cond, deadline, fn) {
  let last = progress[key] || ''
  for (;;) {
    if (Date.now() > deadline) return false
    const where = last ? { ...cond, _id: _.gt(last) } : cond
    const res = await db.collection(coll).where(where).orderBy('_id', 'asc').limit(100).get()
    for (const d of res.data) {
      if (Date.now() > deadline) return false
      await fn(d)
      last = d._id
      progress[key] = last
    }
    await db.collection('settings').doc('initdb_progress').set({ data: progress })
    if (res.data.length < 100) {
      progress[key] = 'DONE'
      await db.collection('settings').doc('initdb_progress').set({ data: progress })
      return true
    }
  }
}

const RANK = { owner: 3, staff: 2, customer: 1 }

// 同一 OpenID 有多個帳號時合併到一個（澄清 K4）：保留的帳號依序取老闆 > 員工 > 有手機號 > 最早建立；
// 其餘帳號的訂單、卡片、核銷記錄、操作記錄改接到保留帳號，重複帳號標記為已合併（不刪除）
async function mergeUser(u, report) {
  if (!u.openid || u.mergedInto) return
  const res = await db.collection('users').where({ openid: u.openid }).limit(100).get()
  if (res.data.length < 2) return
  const list = res.data.slice().sort((a, b) =>
    (RANK[b.role] || 0) - (RANK[a.role] || 0) || (b.phone ? 1 : 0) - (a.phone ? 1 : 0) || (a.createdAt || 0) - (b.createdAt || 0) || (a._id < b._id ? -1 : 1))
  const keep = list[0]
  const patch = {}
  for (const d of list.slice(1)) {
    if (!keep.phone && !patch.phone && d.phone) patch.phone = d.phone
    if ((d.agreedPrivacyAt || 0) > (patch.agreedPrivacyAt || keep.agreedPrivacyAt || 0)) {
      patch.agreedPrivacyAt = d.agreedPrivacyAt
      patch.agreedPrivacyVersion = d.agreedPrivacyVersion || ''
    }
    await db.collection('orders').where({ userId: d._id }).update({ data: { userId: keep._id } })
    await db.collection('order_items').where({ userId: d._id }).update({ data: { userId: keep._id } })
    await db.collection('verify_logs').where({ userId: d._id }).update({ data: { userId: keep._id } })
    await db.collection('verify_logs').where({ operatorId: d._id }).update({ data: { operatorId: keep._id } })
    await db.collection('refunds').where({ operatorId: d._id }).update({ data: { operatorId: keep._id } })
    await db.collection('audit_logs').where({ actorId: d._id }).update({ data: { actorId: keep._id } })
    const pend = await getDoc('user_pending', d._id)
    if (pend && !(await getDoc('user_pending', keep._id))) {
      const { _id, ...data } = pend
      await db.collection('user_pending').doc(keep._id).set({ data })
    }
    const owner = await getDoc('settings', 'owner')
    if (owner && owner.ownerId === d._id) await db.collection('settings').doc('owner').update({ data: { ownerId: keep._id } })
    await db.collection('users').doc(d._id).update({
      data: { openid: `merged:${u.openid}`, mergedInto: keep._id, mergedAt: Date.now(), mergedRole: d.role || 'customer', role: 'customer' }
    })
    report.usersMerged.push({ from: d._id, into: keep._id })
  }
  if (Object.keys(patch).length) await db.collection('users').doc(keep._id).update({ data: patch })
}

async function migrate(deadline) {
  const report = { ordersFixed: 0, ordersWithoutItems: [], logsFixed: 0, codesRegistered: 0, codesChanged: [], usersMerged: [] }
  const progress = (await getDoc('settings', 'initdb_progress')) || {}
  delete progress._id

  const a = progress.orders === 'DONE' || await scan(progress, 'orders', 'orders', { itemIds: _.exists(false) }, deadline, async o => {
    const items = await db.collection('order_items').where({ orderId: o._id }).limit(1000).get()
    if (!items.data.length) {
      report.ordersWithoutItems.push(o._id)
      return
    }
    await db.collection('orders').doc(o._id).update({ data: { itemIds: items.data.map(i => i._id).sort() } })
    report.ordersFixed++
  })

  const b = progress.verifyLogs === 'DONE' || await scan(progress, 'verifyLogs', 'verify_logs', { userId: _.exists(false) }, deadline, async l => {
    const o = await getDoc('orders', l.orderId)
    await db.collection('verify_logs').doc(l._id).update({ data: { userId: o ? o.userId : '' } })
    report.logsFixed++
  })

  const c = progress.codes === 'DONE' || await scan(progress, 'codes', 'order_items', { kind: 'product', code: _.neq('') }, deadline, async it => {
    if (!it.code) return
    const reg = await getDoc('coupon_codes', it.code)
    if (reg && reg.itemId === it._id) return
    if (!reg) {
      await db.collection('coupon_codes').add({ data: { _id: it.code, itemId: it._id, orderId: it.orderId, at: Date.now() } })
      report.codesRegistered++
      return
    }
    // 重複券碼：這張卡片換一個沒用過的新碼（客人在「我的订单」看到的就是新碼）
    for (let i = 0; i < 20; i++) {
      const code = randomCode()
      if (await getDoc('coupon_codes', code)) continue
      const used = await db.collection('order_items').where({ code }).count()
      if (used.total) continue
      await db.collection('coupon_codes').add({ data: { _id: code, itemId: it._id, orderId: it.orderId, at: Date.now() } })
      await db.collection('order_items').doc(it._id).update({ data: { code } })
      report.codesChanged.push({ itemId: it._id, from: it.code, to: code })
      return
    }
    throw new Error(`无法为 ${it._id} 生成新券码`)
  })

  const d = progress.users === 'DONE' || await scan(progress, 'users', 'users', { openid: _.exists(true) }, deadline, async x => mergeUser(x, report))

  const done = a && b && c && d
  // 全部完成才清除進度，下次執行（例如之後更新程式）從頭再檢查一次
  if (done) await db.collection('settings').doc('initdb_progress').remove().catch(() => {})
  return { done, ...report }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID) return { ok: false, message: '请在云开发控制台执行' }
  const deadline = Date.now() + BUDGET_MS

  const created = []
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name)
      created.push(name)
    } catch (e) {
      // 已存在則略過
    }
  }

  // 老闆手機號備用路：把唐先生的手機號填在 presetPhone（在控制台直接改這條記錄）
  try {
    await db.collection('settings').add({ data: { _id: 'owner', presetPhone: '', ownerId: '' } })
  } catch (e) {
    // 已存在則略過
  }

  const migration = await migrate(deadline)
  return { ok: true, created, migration }
}
