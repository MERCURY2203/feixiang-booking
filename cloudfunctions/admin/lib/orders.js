// 訂單核心邏輯：付款確認、到期關單、逾期退款、卡片退款、狀態計算、通知
// 對應：立項書「訂單關閉的定義」「超時付款的處理」、技術方案「關鍵機制 2–4」
const https = require('https')
const u = require('./util')
const pay = require('./pay')

const FINAL = ['cancelled', 'closed', 'timeout_refunded']
const MAX_REFUNDS = 50

// ---------- 通知：企業微信群機器人 + 管理端紅點 ----------

function postJson(url, body) {
  return new Promise(resolve => {
    try {
      const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, res => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', resolve)
      req.on('timeout', () => req.destroy())
      req.end(JSON.stringify(body))
    } catch (e) {
      resolve()
    }
  })
}

async function notify(db, type, text, orderId) {
  await db.collection('notices').add({ data: { type, text, orderId: orderId || '', at: Date.now() } })
  const hook = process.env.WECOM_WEBHOOK
  if (hook) await postJson(hook, { msgtype: 'text', text: { content: text } })
}

// 客人「超時已退款」訂閱消息（模板字段名以小程序後台模板為準，見部署說明）
async function sendTimeoutRefundMsg(cloud, order) {
  const tpl = process.env.TPL_TIMEOUT_REFUND
  if (!tpl || !order.openid) return
  const [kText = 'thing1', kAmount = 'amount2'] = (process.env.TPL_TIMEOUT_REFUND_FIELDS || '').split(',').filter(Boolean)
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: order.openid,
      templateId: tpl,
      page: `pages/order/detail/index?id=${order._id}`,
      data: { [kText]: { value: '订单已超时，款项已退回' }, [kAmount]: { value: u.formatFen(order.totalFee) } }
    })
  } catch (e) {
    console.error('subscribeMessage', e)
  }
}

// ---------- 讀取 ----------

async function getItems(db, orderId) {
  const res = await db.collection('order_items').where({ orderId }).limit(1000).get()
  return res.data
}

function itemRefundable(item) {
  return item.price * item.qty - (item.refundedFee || 0)
}

function productAvailable(item) {
  return item.qty - (item.verifiedQty || 0) - (item.refundedQty || 0) - (item.expiredQty || 0)
}

function courtFullyRefunded(item) {
  return (item.refundedFee || 0) >= item.price
}

// ---------- 狀態計算 ----------

function computeStatus(order, items, now) {
  if (order.status === 'pending' || FINAL.includes(order.status)) return order.status
  const allRefunded = items.every(i => (i.kind === 'court' ? courtFullyRefunded(i) : (i.refundedQty || 0) >= i.qty))
  if (allRefunded) return 'refunded'
  const done = items.every(i =>
    i.kind === 'court' ? courtFullyRefunded(i) || i.startAt + u.HOUR <= now : productAvailable(i) <= 0
  )
  return done ? 'completed' : 'active'
}

async function refreshStatus(db, orderId) {
  const order = (await db.collection('orders').doc(orderId).get()).data
  const items = await getItems(db, orderId)
  const status = computeStatus(order, items, Date.now())
  if (status !== order.status) await db.collection('orders').doc(orderId).update({ data: { status } })
  return { ...order, status }
}

// ---------- 釋放佔用（關單、取消時） ----------

async function releaseHolds(db, order, items) {
  const _ = db.command
  for (const it of items) {
    if (it.kind === 'court') {
      const id = u.slotId(it.date, it.court, it.hour)
      await db.collection('slot_locks').where({ _id: id, orderId: order._id }).remove()
    } else {
      await db.collection('products').doc(it.productId).update({ data: { stock: _.inc(it.qty) } }).catch(() => {})
    }
  }
}

// ---------- 付款成功 ----------

