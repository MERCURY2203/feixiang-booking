// 定時任務（每分鐘由雲函數定時觸發器執行；控制台把本函數「超時時間」設為 60 秒）
// 1. 到期的待支付訂單：查單 → 關單 → 放出場地
// 2. 定時對帳：最近關閉／取消的訂單再向微信查一次，有收款就全額退款（三道防線第 3 道）
// 3. 退款補做：結果不明的退款，用同一個退款單號向微信重試，直到有明確結果；已受理的退款用退款查詢確認到帳，異常時通知管理端
// 4. 打完的場地卡片標為「已使用」，更新訂單狀態
// 5. 固定日期活動過期：未使用張數自動全額退款
// 6. 每天凌晨 3 點：最後一次訂場超過 1 年的客人，自動刪除手機號、頭像、暱稱（訂單和核銷記錄裡的手機號一併刪除）
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
  const res = await db.collection('refunds')
    .where({ status: _.in(['pending', 'unknown']), at: _.lt(now - 60 * 1000) })
    .orderBy('at', 'asc').limit(20).get()
  for (const r of res.data) {
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
    .where({ status: 'success', wxState: 'ACCEPTED', doneAt: _.lt(now - 2 * 60 * 1000).and(_.gt(now - 30 * u.DAY)) })
    .orderBy('doneAt', 'asc').limit(20).get()
  for (const r of res.data) {
    if (!timeLeft()) break
    if (r.wxCheckedAt && now - r.wxCheckedAt < 10 * 60 * 1000) continue // 處理中的每 10 分鐘查一次
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
  const res = await db.collection('order_items')
    .where({ kind: 'product', fixedDate: true, codeActive: true, activityDate: _.lt(today) })
    .limit(50).get()
  for (const it of res.data) {
    if (!timeLeft()) break
    if (it.refunding) continue // 有退款在處理，下一輪再看
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
  if (d.getUTCHours() === 3 && d.getUTCMinutes() < 10) tasks.push(['purgePhones', () => purgePhones(now)])
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
