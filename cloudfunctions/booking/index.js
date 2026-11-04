// 客人端雲函數：訂場表格、購物車報價、下單、付款、取消、我的訂單、自助退款、活動商品、橫幅
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const QRCode = require('qrcode')
const db = cloud.database()
const _ = db.command
const u = require('./lib/util')
const cal = require('./lib/calendar')
const pay = require('./lib/pay')
const ord = require('./lib/orders')
const { getCaller } = require('./lib/auth')

const PENDING_MS = 5 * 60 * 1000 // 待支付 5 分鐘
const CANCEL_BEFORE = 15 * 60 * 1000 // 開場前 15 分鐘
const REFUND_WARN = 45 // 已退 45 次起提示聯絡球館

// ---------- 橫幅 ----------

async function activeBanners(now) {
  const res = await db.collection('banners').where({ enabled: true }).orderBy('sort', 'asc').limit(20).get()
  const list = res.data.filter(b => b.mode !== 'timed' || (b.startAt <= now && now < b.endAt))
  return list.slice(0, 5).map(b => ({ _id: b._id, image: b.image, target: b.target || { type: 'none' } }))
}

// ---------- 訂場表格 ----------

async function schedule(date) {
  const now = Date.now()
  const cfg = await cal.loadConfig(db)
  const days = cal.bookableDays(cfg, now)
  if (!days.includes(date)) date = days[0]
  const result = {
    serverNow: now,
    days: days.map(d => ({ date: d, label: u.dateLabel(d) })),
    date,
    courts: u.COURTS,
    hours: [],
    cells: []
  }
  if (!date) return result
  const h = cal.hoursFor(cfg, date)
  const locks = await db.collection('slot_locks').where({ date }).limit(1000).get()
  const lockMap = Object.fromEntries(locks.data.map(l => [l._id, l]))
  for (let hour = h.open; hour < h.close; hour++) {
    result.hours.push({ hour, label: `${u.pad(hour)}:00` })
    const row = []
    for (const court of u.COURTS) {
      const past = u.slotStart(date, hour) <= now
      const lock = lockMap[u.slotId(date, court, hour)]
      const busy = lock && !(lock.status === 'pending' && lock.expiresAt < now)
      const { price } = cal.priceFor(cfg, date, court, hour)
      row.push({ s: past ? 'past' : busy ? 'taken' : 'free', p: price })
    }
    result.cells.push(row)
  }
  return result
}

// ---------- 購物車報價：檢查每項是否仍有效、取得最新價格 ----------

async function quote(items) {
  const now = Date.now()
  const cfg = await cal.loadConfig(db)
  const days = cal.bookableDays(cfg, now)
  const courtItems = items.filter(i => i.type === 'court')
  const productIds = [...new Set(items.filter(i => i.type === 'product').map(i => i.productId))]

  const lockIds = courtItems.map(i => u.slotId(i.date, i.court, i.hour))
  const locks = {}
  for (let i = 0; i < lockIds.length; i += 100) {
    const res = await db.collection('slot_locks').where({ _id: _.in(lockIds.slice(i, i + 100)) }).get()
    res.data.forEach(l => (locks[l._id] = l))
  }
  const products = {}
  if (productIds.length) {
    const res = await db.collection('products').where({ _id: _.in(productIds) }).get()
    res.data.forEach(p => (products[p._id] = p))
  }

  return items.map(i => {
    if (i.type === 'court') {
      const h = cal.hoursFor(cfg, i.date)
      const base = { ...i, label: `${u.dateLabel(i.date)} ${i.court}号场 ${u.hourRange(i.hour)}`, qty: 1 }
      if (!days.includes(i.date) || !h || i.hour < h.open || i.hour >= h.close || u.slotStart(i.date, i.hour) <= now) {
        return { ...base, valid: false, reason: '已过期', price: 0 }
      }
      const lock = locks[u.slotId(i.date, i.court, i.hour)]
      const price = cal.priceFor(cfg, i.date, i.court, i.hour).price
      if (lock && !(lock.status === 'pending' && lock.expiresAt < now)) return { ...base, valid: false, reason: '已被预订', price }
      return { ...base, valid: true, price }
    }
    const p = products[i.productId]
    const qty = Math.max(1, Math.floor(i.qty || 1))
    if (!p) return { ...i, qty, valid: false, reason: '已下架', price: 0, label: '商品已删除' }
    const base = { ...i, qty, label: p.name, price: p.price, image: (p.images || [])[0] || '', stock: p.stock }
    if (!p.onShelf) return { ...base, valid: false, reason: '已下架' }
    if (p.fixedDate && p.activityStartAt <= now) return { ...base, valid: false, reason: '活动已开始' }
    if (p.stock < qty) return { ...base, valid: false, reason: p.stock > 0 ? `库存仅剩 ${p.stock}` : '已售罄' }
    return { ...base, valid: true }
  })
}

