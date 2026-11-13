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

async function schedule(date, openid) {
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
  // 這位客人自己訂的（含待支付）：用佔用記錄的訂單號對上「我的」卡片，不洩露別人的任何資料
  const mine = {}
  const me = openid ? await getCaller(db, openid) : null
  if (me) {
    const mineItems = await db.collection('order_items').where({ userId: me._id, kind: 'court', date }).limit(200).get()
    for (const i of mineItems.data) mine[u.slotId(i.date, i.court, i.hour)] = i.orderId
  }
  for (let hour = h.open; hour < h.close; hour++) {
    result.hours.push({ hour, label: `${u.pad(hour)}:00` })
    const row = []
    for (const court of u.COURTS) {
      const past = u.slotStart(date, hour) <= now
      const lock = lockMap[u.slotId(date, court, hour)]
      const busy = lock && !(lock.status === 'pending' && lock.expiresAt < now)
      const { price } = cal.priceFor(cfg, date, court, hour)
      const isMine = busy && mine[u.slotId(date, court, hour)] === lock.orderId
      // mine＝我已付款訂到的；mypending＝我的待支付訂單佔著（顯示沙漏，免得誤以為被別人搶先）
      const s = isMine ? (lock.status === 'pending' ? 'mypending' : 'mine') : past ? 'past' : busy ? 'taken' : 'free'
      row.push({ s, p: price })
    }
    result.cells.push(row)
  }
  return result
}

// ---------- 購物車項目檢查：只接受合法的場地號、整點、日期和正整數數量 ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_QUOTE = 200 // 購物車報價一次最多 200 項
const MAX_CHECKOUT = 40 // 一張訂單最多 40 項（數據庫事務的操作上限）

function cleanItem(i) {
  if (!i || typeof i !== 'object') return null
  if (i.type === 'court') {
    const court = Number(i.court)
    const hour = Number(i.hour)
    if (typeof i.date !== 'string' || !DATE_RE.test(i.date)) return null
    if (!Number.isInteger(court) || !u.COURTS.includes(court)) return null
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
    return { type: 'court', date: i.date, court, hour }
  }
  if (i.type === 'product') {
    const qty = i.qty === undefined ? 1 : Number(i.qty)
    if (typeof i.productId !== 'string' || !i.productId || i.productId.length > 64) return null
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return null
    return { type: 'product', productId: i.productId, qty }
  }
  return null
}

async function loadByIds(coll, ids) {
  const map = {}
  for (let i = 0; i < ids.length; i += 100) {
    const res = await db.collection(coll).where({ _id: _.in(ids.slice(i, i + 100)) }).limit(100).get()
    res.data.forEach(d => (map[d._id] = d))
  }
  return map
}

// ---------- 購物車報價：檢查每項是否仍有效、取得最新價格 ----------

async function quote(rawItems) {
  const now = Date.now()
  const cfg = await cal.loadConfig(db)
  const days = cal.bookableDays(cfg, now)
  const items = rawItems.map(r => ({ raw: r, it: cleanItem(r) }))
  const courtItems = items.filter(x => x.it && x.it.type === 'court').map(x => x.it)
  const productIds = [...new Set(items.filter(x => x.it && x.it.type === 'product').map(x => x.it.productId))]
  const locks = await loadByIds('slot_locks', courtItems.map(i => u.slotId(i.date, i.court, i.hour)))
  const products = await loadByIds('products', productIds)

  return items.map(({ raw, it: i }) => {
    if (!i) return { ...(raw && typeof raw === 'object' ? raw : {}), qty: 1, valid: false, reason: '已失效', price: 0, label: '无效项目' }
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
    const qty = i.qty
    if (!p) return { ...i, qty, valid: false, reason: '已下架', price: 0, label: '商品已删除' }
    const base = { ...i, qty, label: p.name, price: p.price, image: (p.images || [])[0] || '', stock: p.stock }
    if (!p.onShelf) return { ...base, valid: false, reason: '已下架' }
    if (p.fixedDate && p.activityStartAt <= now) return { ...base, valid: false, reason: '活动已开始' }
    if (p.stock < qty) return { ...base, valid: false, reason: p.stock > 0 ? `库存仅剩 ${p.stock}` : '已售罄' }
    return { ...base, valid: true }
  })
}