async function markPaid(cloud, db, order, payTime) {
  if (order.status === 'pending' && payTime && payTime <= order.expiresAt) {
    const items = await getItems(db, order._id)
    await db.collection('orders').doc(order._id).update({ data: { status: 'active', payTime } })
    for (const it of items) {
      if (it.kind === 'court') {
        await db.collection('slot_locks').doc(u.slotId(it.date, it.court, it.hour)).update({ data: { status: 'booked' } })
      }
    }
    await db.collection('order_items').where({ orderId: order._id }).update({ data: { status: 'active' } })
    await db.collection('users').doc(order.userId).update({ data: { lastBookedAt: payTime } }).catch(() => {})
    const summary = items
      .map(i => (i.kind === 'court' ? `${u.cnDate(i.date)} ${u.hourRange(i.hour)} ${i.court}号场` : `${i.name} ×${i.qty}`))
      .join('；')
    await notify(db, 'order', `【新订单】${u.formatFen(order.totalFee)}\n${summary}\n客人：${u.maskPhone(order.phone)}\n订单号：${order._id}`, order._id)
    return { ...order, status: 'active', payTime }
  }
  if (order.status === 'active' || order.status === 'completed' || order.status === 'refunded') return order
  // 逾期付款或訂單已關閉／取消後仍收到錢：一律全額退款
  return timeoutRefund(cloud, db, order, payTime)
}

async function timeoutRefund(cloud, db, order, payTime) {
  if (order.status === 'timeout_refunded') return order
  const outRefundNo = `${order._id}T`
  await db.collection('refunds').doc(outRefundNo).set({
    data: { orderId: order._id, amount: order.totalFee, reason: '超时付款自动退款', by: 'system', operatorId: '', status: 'processing', at: Date.now() }
  })
  await pay.refund(cloud, order, outRefundNo, order.totalFee)
  await db.collection('refunds').doc(outRefundNo).update({ data: { status: 'success' } })
  if (order.status === 'pending') {
    // 尚未釋放的佔用一併釋放
    await releaseHolds(db, order, await getItems(db, order._id))
  }
  await db.collection('orders').doc(order._id).update({
    data: { status: 'timeout_refunded', payTime: payTime || 0, refundedFee: order.totalFee, refundCount: (order.refundCount || 0) + 1 }
  })
  await notify(db, 'refund', `【超时付款自动退款】${u.formatFen(order.totalFee)}\n订单号：${order._id}`, order._id)
  await sendTimeoutRefundMsg(cloud, order)
  return { ...order, status: 'timeout_refunded' }
}

// ---------- 到期處理：查單 → 關單 → 放出場地 ----------
// 返回最新訂單；聯絡不上微信時保持 pending 並帶 confirming 標記，場地繼續鎖住
async function settle(cloud, db, order) {
  if (order.status !== 'pending' || Date.now() < order.expiresAt) return order
  try {
    const q = await pay.queryOrder(cloud, order)
    if (q.paid) return await markPaid(cloud, db, order, q.payTime)
    const closed = await pay.closeOrder(cloud, order)
    if (!closed) return { ...order, confirming: true }
    // 關單後再查一次，防止關單前一瞬間付款成功
    const again = await pay.queryOrder(cloud, order)
    if (again.paid) return await markPaid(cloud, db, order, again.payTime)
    const items = await getItems(db, order._id)
    await releaseHolds(db, order, items)
    await db.collection('orders').doc(order._id).update({ data: { status: 'closed', closedAt: Date.now() } })
    return { ...order, status: 'closed' }
  } catch (e) {
    console.error('settle', order._id, e)
    return { ...order, confirming: true }
  }
}

// 待支付期間客人主動取消（訂單未滿 5 分鐘無法向微信關單，以下單時設定的有效期和三道防線兜底）
async function cancelPending(cloud, db, order) {
  if (order.status !== 'pending') return order
  const q = await pay.queryOrder(cloud, order).catch(() => ({ paid: false }))
  if (q.paid) return markPaid(cloud, db, order, q.payTime)
  const items = await getItems(db, order._id)
  await releaseHolds(db, order, items)
  await db.collection('orders').doc(order._id).update({ data: { status: 'cancelled', cancelledAt: Date.now() } })
  return { ...order, status: 'cancelled' }
}

