// 定時任務（每分鐘由雲函數定時觸發器執行；控制台把本函數「超時時間」設為 60 秒）
// 1. 到期的待支付訂單：查單 → 關單 → 放出場地
// 2. 定時對帳：最近關閉／取消的訂單再向微信查一次，有收款就全額退款（三道防線第 3 道）
// 3. 退款補做：結果不明的退款，用同一個退款單號向微信重試，直到有明確結果；已受理的退款用退款查詢確認到帳，異常時通知管理端
// 4. 打完的場地卡片標為「已使用」，更新訂單狀態
// 5. 固定日期活動過期：未使用張數自動全額退款
// 6. 每天凌晨 3 點：最後一次訂場超過 1 年的客人，自動刪除手機號、頭像、暱稱（訂單和核銷記錄裡的手機號一併刪除）
// 7. 同一時間（凌晨 3 點）：日誌保留 1 年；訂單自交易完成起滿 3 年後匿名化
// 每項任務分批處理，整次執行最多約 50 秒，做不完的下一分鐘繼續
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const u = require('./lib/util')
const pay = require('./lib/pay')
const ord = require('./lib/orders')
const cal = require('./lib/calendar')

const BUDGET_MS = 50 * 1000
let deadline = 0
const timeLeft = () => Date.now() < deadline

async function settleExpired(now) {
  const res = await db.collection('orders').where({ status: 'pending', expiresAt: _.lt(now) }).orderBy('expiresAt', 'asc').limit(100).get()
  for (const o of res.data) {
    if (!timeLeft()) break
    await ord.settle(cloud, db, o)
  }
}

async function reconcile(now) {
  const res = await db.collection('orders')
    .where({ status: _.in(['closed', 'cancelled']), reconciled: _.neq(true), createdAt: _.gt(now - 2 * u.HOUR) })
    .orderBy('createdAt', 'asc').limit(100).get()
  for (const o of res.data) {
    if (!timeLeft()) break
    try {
      // 客人提前取消的訂單：滿 5 分鐘後向微信正式關單
      if (o.status === 'cancelled' && !o.wxClosed && now - o.createdAt >= 5 * 60 * 1000) {
        await pay.closeOrder(cloud, o).catch(() => {})
        await db.collection('orders').doc(o._id).update({ data: { wxClosed: true } })
      }
      const paid = await ord.confirmIfPaid(cloud, db, o)
      if (paid) continue
      if (now - o.createdAt > 30 * 60 * 1000) await db.collection('orders').doc(o._id).update({ data: { reconciled: true } })
    } catch (e) {
      console.error('reconcile', o._id, e)
    }
  }
}

async function retryRefunds(now) {
  // 公平輪轉（澄清 H2）：先處理還沒試過的，再按「下次重試時間」最早的輪流；未到時間的不查出來，
  // 否則一直失敗的前 20 筆會永遠擋住後面的退款
  const base = { status: _.in(['pending', 'unknown']), at: _.lt(now - 60 * 1000) }
  const fresh = await db.collection('refunds')
    .where(_.and([base, { nextRetryAt: _.exists(false) }]))
    .orderBy('at', 'asc').limit(20).get()
  const list = fresh.data
  if (list.length < 20) {
    const due = await db.collection('refunds')
      .where(_.and([base, { nextRetryAt: _.lte(now) }]))
      .orderBy('nextRetryAt', 'asc').limit(20 - list.length).get()
    list.push(...due.data)
  }
  for (const r of list) {
    if (!timeLeft()) break
    try {
      await ord.processRefund(cloud, db, r._id)
    } catch (e) {
      console.error('retryRefund', r._id, e)
    }
  }
}

async function confirmRefunds(now) {
  const res = await db.collection('refunds')
    .where(_.and([
      { status: 'success', wxState: 'ACCEPTED', doneAt: _.lt(now - 2 * 60 * 1000).and(_.gt(now - 30 * u.DAY)) },
      // 剛查過的（處理中）先排除在查詢外，否則它們會佔滿前 20 名，擋住後面的異常退款
      _.or([{ wxCheckedAt: _.exists(false) }, { wxCheckedAt: _.lt(now - 10 * 60 * 1000) }])
    ]))
    .orderBy('doneAt', 'asc').limit(20).get()
  for (const r of res.data) {
    if (!timeLeft()) break
    try {
      await ord.confirmRefund(cloud, db, r._id)
    } catch (e) {
      console.error('confirmRefund', r._id, e)
    }
  }
}