// ---------- 下單 ----------

// 券碼：6 位數字，在事務裡用 coupon_codes/{券碼} 佔位保證不重複
function newCodes(n) {
  const set = new Set()
  while (set.size < n) set.add(u.randomDigits(6))
  return [...set]
}

async function checkout(user, rawItems, expectTotal) {
  if (!user.phone) return u.fail('必须授权手机号才可下单购买哦', 'NEED_PHONE')
  if (!Array.isArray(rawItems) || !rawItems.length) return u.fail('购物车是空的')

  // 檢查並去重
  const seen = new Set()
  const items = []
  for (const raw of rawItems) {
    const i = cleanItem(raw)
    if (!i) return u.fail('购物车里有无效项目，请刷新后重试', 'INVALID_ITEMS', { invalid: [] })
    const key = i.type === 'court' ? `c_${i.date}_${i.court}_${i.hour}` : `p_${i.productId}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(i)
  }
  if (items.length > MAX_CHECKOUT) return u.fail(`一次最多结算 ${MAX_CHECKOUT} 项，请分开下单`)

  // 同一客人同時只能有一張待支付訂單（澄清 C1）：先處理已到期的，事務裡再用 user_pending 確認
  const pend = await db.collection('orders').where({ userId: user._id, status: 'pending' }).limit(10).get()
  for (const o of pend.data) {
    const s = await ord.settle(cloud, db, o)
    if (s.status === 'pending') return u.fail('你有一笔待支付订单', 'HAS_PENDING', { orderId: o._id })
  }

  // 已過期的待支付佔用：先向微信查單並關單，確認沒付款才能交給新客人
  const now = Date.now()
  const lockIds = items.filter(i => i.type === 'court').map(i => u.slotId(i.date, i.court, i.hour))
  const locks = await loadByIds('slot_locks', lockIds)
  const staleOrders = [...new Set(Object.values(locks).filter(l => l.status === 'pending' && l.expiresAt < now).map(l => l.orderId))]
  for (const orderId of staleOrders) {
    const o = await ord.dget(db, 'orders', orderId)
    if (o) await ord.settle(cloud, db, o)
  }

  // 日期鎖（澄清 K2）：先記下各日「營業時間版本」，事務裡再確認沒變；改營業時間會把版本加一
  const courtDates = [...new Set(items.filter(i => i.type === 'court').map(i => i.date))]
  const dayLocks = await loadByIds('locks', courtDates.map(d => `day_${d}`))
  const hoursVer = {}
  for (const d of courtDates) hoursVer[d] = (dayLocks[`day_${d}`] && dayLocks[`day_${d}`].hoursVer) || 0

  const q = await quote(items)
  const invalid = q.filter(i => !i.valid)
  if (invalid.length) return u.fail(invalid[0].reason === '已被预订' ? '部分场次已被预订' : '部分商品不可购买', 'INVALID_ITEMS', { invalid })

  // 客人確認的合計和現在的報價不一致（確認期間改了價）：不下單，讓客人重新確認（澄清 B4）
  const quotedTotal = q.reduce((s, i) => s + i.price * i.qty, 0)
  if (Number.isFinite(expectTotal) && expectTotal !== quotedTotal) {
    return u.fail(`价格已变动，新合计 ${u.formatFen(quotedTotal)}，请重新确认`, 'PRICE_CHANGED', { total: quotedTotal })
  }

  const created = Date.now()
  const order = {
    _id: u.newId('FX', 8),
    userId: user._id,
    openid: user.openid,
    phone: user.phone,
    status: 'pending',
    totalFee: 0,
    createdAt: created,
    expiresAt: created + PENDING_MS,
    hasCourt: q.some(i => i.type === 'court'),
    refundedFee: 0,
    refundCount: 0,
    itemIds: [],
    lines: u.orderLines(q),
    summary: q.map(i => (i.type === 'court' ? `${u.cnDate(i.date)} ${u.hourRange(i.hour)} ${i.court}号场` : `${i.label} ×${i.qty}`)).join('；')
  }
  // 卡片價格取自同一次報價；訂單總額 = 卡片金額相加，保證兩者永遠一致
  const itemDocs = q.map((i, n) => {
    const _id = `${order._id}_${n + 1}`
    if (i.type === 'court') {
      return {
        _id, orderId: order._id, userId: user._id, kind: 'court',
        date: i.date, court: i.court, hour: i.hour, startAt: u.slotStart(i.date, i.hour),
        price: i.price, qty: 1, refundedFee: 0, status: 'pending'
      }
    }
    return {
      _id, orderId: order._id, userId: user._id, kind: 'product', productId: i.productId, name: i.label, image: i.image,
      price: i.price, qty: i.qty, verifiedQty: 0, refundedQty: 0, expiredQty: 0, refundedFee: 0, status: 'pending',
      code: '', codeActive: true
    }
  })
  order.itemIds = itemDocs.map(i => i._id)
  order.totalFee = itemDocs.reduce((s, i) => s + i.price * i.qty, 0)
  if (!(order.totalFee > 0)) return u.fail('订单金额有误')

  // 事務：待支付名額 + 所有格子「申請車位牌」+ 扣庫存 + 券碼佔位，有一項不成立就整單不成立（技術方案「關鍵機制 1」）
  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const products = itemDocs.filter(x => x.kind === 'product')
    const codes = newCodes(products.length)
    // 兼容舊數據：舊券碼沒有登記在 coupon_codes，下單前再查一次卡片表，撞到就換號（數據遷移後不會再發生）
    if (codes.length) {
      const legacy = await db.collection('order_items').where({ code: _.in(codes) }).count()
      if (legacy.total) {
        lastErr = new Error('券码冲突')
        continue
      }
    }
    products.forEach((it, n) => (it.code = codes[n]))
    try {
      await ord.tx(db, async t => {
        // ---- 先讀 ----
        // 訂單號已被用過（極少見的撞號）：整張換新號重來，絕不覆蓋別人的訂單（澄清 K1）
        if (await ord.tget(t, 'orders', order._id)) return ord.rollbackWith(t, 'ID_TAKEN', '订单号冲突')
        const days = {}
        for (const d of courtDates) {
          days[d] = await ord.tget(t, 'locks', `day_${d}`)
          if (((days[d] && days[d].hoursVer) || 0) !== hoursVer[d]) return ord.rollbackWith(t, 'INVALID_ITEMS', '营业时间已调整，请刷新后重试')
        }
        const claim = await ord.tget(t, 'user_pending', user._id)
        if (claim && claim.orderId) {
          const prev = await ord.tget(t, 'orders', claim.orderId)
          if (prev && prev.status === 'pending') return ord.rollbackWith(t, 'HAS_PENDING', '你有一笔待支付订单', { orderId: prev._id })
        }
        for (const it of itemDocs.filter(x => x.kind === 'court')) {
          if (await ord.tget(t, 'slot_locks', u.slotId(it.date, it.court, it.hour))) {
            return ord.rollbackWith(t, 'INVALID_ITEMS', '部分场次已被预订')
          }
        }
        const prodDocs = {}
        for (const it of products) {
          const p = await ord.tget(t, 'products', it.productId)
          if (!p || !p.onShelf || p.stock < it.qty || (p.fixedDate && p.activityStartAt <= Date.now())) {
            return ord.rollbackWith(t, 'INVALID_ITEMS', '部分商品不可购买')
          }
          if (p.price !== it.price) return ord.rollbackWith(t, 'INVALID_ITEMS', '价格已变动，请重新确认')
          prodDocs[it.productId] = p
          if (await ord.tget(t, 'coupon_codes', it.code)) return ord.rollbackWith(t, 'CODE_TAKEN', '券码冲突')
        }

        // ---- 再寫 ----
        // 改寫日期鎖：和同時進行的「改營業時間」互斥，兩邊只有一邊能成功
        for (const d of courtDates) {
          await t.collection('locks').doc(`day_${d}`).set({ data: { hoursVer: hoursVer[d], n: ((days[d] && days[d].n) || 0) + 1, at: created } })
        }
        await t.collection('user_pending').doc(user._id).set({ data: { orderId: order._id, at: created } })
        for (const it of itemDocs) {
          if (it.kind === 'court') {
            await t.collection('slot_locks').doc(u.slotId(it.date, it.court, it.hour)).set({
              data: { date: it.date, court: it.court, hour: it.hour, status: 'pending', orderId: order._id, expiresAt: order.expiresAt }
            })
          } else {
            const p = prodDocs[it.productId]
            it.fixedDate = !!p.fixedDate
            it.activityDate = p.activityDate || ''
            it.activityStartAt = p.activityStartAt || 0
            await t.collection('products').doc(p._id).update({ data: { stock: p.stock - it.qty, soldCount: (p.soldCount || 0) + it.qty } })
            await t.collection('coupon_codes').doc(it.code).set({ data: { itemId: it._id, orderId: order._id, at: created } })
          }
          const { _id, ...data } = it
          await t.collection('order_items').doc(_id).set({ data })
        }
        const { _id, ...orderData } = order
        await t.collection('orders').doc(_id).set({ data: orderData })
      })
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (e.code === 'CODE_TAKEN') continue
      if (e.code === 'ID_TAKEN') {
        order._id = u.newId('FX', 8)
        itemDocs.forEach((it, n) => {
          it._id = `${order._id}_${n + 1}`
          it.orderId = order._id
        })
        order.itemIds = itemDocs.map(i => i._id)
        continue
      }
      if (e.business) return u.fail(e.message, e.code === 'HAS_PENDING' ? 'HAS_PENDING' : 'INVALID_ITEMS', { orderId: e.orderId, invalid: [] })
      console.error('checkout tx', e)
      return u.fail('下单失败，请重试')
    }
  }
  if (lastErr) return u.fail('下单失败，请重试')

  // 向微信支付下單（有效期 5 分鐘）
  let payment
  try {
    payment = await pay.unifiedOrder(cloud, order, `飞翔球馆-${order.hasCourt ? '订场' : '活动'}`)
    await db.collection('orders').doc(order._id).update({ data: { payment } })
  } catch (e) {
    console.error('unifiedOrder', e)
    await ord.closePending(db, order._id, 'cancelled')
    return u.fail(/未配置/.test(e.message) ? e.message : '发起支付失败，请重试')
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
    v.state = refunded ? '已退款' : !paidish ? '' : it.refunding ? '退款中' : it.startAt + u.HOUR <= now ? '已使用' : it.startAt <= now ? '进行中' : '待使用'
    v.refundable = ord.itemRefundable(it)
    v.canRefund = paidish && !refunded && it.startAt - CANCEL_BEFORE > now && !it.refunding
    v.refundHint = refunded ? '已退款' : it.refunding ? '退款处理中，请稍候' : paidish && it.startAt - CANCEL_BEFORE <= now ? '已过可退时间' : ''
  } else {
    v.title = `${it.name} ×${it.qty}`
    v.image = it.image
    v.available = ord.productAvailable(it)
    const parts = []
    if (v.available > 0) parts.push(`未使用 ${v.available}`)
    // 同一張卡片的幾張券共用一個券碼，退款中按張數顯示（澄清 I2）
    if (it.refunding && it.refundingQty) parts.push(`退款中 ${it.refundingQty}`)
    if (it.verifiedQty) parts.push(`已核销 ${it.verifiedQty}`)
    if (it.refundedQty) parts.push(`已退款 ${it.refundedQty}`)
    if (it.expiredQty) parts.push(`已过期 ${it.expiredQty}`)
    v.state = paidish ? parts.join(' · ') || (it.refunding ? '退款中' : '') : ''
    v.refundable = ord.itemRefundable(it)
    const tooLate = it.fixedDate && it.activityStartAt - CANCEL_BEFORE <= now
    v.canRefund = paidish && v.available > 0 && !tooLate && !it.refunding
    v.refundHint = it.refunding && paidish ? '退款处理中，请稍候' : v.available <= 0 ? '' : paidish && tooLate ? '已过可退时间' : ''
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

// refunding = 這張訂單有退款還在處理中（澄清 I2）：退款成功前不顯示「已退款」
function statusText(order, refunding) {
  if (order.status === 'timeout_refunded' && order.refundState !== 'success') return '超时退款处理中'
  if (order.status === 'active' || order.status === 'completed') {
    if (refunding) return `${STATUS_TEXT[order.status]} · 退款处理中`
    if (order.refundedFee > 0) return `${STATUS_TEXT[order.status]} · 部分退款`
  }
  return STATUS_TEXT[order.status] || order.status
}

// 這批訂單中，哪些有退款還在處理中
async function refundingOrderIds(ids) {
  if (!ids.length) return new Set()
  const res = await db.collection('refunds').where({ orderId: _.in(ids), status: _.in(['pending', 'unknown']), kind: _.neq('timeout') }).limit(100).get()
  return new Set(res.data.map(r => r.orderId))
}

function orderView(order, refunding) {
  return {
    _id: order._id, status: order.status, statusText: statusText(order, refunding), totalFee: order.totalFee,
    refundedFee: order.refundedFee || 0, createdAt: order.createdAt, expiresAt: order.expiresAt,
    summary: order.summary, lines: order.lines || u.legacyLines(order.summary), confirming: !!order.confirming
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
    list.push(o)
  }
  const refunding = await refundingOrderIds(list.filter(o => o.status === 'active' || o.status === 'completed').map(o => o._id))
  return { list: list.map(o => orderView(o, refunding.has(o._id))), serverNow: Date.now(), more: res.data.length === 20 }
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
    order: orderView(order, items.some(it => it.refunding)),
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
        return u.ok({ ...(await schedule(event.date, OPENID)), banners: event.withBanners ? await activeBanners(Date.now()) : undefined })
      case 'banners':
        return u.ok(await activeBanners(Date.now()))
      case 'quote':
        if (!Array.isArray(event.items)) return u.ok([])
        if (event.items.length > MAX_QUOTE) return u.fail(`购物车最多 ${MAX_QUOTE} 项，请先删除一些`)
        return u.ok(await quote(event.items))
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
        return await checkout(user, event.items, event.expectTotal)

      case 'orderStatus': {
        let o = await loadOwnOrder(user, event.orderId)
        if (!o) return u.fail('订单不存在')
        if (o.status === 'pending') o = await ord.settle(cloud, db, o)
        if (o.status === 'pending' && event.check && !pay.MOCK) {
          // 付款後客人端主動查單，不必等微信通知
          const paid = await ord.confirmIfPaid(cloud, db, o).catch(() => null)
          if (paid) o = paid
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
        if (o.status !== 'pending' || o.expiresAt <= Date.now()) return u.fail('订单已关闭', 'CLOSED')
        const paidAt = Date.now()
        await db.collection('orders').doc(o._id).update({ data: { mockPaidAt: paidAt } })
        const r = (await ord.confirmIfPaid(cloud, db, { ...o, mockPaidAt: paidAt })) || o
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
        return u.ok({ amount: r.amount, processing: r.processing })
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
