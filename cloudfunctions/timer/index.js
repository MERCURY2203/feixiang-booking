// 定時任務（每分鐘由雲函數定時觸發器執行）
// 1. 到期的待支付訂單：查單 → 關單 → 放出場地
// 2. 定時對帳：最近關閉／取消的訂單再向微信查一次，有收款就全額退款（三道防線第 3 道）
// 3. 打完的場地卡片標為「已使用」，更新訂單狀態
// 4. 固定日期活動過期：未使用張數自動全額退款
// 5. 每天凌晨 3 點：最後一次訂場超過 1 年的客人，自動刪除手機號
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const u = require('./lib/util')
const pay = require('./lib/pay')
const ord = require('./lib/orders')

async function settleExpired(now) {
  const res = await db.collection('orders').where({ status: 'pending', expiresAt: _.lt(now) }).limit(100).get()
  for (const o of res.data) await ord.settle(cloud, db, o)
  return res.data.length
}

async function reconcile(now) {
  const res = await db.collection('orders')
    .where({ status: _.in(['closed', 'cancelled']), reconciled: _.neq(true), createdAt: _.gt(now - 2 * u.HOUR) })
    .limit(100).get()
  for (const o of res.data) {
    try {
      // 客人提前取消的訂單：滿 5 分鐘後向微信正式關單
      if (o.status === 'cancelled' && !o.wxClosed && now - o.createdAt >= 5 * 60 * 1000) {
        await pay.closeOrder(cloud, o).catch(() => {})
        await db.collection('orders').doc(o._id).update({ data: { wxClosed: true } })
      }
      const q = await pay.queryOrder(cloud, o)
      if (q.paid) {
        await ord.markPaid(cloud, db, o, q.payTime)
        continue
      }
      if (now - o.createdAt > 30 * 60 * 1000) await db.collection('orders').doc(o._id).update({ data: { reconciled: true } })
    } catch (e) {
      console.error('reconcile', o._id, e)
    }
  }
}

async function finishCourts(now) {
  const res = await db.collection('order_items')
    .where({ kind: 'court', status: 'active', startAt: _.lte(now - u.HOUR) })
    .limit(500).get()
  if (!res.data.length) return
  await db.collection('order_items').where({ _id: _.in(res.data.map(i => i._id)) }).update({ data: { status: 'used' } })
  for (const orderId of [...new Set(res.data.map(i => i.orderId))]) await ord.refreshStatus(db, orderId)
}

async function expireProducts(now) {
  const today = u.dateStr(now)
  const res = await db.collection('order_items')
    .where({ kind: 'product', fixedDate: true, codeActive: true, activityDate: _.lt(today) })
    .limit(50).get()
  for (const it of res.data) {
    const available = ord.productAvailable(it)
    if (available <= 0) {
      await db.collection('order_items').doc(it._id).update({ data: { codeActive: false } })
      continue
    }
    try {
      const order = (await db.collection('orders').doc(it.orderId).get()).data
      const amount = Math.min(available * it.price, ord.itemRefundable(it))
      await ord.refundItems(cloud, db, { order, parts: [{ itemId: it._id, qty: available, amount }], operatorId: '', by: 'system', reason: '活动过期未使用' })
      // 這部分張數記為「已過期」而不是「已退款」
      await db.collection('order_items').doc(it._id).update({
        data: { refundedQty: _.inc(-available), expiredQty: _.inc(available), codeActive: false }
      })
      await ord.refreshStatus(db, it.orderId)
    } catch (e) {
      console.error('expireProducts', it._id, e)
    }
  }
}

async function purgePhones(now) {
  const yearAgo = now - 365 * u.DAY
  await db.collection('users')
    .where(_.and([{ phone: _.neq('') }, _.or([{ lastBookedAt: _.lt(yearAgo) }, { lastBookedAt: _.exists(false), phoneBoundAt: _.lt(yearAgo) }]), { role: 'customer' }]))
    .update({ data: { phone: '', phonePurgedAt: now } })
}

exports.main = async () => {
  const now = Date.now()
  const tasks = [
    ['settleExpired', () => settleExpired(now)],
    ['reconcile', () => reconcile(now)],
    ['finishCourts', () => finishCourts(now)],
    ['expireProducts', () => expireProducts(now)]
  ]
  const d = new Date(now + 8 * u.HOUR)
  if (d.getUTCHours() === 3 && d.getUTCMinutes() === 0) tasks.push(['purgePhones', () => purgePhones(now)])
  for (const [name, fn] of tasks) {
    try {
      await fn()
    } catch (e) {
      console.error(name, e)
    }
  }
  return { ok: true }
}