async function finishCourts(now) {
  const res = await db.collection('order_items')
    .where({ kind: 'court', status: 'active', startAt: _.lte(now - u.HOUR) })
    .limit(500).get()
  if (!res.data.length) return
  const ids = res.data.map(i => i._id)
  for (let i = 0; i < ids.length; i += 100) {
    await db.collection('order_items').where({ _id: _.in(ids.slice(i, i + 100)), status: 'active' }).update({ data: { status: 'used' } })
  }
  for (const orderId of [...new Set(res.data.map(i => i.orderId))]) {
    if (!timeLeft()) break
    await ord.refreshStatus(db, orderId).catch(e => console.error('refreshStatus', orderId, e))
  }
}

async function expireProducts(now) {
  const today = u.dateStr(now)
  // 退款中、失敗後 1 小時冷卻中的券在查詢時就排除；先處理沒失敗過的，再按「失敗最早」的輪流，
  // 一直失敗的前 50 張不會永遠佔住名額（澄清 H3）
  const base = [
    { kind: 'product', fixedDate: true, codeActive: true, activityDate: _.lt(today) },
    _.or([{ refunding: _.exists(false) }, { refunding: '' }])
  ]
  const fresh = await db.collection('order_items')
    .where(_.and([...base, { expireRefundFailAt: _.exists(false) }]))
    .limit(50).get()
  const list = fresh.data
  if (list.length < 50) {
    const retry = await db.collection('order_items')
      .where(_.and([...base, { expireRefundFailAt: _.lt(now - 60 * 60 * 1000) }]))
      .orderBy('expireRefundFailAt', 'asc').limit(50 - list.length).get()
    list.push(...retry.data)
  }
  for (const it of list) {
    if (!timeLeft()) break
    if (it.refunding) continue // 有退款在處理，下一輪再看
    if (it.expireRefundFailAt && now - it.expireRefundFailAt < 60 * 60 * 1000) continue // 剛失敗過，1 小時後再試，避免每分鐘重複通知
    const available = ord.productAvailable(it)
    if (available <= 0) {
      await db.collection('order_items').doc(it._id).update({ data: { codeActive: false } })
      continue
    }
    try {
      const amount = Math.min(available * it.price, ord.itemRefundable(it))
      if (amount <= 0) {
        await db.collection('order_items').doc(it._id).update({ data: { codeActive: false } })
        continue
      }
      // 這部分張數在退款成功時記為「已過期」而不是「已退款」
      await ord.refundItems(cloud, db, {
        order: { _id: it.orderId }, parts: [{ itemId: it._id, qty: available, amount }],
        operatorId: '', by: 'system', reason: '活动过期未使用', asExpired: true
      })
    } catch (e) {
      if (e.code === 'BAD_STATUS' || e.code === 'NOT_FOUND') {
        await db.collection('order_items').doc(it._id).update({ data: { codeActive: false } })
      } else {
        console.error('expireProducts', it._id, e)
        await db.collection('order_items').doc(it._id).update({ data: { expireRefundFailAt: now } }).catch(() => {})
      }
    }
  }
}

async function purgePhones(now) {
  const yearAgo = now - 365 * u.DAY
  const cond = _.and([
    { phone: _.neq('') },
    _.or([{ lastBookedAt: _.lt(yearAgo) }, { lastBookedAt: _.exists(false), phoneBoundAt: _.lt(yearAgo) }]),
    { role: 'customer' }
  ])
  while (timeLeft()) {
    const res = await db.collection('users').where(cond).limit(100).get()
    if (!res.data.length) break
    const ids = res.data.map(x => x._id)
    await db.collection('orders').where({ userId: _.in(ids) }).update({ data: { phone: '', phonePurged: true } })
    await db.collection('verify_logs').where({ userId: _.in(ids) }).update({ data: { phone: '' } })
    // 舊核銷記錄可能沒有 userId：按這些客人的訂單號再清一次
    const orderIds = (await cal.getAll(db.collection('orders'), { userId: _.in(ids) })).map(o => o._id)
    for (let i = 0; i < orderIds.length; i += 100) {
      await db.collection('verify_logs').where({ orderId: _.in(orderIds.slice(i, i + 100)) }).update({ data: { phone: '' } })
    }
    await db.collection('users').where({ _id: _.in(ids) }).update({ data: { phone: '', nickname: '', avatar: '', phonePurgedAt: now } })
  }
}