// ---------- 下單 ----------

async function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = u.randomDigits(6)
    const res = await db.collection('order_items').where({ code, codeActive: true }).count()
    if (!res.total) return code
  }
  throw new Error('生成券码失败')
}

async function checkout(user, rawItems) {
  if (!user.phone) return u.fail('必须授权手机号才可下单购买哦', 'NEED_PHONE')
  if (!Array.isArray(rawItems) || !rawItems.length) return u.fail('购物车是空的')

  // 同一客人同時只能有一張待支付訂單（澄清 C1）
  const pend = await db.collection('orders').where({ userId: user._id, status: 'pending' }).get()
  for (const o of pend.data) {
    const s = await ord.settle(cloud, db, o)
    if (s.status === 'pending') return u.fail('你有一笔待支付订单', 'HAS_PENDING', { orderId: o._id })
  }

  // 去重
  const seen = new Set()
  const items = []
  for (const i of rawItems) {
    const key = i.type === 'court' ? `c_${i.date}_${i.court}_${i.hour}` : `p_${i.productId}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(i.type === 'court' ? { type: 'court', date: i.date, court: +i.court, hour: +i.hour } : { type: 'product', productId: i.productId, qty: +i.qty || 1 })
  }

  let q = await quote(items)
  // 已過期的待支付佔用：先向微信查單並關單，確認沒付款才能交給新客人
  const now = Date.now()
  const stale = await db.collection('slot_locks').where({
    _id: _.in(items.filter(i => i.type === 'court').map(i => u.slotId(i.date, i.court, i.hour)).slice(0, 100)),
    status: 'pending',
    expiresAt: _.lt(now)
  }).get()
  if (stale.data.length) {
    for (const orderId of [...new Set(stale.data.map(l => l.orderId))]) {
      const o = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
      if (o) await ord.settle(cloud, db, o)
      else await db.collection('slot_locks').where({ orderId }).remove()
    }
    q = await quote(items)
  }
  const invalid = q.filter(i => !i.valid)
  if (invalid.length) return u.fail(invalid[0].reason === '已被预订' ? '部分场次已被预订' : '部分商品不可购买', 'INVALID_ITEMS', { invalid })

  const created = Date.now()
  const order = {
    _id: u.newId('FX'),
    userId: user._id,
    openid: user.openid,
    phone: user.phone,
    status: 'pending',
    totalFee: q.reduce((s, i) => s + i.price * i.qty, 0),
    createdAt: created,
    expiresAt: created + PENDING_MS,
    hasCourt: q.some(i => i.type === 'court'),
    refundedFee: 0,
    refundCount: 0,
    summary: q.map(i => (i.type === 'court' ? `${u.cnDate(i.date)} ${u.hourRange(i.hour)} ${i.court}号场` : `${i.label} ×${i.qty}`)).join('；')
  }
  if (order.totalFee <= 0) return u.fail('订单金额有误')

  const productDocs = {}
  for (const i of q.filter(x => x.type === 'product')) {
    productDocs[i.productId] = (await db.collection('products').doc(i.productId).get()).data
  }
  const itemDocs = []
  for (const i of q) {
    if (i.type === 'court') {
      itemDocs.push({
        _id: `${order._id}_${itemDocs.length + 1}`, orderId: order._id, userId: user._id, kind: 'court',
        date: i.date, court: i.court, hour: i.hour, startAt: u.slotStart(i.date, i.hour),
        price: i.price, qty: 1, refundedFee: 0, status: 'pending'
      })
    } else {
      const p = productDocs[i.productId]
      itemDocs.push({
        _id: `${order._id}_${itemDocs.length + 1}`, orderId: order._id, userId: user._id, kind: 'product',
        productId: p._id, name: p.name, image: (p.images || [])[0] || '', price: p.price, qty: i.qty,
        fixedDate: !!p.fixedDate, activityDate: p.activityDate || '', activityStartAt: p.activityStartAt || 0,
        verifiedQty: 0, refundedQty: 0, expiredQty: 0, refundedFee: 0, status: 'pending',
        code: await uniqueCode(), codeActive: true
      })
    }
  }

  // 事務：所有格子「申請車位牌」+ 扣庫存，有一項不成立就整單不成立（技術方案「關鍵機制 1」）
  try {
    await db.runTransaction(async t => {
      const conflicts = []
      for (const it of itemDocs.filter(x => x.kind === 'court')) {
        const id = u.slotId(it.date, it.court, it.hour)
        let exists = null
        try {
          exists = (await t.collection('slot_locks').doc(id).get()).data
        } catch (e) {
          exists = null
        }
        if (exists) conflicts.push(id)
      }
      for (const it of itemDocs.filter(x => x.kind === 'product')) {
        const p = (await t.collection('products').doc(it.productId).get()).data
        if (!p.onShelf || p.stock < it.qty) conflicts.push(it.productId)
      }
      if (conflicts.length) return t.rollback({ conflicts })

      for (const it of itemDocs) {
        if (it.kind === 'court') {
          await t.collection('slot_locks').doc(u.slotId(it.date, it.court, it.hour)).set({
            data: { date: it.date, court: it.court, hour: it.hour, status: 'pending', orderId: order._id, expiresAt: order.expiresAt }
          })
        } else {
          await t.collection('products').doc(it.productId).update({ data: { stock: _.inc(-it.qty), soldCount: _.inc(it.qty) } })
        }
        await t.collection('order_items').doc(it._id).set({ data: it })
      }
      await t.collection('orders').doc(order._id).set({ data: order })
    })
  } catch (e) {
    if (e && e.conflicts) return u.fail('部分场次已被预订', 'INVALID_ITEMS', { invalid: [] })
    console.error('checkout tx', e)
    return u.fail('下单失败，请重试')
  }

  // 向微信支付下單（有效期 5 分鐘）
  let payment
  try {
    payment = await pay.unifiedOrder(cloud, order, `飞翔球馆-${order.hasCourt ? '订场' : '活动'}`)
    await db.collection('orders').doc(order._id).update({ data: { payment } })
  } catch (e) {
    console.error('unifiedOrder', e)
    await ord.releaseHolds(db, order, itemDocs)
    await db.collection('orders').doc(order._id).update({ data: { status: 'cancelled', cancelledAt: Date.now() } })
    return u.fail('发起支付失败，请重试')
  }
  return u.ok({ orderId: order._id, payment, mock: pay.MOCK, expiresAt: order.expiresAt, serverNow: Date.now() })
}

// ---------- 訂單展示 ----------

function itemView(order, it, now, admin) {
  const v = { _id: it._id, kind: it.kind, price: it.price, qty: it.qty, refundedFee: it.refundedFee || 0 }
  const tooManyRefunds = (order.refundCount || 0) >= REFUND_WARN
  const paidish = ['active', 'completed'].includes(order.status)
  if (it.kind === 'court') {
    v.title = `${u.cnDate(it.date)} ${u.hourRange(it.hour)} ${it.court}号场`
    const refunded = ord.courtFullyRefunded(it)
    v.state = refunded ? '已退款' : !paidish ? '' : it.startAt + u.HOUR <= now ? '已使用' : it.startAt <= now ? '进行中' : '待使用'
    v.refundable = ord.itemRefundable(it)
    v.canRefund = paidish && !refunded && it.startAt - CANCEL_BEFORE > now && !it.refunding
    v.refundHint = refunded ? '已退款' : paidish && it.startAt - CANCEL_BEFORE <= now ? '已过可退时间' : ''
  } else {
    v.title = `${it.name} ×${it.qty}`
    v.image = it.image
    v.available = ord.productAvailable(it)
    const parts = []
    if (v.available > 0) parts.push(`未使用 ${v.available}`)
    if (it.verifiedQty) parts.push(`已核销 ${it.verifiedQty}`)
    if (it.refundedQty) parts.push(`已退款 ${it.refundedQty}`)
    if (it.expiredQty) parts.push(`已过期 ${it.expiredQty}`)
    v.state = paidish ? parts.join(' · ') : ''
    v.refundable = ord.itemRefundable(it)
    const tooLate = it.fixedDate && it.activityStartAt - CANCEL_BEFORE <= now
    v.canRefund = paidish && v.available > 0 && !tooLate && !it.refunding
    v.refundHint = v.available <= 0 ? '' : paidish && tooLate ? '已过可退时间' : ''
    v.hasCode = paidish && !!it.codeActive && v.available > 0
    if (it.fixedDate) v.note = `活动时间：${u.cnDate(it.activityDate)} ${u.pad(new Date(it.activityStartAt + 8 * u.HOUR).getUTCHours())}:${u.pad(new Date(it.activityStartAt + 8 * u.HOUR).getUTCMinutes())}`
  }
  if (!admin && tooManyRefunds && v.canRefund) {
    v.canRefund = false
    v.refundHint = '请联系球馆退款'
  }
  return v
}

const STATUS_TEXT = {
  pending: '待支付', cancelled: '已取消', closed: '已关闭', active: '待使用',
  completed: '已完成', refunded: '已退款', timeout_refunded: '超时已退款'
}

function statusText(order) {
  if ((order.status === 'active' || order.status === 'completed') && order.refundedFee > 0) {
    return `${STATUS_TEXT[order.status]} · 部分退款`
  }
  return STATUS_TEXT[order.status] || order.status
}

function orderView(order) {
  return {
    _id: order._id, status: order.status, statusText: statusText(order), totalFee: order.totalFee,
    refundedFee: order.refundedFee || 0, createdAt: order.createdAt, expiresAt: order.expiresAt,
    summary: order.summary, confirming: !!order.confirming
  }
}

async function myOrders(user, tab, skip) {
  const where = { userId: user._id }
  if (tab === 'pending') where.status = 'pending'
  if (tab === 'active') where.status = 'active'
  if (tab === 'completed') where.status = 'completed'
  if (tab === 'refund') where.refundedFee = _.gt(0)
  const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').skip(skip || 0).limit(20).get()
  const list = []
  for (let o of res.data) {
    if (o.status === 'pending' && o.expiresAt < Date.now()) o = await ord.settle(cloud, db, o)
    if (tab === 'pending' && o.status !== 'pending') continue
    list.push(orderView(o))
  }
  return { list, serverNow: Date.now(), more: res.data.length === 20 }
}

async function loadOwnOrder(user, orderId) {
  const o = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!o || o.userId !== user._id) return null
  return o
}

async function orderDetail(user, orderId) {
  let order = await loadOwnOrder(user, orderId)
  if (!order) return u.fail('订单不存在')
  if (order.status === 'pending') order = await ord.settle(cloud, db, order)
  else if (order.status === 'active') order = await ord.refreshStatus(db, order._id)
  const items = (await ord.getItems(db, orderId)).sort((a, b) => (a._id < b._id ? -1 : 1))
  const now = Date.now()
  return u.ok({
    order: orderView(order),
    items: items.map(it => itemView(order, it, now, false)),
    hasCourt: order.hasCourt,
    serverNow: now
  })
}

// ---------- 入口 ----------

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return u.fail('请在小程序内使用', 'NO_OPENID')

  try {
    // 不需登入的瀏覽
    switch (event.action) {
      case 'schedule':
        return u.ok({ ...(await schedule(event.date)), banners: event.withBanners ? await activeBanners(Date.now()) : undefined })
      case 'banners':
        return u.ok(await activeBanners(Date.now()))
      case 'quote':
        return u.ok(await quote(Array.isArray(event.items) ? event.items.slice(0, 200) : []))
      case 'products': {
        const res = await db.collection('products').where({ onShelf: true }).orderBy('sort', 'asc').orderBy('createdAt', 'desc').limit(100).get()
        const now = Date.now()
        return u.ok(
          res.data
            .filter(p => !p.fixedDate || p.activityStartAt > now)
            .map(p => ({ _id: p._id, name: p.name, image: (p.images || [])[0] || '', price: p.price, stock: p.stock }))
        )
      }
      case 'product': {
        const p = (await db.collection('products').doc(event.id).get().catch(() => ({ data: null }))).data
        if (!p || !p.onShelf) return u.fail('商品已下架', 'OFF_SHELF')
        const v = { _id: p._id, name: p.name, images: p.images || [], price: p.price, stock: p.stock, desc: p.desc || '', fixedDate: !!p.fixedDate }
        if (p.fixedDate) {
          const d = new Date(p.activityStartAt + 8 * u.HOUR)
          v.validity = `活动时间：${u.cnDate(p.activityDate)} ${u.pad(d.getUTCHours())}:${u.pad(d.getUTCMinutes())}`
        } else v.validity = '长期有效'
        return u.ok(v)
      }
    }

    const user = await getCaller(db, OPENID)
    if (!user) return u.fail('请重新打开小程序')

    switch (event.action) {
      case 'checkout':
        return await checkout(user, event.items)

      case 'orderStatus': {
        let o = await loadOwnOrder(user, event.orderId)
        if (!o) return u.fail('订单不存在')
        if (o.status === 'pending') o = await ord.settle(cloud, db, o)
        if (o.status === 'pending' && event.check && !pay.MOCK) {
          // 付款後客人端主動查單，不必等微信通知
          const q = await pay.queryOrder(cloud, o).catch(() => ({ paid: false }))
          if (q.paid) o = await ord.markPaid(cloud, db, o, q.payTime)
        }
        return u.ok({ ...orderView(o), serverNow: Date.now() })
      }

      case 'pendingDetail': {
        let o = await loadOwnOrder(user, event.orderId)
        if (!o) return u.fail('订单不存在')
        if (o.status === 'pending') o = await ord.settle(cloud, db, o)
        const items = (await ord.getItems(db, o._id)).sort((a, b) => (a._id < b._id ? -1 : 1))
        return u.ok({
          order: orderView(o),
          items: items.map(it => ({ title: it.kind === 'court' ? `${u.cnDate(it.date)} ${u.hourRange(it.hour)} ${it.court}号场` : `${it.name} ×${it.qty}`, amount: it.price * it.qty })),
          serverNow: Date.now()
        })
      }

      case 'repay': {
        const o = await loadOwnOrder(user, event.orderId)
        if (!o || o.status !== 'pending' || o.expiresAt <= Date.now()) return u.fail('订单已关闭', 'CLOSED')
        return u.ok({ orderId: o._id, payment: o.payment, mock: pay.MOCK, expiresAt: o.expiresAt })
      }

      case 'mockPay': {
        if (!pay.MOCK) return u.fail('无权限', 'FORBIDDEN')
        const o = await loadOwnOrder(user, event.orderId)
        if (!o) return u.fail('订单不存在')
        const paidAt = Date.now()
        await db.collection('orders').doc(o._id).update({ data: { mockPaidAt: paidAt } })
        const r = await ord.markPaid(cloud, db, { ...o, mockPaidAt: paidAt }, paidAt)
        return u.ok(orderView(r))
      }

      case 'cancel': {
        const o = await loadOwnOrder(user, event.orderId)
        if (!o) return u.fail('订单不存在')
        const r = await ord.cancelPending(cloud, db, o)
        return u.ok(orderView(r))
      }

      case 'myOrders':
        return u.ok(await myOrders(user, event.tab, event.skip))

      case 'orderDetail':
        return await orderDetail(user, event.orderId)

      case 'refund': {
        const o = await loadOwnOrder(user, event.orderId)
        if (!o) return u.fail('订单不存在')
        if ((o.refundCount || 0) >= REFUND_WARN) return u.fail('请联系球馆退款')
        const it = (await db.collection('order_items').doc(event.itemId).get().catch(() => ({ data: null }))).data
        if (!it || it.orderId !== o._id) return u.fail('退款项目不存在')
        const view = itemView(o, it, Date.now(), false)
        if (!view.canRefund) return u.fail(view.refundHint || '该项不能退款')
        let qty = 1
        let amount = view.refundable
        if (it.kind === 'product') {
          qty = Math.max(1, Math.min(Math.floor(event.qty || 1), view.available))
          amount = Math.min(qty * it.price, view.refundable)
        }
        const r = await ord.refundItems(cloud, db, { order: o, parts: [{ itemId: it._id, qty, amount }], operatorId: user._id, by: 'customer', reason: '' })
        return u.ok({ amount: r.amount })
      }

      case 'couponQr': {
        const it = (await db.collection('order_items').doc(event.itemId).get().catch(() => ({ data: null }))).data
        if (!it || it.userId !== user._id || it.kind !== 'product') return u.fail('券码不存在')
        const available = ord.productAvailable(it)
        if (!it.codeActive || available <= 0) return u.fail('券码已失效')
        const qr = await QRCode.toDataURL(it.code, { width: 480, margin: 1 })
        return u.ok({ code: it.code, qr, available, name: it.name })
      }

      default:
        return u.fail('未知操作')
    }
  } catch (e) {
    console.error(e)
    return u.fail(e.message && /[一-龥]/.test(e.message) ? e.message : '操作失败，请稍后再试')
  }
}
