// 初始化數據庫 + 數據遷移。只在雲開發控制台「雲端測試」執行；可重複執行，不會出錯，也不會重複修改
// 1. 建立所有集合和設定文檔
// 2. 數據遷移（舊版測試數據才需要；全新環境執行也無妨）：
//    - 訂單補上卡片清單 itemIds
//    - 核銷記錄補上客人 userId（刪除手機號時要用）
//    - 所有券碼登記到 coupon_codes；如有重複券碼，給較新的那張卡片換新碼
// 執行前把本函數「超時時間」設為 60 秒；返回結果裡 done 為 false 時再執行一次，直到 done 為 true
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COLLECTIONS = [
  'users', 'slot_locks', 'orders', 'order_items', 'products', 'prices',
  'business_hours', 'banners', 'refunds', 'audit_logs', 'invites', 'settings',
  'verify_logs', 'notices', 'user_pending', 'coupon_codes'
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

// 按 _id 順序逐批處理，處理過的不會重複；時間不夠時返回 false
async function scan(coll, cond, deadline, fn) {
  let last = ''
  for (;;) {
    if (Date.now() > deadline) return false
    const where = last ? { ...cond, _id: _.gt(last) } : cond
    const res = await db.collection(coll).where(where).orderBy('_id', 'asc').limit(100).get()
    for (const d of res.data) await fn(d)
    if (res.data.length < 100) return true
    last = res.data[res.data.length - 1]._id
  }
}

async function migrate(deadline) {
  const report = { ordersFixed: 0, ordersWithoutItems: [], logsFixed: 0, codesRegistered: 0, codesChanged: [] }

  const a = await scan('orders', { itemIds: _.exists(false) }, deadline, async o => {
    const items = await db.collection('order_items').where({ orderId: o._id }).limit(1000).get()
    if (!items.data.length) {
      report.ordersWithoutItems.push(o._id)
      return
    }
    await db.collection('orders').doc(o._id).update({ data: { itemIds: items.data.map(i => i._id).sort() } })
    report.ordersFixed++
  })

  const b = await scan('verify_logs', { userId: _.exists(false) }, deadline, async l => {
    const o = await getDoc('orders', l.orderId)
    await db.collection('verify_logs').doc(l._id).update({ data: { userId: o ? o.userId : '' } })
    report.logsFixed++
  })

  const c = await scan('order_items', { kind: 'product', code: _.neq('') }, deadline, async it => {
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

  return { done: a && b && c, ...report }
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