// 資料到期處理（隱私政策「信息存在哪裡，保存多久」）：
// - 管理操作日誌、通知記錄：保留 1 年（網絡安全法要求至少 6 個月），之後刪除
// - 訂單：交易記錄自交易完成起保存 3 年（電子商務法），之後匿名化——清掉手機號、微信身份和客人編號，只保留金額和明細供報表使用
const RETAIN_MS = 3 * 365 * u.DAY

// 交易完成時間 = 付款、場地打完、活動日過去、券核銷、退款受理中最晚的時間（澄清 H8）
async function completedAt(o) {
  let last = Math.max(o.createdAt || 0, o.payTime || 0)
  const items = await cal.getAll(db.collection('order_items'), { orderId: o._id })
  for (const it of items) {
    if (it.kind === 'court' && it.startAt) last = Math.max(last, it.startAt + u.HOUR)
    if (it.kind === 'product' && it.fixedDate && it.activityDate) last = Math.max(last, u.dayStart(it.activityDate) + u.DAY)
  }
  for (const v of await cal.getAll(db.collection('verify_logs'), { orderId: o._id })) last = Math.max(last, v.undoneAt || 0, v.at || 0)
  for (const r of await cal.getAll(db.collection('refunds'), { orderId: o._id })) last = Math.max(last, r.doneAt || 0, r.at || 0)
  return last
}

async function purgeOld(now) {
  const logCut = now - 365 * u.DAY
  for (const name of ['audit_logs', 'notices']) {
    for (let n = 0; n < 20 && timeLeft(); n++) {
      const r = await db.collection(name).where({ at: _.lt(logCut) }).remove()
      if (!r.stats || !r.stats.removed) break
    }
  }
  const orderCut = now - RETAIN_MS
  while (timeLeft()) {
    // 下單滿 3 年只是「可能到期」；還要從交易完成那天起算滿 3 年才匿名化（澄清 H8）。
    // 未滿的記下 retainUntil，到時才再查出來
    const res = await db.collection('orders')
      .where(_.and([
        { createdAt: _.lt(orderCut) }, { anonymizedAt: _.exists(false) }, { status: _.neq('pending') }, { status: _.neq('active') },
        _.or([{ retainUntil: _.exists(false) }, { retainUntil: _.lte(now) }])
      ]))
      .limit(100).get()
    if (!res.data.length) break
    const ids = []
    for (const o of res.data) {
      const until = (await completedAt(o)) + RETAIN_MS
      if (until <= now) ids.push(o._id)
      else await db.collection('orders').doc(o._id).update({ data: { retainUntil: until } })
    }
    if (!ids.length) continue
    await db.collection('order_items').where({ orderId: _.in(ids) }).update({ data: { userId: '' } })
    await db.collection('verify_logs').where({ orderId: _.in(ids) }).update({ data: { phone: '', userId: '' } })
    await db.collection('orders').where({ _id: _.in(ids) }).update({ data: { phone: '', openid: '', userId: '', anonymizedAt: now } })
  }
}

exports.main = async () => {
  const now = Date.now()
  deadline = now + BUDGET_MS
  const tasks = [
    ['settleExpired', () => settleExpired(now)],
    ['retryRefunds', () => retryRefunds(now)],
    ['reconcile', () => reconcile(now)],
    ['confirmRefunds', () => confirmRefunds(now)],
    ['finishCourts', () => finishCourts(now)],
    ['expireProducts', () => expireProducts(now)]
  ]
  const d = new Date(now + 8 * u.HOUR)
  if (d.getUTCHours() === 3 && d.getUTCMinutes() < 10) {
    tasks.push(['purgePhones', () => purgePhones(now)])
    tasks.push(['purgeOld', () => purgeOld(now)])
  }
  for (const [name, fn] of tasks) {
    if (!timeLeft()) break
    try {
      await fn()
    } catch (e) {
      console.error(name, e)
    }
  }
  return { ok: true }
}