// ---------- 卡片退款（客人自退、管理端退、系統過期退） ----------
// parts: [{ itemId, qty, amount }]；qty 為商品退的張數（場地填 1 或 0），amount 為退款金額（分）
async function refundItems(cloud, db, { order, parts, operatorId, by, reason }) {
  if (!['active', 'completed'].includes(order.status)) throw new Error('该订单当前不能退款')
  if ((order.refundCount || 0) >= MAX_REFUNDS) throw new Error('此订单已达微信退款次数上限，请联系球馆')
  const outRefundNo = `${order._id}R${String((order.refundCount || 0) + 1).padStart(2, '0')}${u.randomDigits(3)}`
  let total = 0
  const locked = []

  // 1. 逐張卡片上鎖並檢查可退金額／張數，保證兩人同時退只退一次
  try {
    for (const p of parts) {
      const ok = await db.runTransaction(async t => {
        const it = (await t.collection('order_items').doc(p.itemId).get()).data
        if (!it || it.orderId !== order._id) return '退款项目不存在'
        if (it.refunding) return '该项正在退款中'
        const amount = Math.round(p.amount)
        if (amount <= 0) return '退款金额必须大于 0'
        if (amount > itemRefundable(it)) return '该项已退款或超出可退金额'
        if (it.kind === 'product' && (p.qty || 0) > productAvailable(it)) return '可退张数不足'
        await t.collection('order_items').doc(p.itemId).update({ data: { refunding: outRefundNo } })
        return null
      })
      if (ok) throw new Error(ok)
      locked.push(p.itemId)
      total += Math.round(p.amount)
    }

    // 2. 向微信申請退款
    await db.collection('refunds').doc(outRefundNo).set({
      data: { orderId: order._id, amount: total, parts, reason: reason || '', by, operatorId: operatorId || '', status: 'processing', at: Date.now() }
    })
    await pay.refund(cloud, order, outRefundNo, total)
  } catch (e) {
    for (const id of locked) await db.collection('order_items').doc(id).update({ data: { refunding: '' } })
    if (locked.length === parts.length) {
      await db.collection('refunds').doc(outRefundNo).update({ data: { status: 'failed', error: e.message } }).catch(() => {})
    }
    throw e
  }

  // 3. 更新卡片、釋放場地、退回庫存
  const _ = db.command
  for (const p of parts) {
    const it = (await db.collection('order_items').doc(p.itemId).get()).data
    const data = { refunding: '', refundedFee: (it.refundedFee || 0) + Math.round(p.amount) }
    if (it.kind === 'court') {
      if (data.refundedFee >= it.price) {
        data.status = 'refunded'
        await db.collection('slot_locks').where({ _id: u.slotId(it.date, it.court, it.hour), orderId: order._id }).remove()
      }
    } else if (p.qty > 0) {
      data.refundedQty = (it.refundedQty || 0) + p.qty
      if (it.qty - (it.verifiedQty || 0) - data.refundedQty - (it.expiredQty || 0) <= 0) data.codeActive = false
      await db.collection('products').doc(it.productId).update({ data: { stock: _.inc(p.qty) } }).catch(() => {})
    }
    await db.collection('order_items').doc(p.itemId).update({ data })
  }
  await db.collection('refunds').doc(outRefundNo).update({ data: { status: 'success' } })
  await db.collection('orders').doc(order._id).update({ data: { refundedFee: _.inc(total), refundCount: _.inc(1) } })
  const updated = await refreshStatus(db, order._id)

  const who = by === 'customer' ? '客人自行退款' : by === 'system' ? '系统自动退款' : '管理端退款'
  await notify(db, 'refund', `【${who}】${u.formatFen(total)}${reason ? `（${reason}）` : ''}\n客人：${u.maskPhone(order.phone)}\n订单号：${order._id}`, order._id)
  return { order: updated, amount: total, outRefundNo }
}

module.exports = {
  FINAL, MAX_REFUNDS, notify, getItems, itemRefundable, productAvailable, courtFullyRefunded,
  computeStatus, refreshStatus, releaseHolds, markPaid, timeoutRefund, settle, cancelPending, refundItems
}
