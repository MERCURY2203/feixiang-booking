// 管理端雲函數：核銷、訂單管理、鎖場、商品、橫幅、價格與營業時間、報表、紅點
// 權限：OWNER_ONLY 裡的操作只有老闆能用，其餘老闆和員工都能用；一律在這裡判斷
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const XLSX = require('xlsx')
const db = cloud.database()
const _ = db.command
const u = require('./lib/util')
const cal = require('./lib/calendar')
const ord = require('./lib/orders')
const { getCaller, isAdmin, isOwner, displayName } = require('./lib/auth')

const OWNER_ONLY = [
  'priceConfig', 'saveRegular', 'saveDaily', 'deleteDaily', 'pricePreview',
  'hoursConfig', 'saveDailyHours', 'saveSpecial', 'deleteSpecial', 'report', 'reportExport'
]

async function audit(actor, action, detail) {
  await db.collection('audit_logs').add({ data: { actorId: actor._id, actorName: displayName(actor), action, detail, at: Date.now() } })
}

const STATUS_TEXT = {
  pending: '待支付', cancelled: '已取消', closed: '已关闭', active: '待使用',
  completed: '已完成', refunded: '已退款', timeout_refunded: '超时已退款'
}
function statusText(o) {
  const base = STATUS_TEXT[o.status] || o.status
  return (o.status === 'active' || o.status === 'completed') && o.refundedFee > 0 ? `${base} · 部分退款` : base
}

function hm(ts) {
  const d = new Date(ts + 8 * u.HOUR)
  return `${u.pad(d.getUTCHours())}:${u.pad(d.getUTCMinutes())}`
}

// ======================= 核銷 =======================

async function verifyLookup(code) {
  const res = await db.collection('order_items').where({ code: String(code || '').trim(), codeActive: true }).limit(1).get()
  const it = res.data[0]
  if (!it) return u.fail('券码已失效')
  const available = ord.productAvailable(it)
  if (available <= 0) return u.fail('券码已失效')
  const order = (await db.collection('orders').doc(it.orderId).get()).data
  if (!['active', 'completed'].includes(order.status)) return u.fail('该订单状态不能核销')
  return u.ok({ itemId: it._id, name: it.name, phone: u.maskPhone(order.phone), available, code: it.code })
}

async function verifyConfirm(user, itemId, qty) {
  qty = Math.floor(qty)
  if (!(qty >= 1)) return u.fail('请选择核销张数')
  const result = await db.runTransaction(async t => {
    const it = (await t.collection('order_items').doc(itemId).get()).data
    const available = ord.productAvailable(it)
    if (!it.codeActive || available <= 0) return { error: '券码已失效' }
    if (qty > available) return { error: `最多可核销 ${available} 张` }
    const left = available - qty
    await t.collection('order_items').doc(itemId).update({ data: { verifiedQty: (it.verifiedQty || 0) + qty, codeActive: left > 0 } })
    return { it, left }
  })
  if (result.error) return u.fail(result.error)
  const order = (await db.collection('orders').doc(result.it.orderId).get()).data
  const now = Date.now()
  await db.collection('verify_logs').add({
    data: {
      type: 'verify', itemId, orderId: order._id, name: result.it.name, qty, phone: order.phone,
      operatorId: user._id, operatorName: displayName(user), at: now, day: u.dateStr(now), undone: false
    }
  })
  await ord.refreshStatus(db, order._id)
  return u.ok({ left: result.left })
}

async function verifyLogs(day) {
  day = day || u.dateStr(Date.now())
  const res = await db.collection('verify_logs').where({ day }).orderBy('at', 'desc').limit(200).get()
  const today = u.dateStr(Date.now())
  return u.ok({
    day,
    list: res.data.map(l => ({
      _id: l._id, type: l.type, time: hm(l.at), name: l.name, qty: l.qty, phone: u.maskPhone(l.phone),
      operator: l.operatorName, undone: !!l.undone,
      canUndo: l.type === 'verify' && !l.undone && l.day === today
    }))
  })
}

async function verifyUndo(user, logId) {
  const today = u.dateStr(Date.now())
  const result = await db.runTransaction(async t => {
    const log = (await t.collection('verify_logs').doc(logId).get()).data
    if (!log || log.type !== 'verify' || log.undone) return { error: '该记录不能撤销' }
    if (log.day !== today) return { error: '只能撤销当天的核销记录' }
    const it = (await t.collection('order_items').doc(log.itemId).get()).data
    const stillValid = !it.fixedDate || u.dateStr(it.activityStartAt) >= today
    await t.collection('order_items').doc(log.itemId).update({ data: { verifiedQty: (it.verifiedQty || 0) - log.qty, codeActive: stillValid } })
    await t.collection('verify_logs').doc(logId).update({ data: { undone: true, undoneBy: user._id, undoneAt: Date.now() } })
    return { log }
  })
  if (result.error) return u.fail(result.error)
  const now = Date.now()
  await db.collection('verify_logs').add({
    data: {
      type: 'undo', itemId: result.log.itemId, orderId: result.log.orderId, name: result.log.name, qty: result.log.qty,
      phone: result.log.phone, operatorId: user._id, operatorName: displayName(user), at: now, day: u.dateStr(now), undone: false
    }
  })
  await ord.refreshStatus(db, result.log.orderId)
  return u.ok(true)
}

// ======================= 訂單管理 =======================

async function adminOrders({ keyword, date, tab, skip }) {
  const where = {}
  const kw = String(keyword || '').trim()
  if (/^\d{4}$/.test(kw)) where.phone = db.RegExp({ regexp: `${kw}$` })
  else if (kw) where._id = kw.toUpperCase()
  if (date) where.createdAt = _.gte(u.dayStart(date)).and(_.lt(u.dayStart(date) + u.DAY))
  if (tab === 'pending') where.status = 'pending'
  if (tab === 'active') where.status = 'active'
  if (tab === 'completed') where.status = 'completed'
  if (tab === 'refund') where.refundedFee = _.gt(0)
  const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').skip(skip || 0).limit(20).get()
  return u.ok({
    list: res.data.map(o => ({
      _id: o._id, created: `${u.dateStr(o.createdAt).slice(5)} ${hm(o.createdAt)}`, summary: o.summary,
      totalFee: o.totalFee, statusText: statusText(o), phone: o.deletedUser ? '已注销用户' : u.maskPhone(o.phone)
    })),
    more: res.data.length === 20
  })
}

function adminItemView(order, it, now) {
  const v = { _id: it._id, kind: it.kind, price: it.price, qty: it.qty, refundedFee: it.refundedFee || 0, refundable: ord.itemRefundable(it) }
  const paidish = ['active', 'completed'].includes(order.status)
  if (it.kind === 'court') {
    v.title = `${u.cnDate(it.date)} ${u.hourRange(it.hour)} ${it.court}号场`
    v.state = ord.courtFullyRefunded(it) ? '已退款' : it.startAt + u.HOUR <= now ? '已使用' : it.startAt <= now ? '进行中' : '待使用'
    if (v.refundedFee > 0 && !ord.courtFullyRefunded(it)) v.state += ` · 已退 ${u.formatFen(v.refundedFee)}`
  } else {
    v.title = `${it.name} ×${it.qty}`
    v.available = ord.productAvailable(it)
    const parts = []
    if (v.available > 0) parts.push(`未使用 ${v.available}`)
    if (it.verifiedQty) parts.push(`已核销 ${it.verifiedQty}`)
    if (it.refundedQty) parts.push(`已退款 ${it.refundedQty}`)
    if (it.expiredQty) parts.push(`已过期 ${it.expiredQty}`)
    v.state = parts.join(' · ')
  }
  // 管理端退款不受開場前 15 分鐘限制
  v.canRefund = paidish && v.refundable > 0 && !it.refunding
  return v
}

async function adminOrderDetail(orderId) {
  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order) return u.fail('订单不存在')
  const items = (await ord.getItems(db, orderId)).sort((a, b) => (a._id < b._id ? -1 : 1))
  const refunds = await db.collection('refunds').where({ orderId, status: 'success' }).orderBy('at', 'asc').get()
  const operators = {}
  for (const r of refunds.data) {
    if (r.operatorId && !operators[r.operatorId]) {
      const op = (await db.collection('users').doc(r.operatorId).get().catch(() => ({ data: null }))).data
      operators[r.operatorId] = op ? (op.role === 'customer' ? '客人' : displayName(op)) : ''
    }
  }
  const now = Date.now()
  const left = ord.MAX_REFUNDS - (order.refundCount || 0)
  return u.ok({
    order: {
      _id: order._id, statusText: statusText(order), totalFee: order.totalFee, refundedFee: order.refundedFee || 0,
      created: `${u.dateStr(order.createdAt)} ${hm(order.createdAt)}`,
      phone: order.deletedUser ? '已注销用户' : u.maskPhone(order.phone), hasPhone: !!order.phone && !order.deletedUser,
      refundWarn: (order.refundCount || 0) >= 45 ? `此订单剩余退款次数 ${left} 次，请合并退款` : ''
    },
    items: items.map(it => adminItemView(order, it, now)),
    refunds: refunds.data.map(r => ({
      time: `${u.dateStr(r.at).slice(5)} ${hm(r.at)}`, amount: r.amount,
      by: r.by === 'system' ? '系统' : operators[r.operatorId] || (r.by === 'customer' ? '客人' : ''), reason: r.reason || ''
    }))
  })
}

async function viewPhone(user, orderId) {
  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order || !order.phone || order.deletedUser) return u.fail('该客人没有手机号')
  await audit(user, 'view_phone', { orderId })
  return u.ok({ phone: order.phone })
}

async function adminRefund(user, orderId, parts) {
  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order) return u.fail('订单不存在')
  if (!Array.isArray(parts) || !parts.length) return u.fail('请选择要退款的项目')
  const items = await ord.getItems(db, orderId)
  const clean = []
  for (const p of parts) {
    const it = items.find(i => i._id === p.itemId)
    if (!it) return u.fail('退款项目不存在')
    const amount = Math.round(p.amount)
    if (!(amount > 0)) return u.fail('退款金额必须大于 0')
    let qty = it.kind === 'court' ? 1 : Math.max(0, Math.floor(p.qty || 0))
    if (it.kind === 'product' && qty > ord.productAvailable(it)) return u.fail('退款张数超过未使用张数')
    clean.push({ itemId: it._id, qty, amount })
  }
  const r = await ord.refundItems(cloud, db, { order, parts: clean, operatorId: user._id, by: 'admin', reason: '' })
  await audit(user, 'refund', { orderId, amount: r.amount })
  return u.ok({ amount: r.amount })
}

// ======================= 場地管理（鎖場） =======================

async function courtSchedule(date) {
  const now = Date.now()
  const cfg = await cal.loadConfig(db)
  const days = cal.bookableDays(cfg, now)
  if (!days.includes(date)) date = days[0]
  const out = { days: days.map(d => ({ date: d, label: u.dateLabel(d) })), date, courts: u.COURTS, hours: [], cells: [] }
  if (!date) return u.ok(out)
  const h = cal.hoursFor(cfg, date)
  const locks = await db.collection('slot_locks').where({ date }).limit(1000).get()
  const map = Object.fromEntries(locks.data.map(l => [l._id, l]))
  for (let hour = h.open; hour < h.close; hour++) {
    out.hours.push({ hour, label: `${u.pad(hour)}:00` })
    out.cells.push(u.COURTS.map(court => {
      const l = map[u.slotId(date, court, hour)]
      if (u.slotStart(date, hour) <= now) return { s: 'past' }
      if (!l || (l.status === 'pending' && l.expiresAt < now)) return { s: 'free' }
      return { s: l.status === 'locked' ? 'locked' : l.status === 'pending' ? 'pending' : 'booked' }
    }))
  }
  return u.ok(out)
}

async function setLocks(user, date, cells, lock) {
  if (!Array.isArray(cells) || !cells.length) return u.fail('请先选择格子')
  const now = Date.now()
  const failed = []
  for (const c of cells) {
    const id = u.slotId(date, +c.court, +c.hour)
    if (u.slotStart(date, +c.hour) <= now) {
      failed.push({ ...c, reason: '已过去' })
      continue
    }
    if (lock) {
      const r = await db.runTransaction(async t => {
        let l = null
        try {
          l = (await t.collection('slot_locks').doc(id).get()).data
        } catch (e) {
          l = null
        }
        if (l && l.status === 'locked') return null
        if (l && l.status === 'booked') return '该时段已有订单，请先退款再锁定'
        if (l && l.status === 'pending') return '该时段有待支付订单，请稍后再试'
        await t.collection('slot_locks').doc(id).set({ data: { date, court: +c.court, hour: +c.hour, status: 'locked', orderId: '', lockedBy: user._id, lockedAt: now } })
        return null
      })
      if (r) failed.push({ ...c, reason: r })
    } else {
      await db.collection('slot_locks').where({ _id: id, status: 'locked' }).remove()
    }
  }
  await audit(user, lock ? 'lock_courts' : 'unlock_courts', { date, cells, failed: failed.length })
  return u.ok({ failed })
}

// ======================= 商品管理 =======================

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
  if (!m) return null
  const h = +m[1]
  const mi = +m[2]
  return h < 24 && mi < 60 ? { h, mi } : null
}

async function productList() {
  const res = await db.collection('products').orderBy('sort', 'asc').orderBy('createdAt', 'desc').limit(200).get()
  return u.ok(res.data.map(p => ({
    _id: p._id, name: p.name, image: (p.images || [])[0] || '', price: p.price, stock: p.stock, onShelf: p.onShelf,
    soldCount: p.soldCount || 0, fixedDate: !!p.fixedDate,
    validity: p.fixedDate ? `${u.cnDate(p.activityDate)} ${hm(p.activityStartAt)}` : '长期'
  })))
}

async function productGet(id) {
  const p = (await db.collection('products').doc(id).get().catch(() => ({ data: null }))).data
  if (!p) return u.fail('商品不存在')
  return u.ok({ ...p, activityStartTime: p.fixedDate ? hm(p.activityStartAt) : '' })
}

async function productSave(user, p) {
  const name = String(p.name || '').trim()
  if (!name) return u.fail('请填写商品名称')
  const price = Math.round(p.price)
  if (!(price > 0)) return u.fail('请填写正确的价格')
  const stock = Math.floor(p.stock)
  if (!(stock >= 0)) return u.fail('请填写正确的库存')
  const images = (p.images || []).filter(x => typeof x === 'string' && x.startsWith('cloud://')).slice(0, 6)
  if (!images.length) return u.fail('请至少上传一张图片')
  const data = { name, price, stock, images, desc: String(p.desc || '').slice(0, 2000), fixedDate: !!p.fixedDate, onShelf: !!p.onShelf, updatedAt: Date.now() }
  if (data.fixedDate) {
    const t = parseHm(p.activityStartTime)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.activityDate || '') || !t) return u.fail('固定日期活动需填写活动日期和开始时间')
    data.activityDate = p.activityDate
    data.activityStartAt = u.dayStart(p.activityDate) + t.h * u.HOUR + t.mi * 60000
  } else {
    data.activityDate = ''
    data.activityStartAt = 0
  }
  if (p._id) {
    await db.collection('products').doc(p._id).update({ data })
    await audit(user, 'product_update', { id: p._id, price })
    return u.ok({ _id: p._id })
  }
  const res = await db.collection('products').add({ data: { ...data, sort: 0, soldCount: 0, createdAt: Date.now() } })
  await audit(user, 'product_create', { id: res._id })
  return u.ok({ _id: res._id })
}

async function productDelete(user, id) {
  const p = (await db.collection('products').doc(id).get().catch(() => ({ data: null }))).data
  if (!p) return u.fail('商品不存在')
  if ((p.soldCount || 0) > 0) return u.fail('已有人购买过的商品不能删除，只能下架')
  await db.collection('products').doc(id).remove()
  await audit(user, 'product_delete', { id })
  return u.ok(true)
}

async function productToggle(user, id, onShelf) {
  await db.collection('products').doc(id).update({ data: { onShelf: !!onShelf } })
  await audit(user, onShelf ? 'product_on' : 'product_off', { id })
  return u.ok(true)
}

// ======================= 橫幅管理 =======================

function bannerShowing(b, now) {
  return b.enabled && (b.mode !== 'timed' || b.endAt > now)
}

async function bannerList() {
  const res = await db.collection('banners').orderBy('sort', 'asc').limit(50).get()
  const now = Date.now()
  const products = {}
  const ids = res.data.filter(b => b.target && b.target.type === 'product').map(b => b.target.productId)
  if (ids.length) (await db.collection('products').where({ _id: _.in(ids) }).get()).data.forEach(p => (products[p._id] = p.name))
  return u.ok(res.data.map(b => {
    let targetText = '不跳转'
    if (b.target && b.target.type === 'product') targetText = `商品：${products[b.target.productId] || '已删除'}`
    if (b.target && b.target.type === 'activity') targetText = '活动页'
    if (b.target && b.target.type === 'booking') targetText = `订场：${b.target.date ? u.cnDate(b.target.date) : '当天'}`
    let state = '已下架'
    if (b.enabled) state = b.mode !== 'timed' ? '长期显示' : now < b.startAt ? '未开始' : now < b.endAt ? '显示中（限时）' : '已结束'
    return {
      _id: b._id, image: b.image, enabled: b.enabled, mode: b.mode || 'long', target: b.target || { type: 'none' }, targetText, state,
      startDate: b.startAt ? u.dateStr(b.startAt) : '', startTime: b.startAt ? hm(b.startAt) : '',
      endDate: b.endAt ? u.dateStr(b.endAt) : '', endTime: b.endAt ? hm(b.endAt) : ''
    }
  }))
}

async function bannerSave(user, b) {
  if (!b.image || !String(b.image).startsWith('cloud://')) return u.fail('请上传横幅图片')
  const data = { image: b.image, enabled: b.enabled !== false, mode: b.mode === 'timed' ? 'timed' : 'long', updatedAt: Date.now() }
  const tt = b.target || {}
  data.target = tt.type === 'product' ? { type: 'product', productId: tt.productId } : tt.type === 'activity' ? { type: 'activity' } : tt.type === 'booking' ? { type: 'booking', date: tt.date || '' } : { type: 'none' }
  if (data.target.type === 'product' && !data.target.productId) return u.fail('请选择跳转的商品')
  if (data.mode === 'timed') {
    const s = parseHm(b.startTime)
    const e = parseHm(b.endTime)
    if (!b.startDate || !b.endDate || !s || !e) return u.fail('请填写开始和结束时间')
    data.startAt = u.dayStart(b.startDate) + s.h * u.HOUR + s.mi * 60000
    data.endAt = u.dayStart(b.endDate) + e.h * u.HOUR + e.mi * 60000
    if (data.endAt <= data.startAt) return u.fail('结束时间要晚于开始时间')
  } else {
    data.startAt = 0
    data.endAt = 0
  }
  if (bannerShowing(data, Date.now())) {
    const all = (await db.collection('banners').where({ enabled: true }).get()).data.filter(x => x._id !== b._id && bannerShowing(x, Date.now()))
    if (all.length >= 5) return u.fail('已有 5 张横幅在显示，请先下架一张')
  }
  if (b._id) await db.collection('banners').doc(b._id).update({ data })
  else {
    const last = await db.collection('banners').orderBy('sort', 'desc').limit(1).get()
    await db.collection('banners').add({ data: { ...data, sort: last.data.length ? last.data[0].sort + 1 : 0, createdAt: Date.now() } })
  }
  await audit(user, 'banner_save', { id: b._id || 'new' })
  return u.ok(true)
}

async function bannerToggle(user, id, enabled) {
  const b = (await db.collection('banners').doc(id).get()).data
  if (enabled && bannerShowing({ ...b, enabled: true }, Date.now())) {
    const all = (await db.collection('banners').where({ enabled: true }).get()).data.filter(x => x._id !== id && bannerShowing(x, Date.now()))
    if (all.length >= 5) return u.fail('已有 5 张横幅在显示，请先下架一张')
  }
  await db.collection('banners').doc(id).update({ data: { enabled: !!enabled } })
  return u.ok(true)
}

async function bannerReorder(ids) {
  for (let i = 0; i < ids.length; i++) await db.collection('banners').doc(ids[i]).update({ data: { sort: i } })
  return u.ok(true)
}

// ======================= 價格與營業時間（僅老闆） =======================

async function priceConfig() {
  const cfg = await cal.loadConfig(db)
  const today = u.dateStr(Date.now())
  const current = cal.regularFor(cfg, today)
  const scheduled = cfg.regular.filter(r => r.effectiveFrom > today).reverse()
  const all = await cal.getAll(db.collection('prices'), { type: 'daily' })
  const view = r => {
    const dates = r.dates.slice().sort()
    let dateText = dates.map(d => u.cnDate(d)).join('、')
    const consecutive = dates.every((d, i) => i === 0 || u.addDays(dates[i - 1], 1) === d)
    if (dates.length > 1 && consecutive) dateText = `${u.cnDate(dates[0])} – ${u.cnDate(dates[dates.length - 1])} · 共 ${dates.length} 天`
    const courts = r.courts.length === 10 ? '全部场地' : `${r.courts.join('、')}号场`
    return { _id: r._id, dates, startHour: r.startHour, endHour: r.endHour, courts: r.courts, price: r.price, dateText, timeText: `${u.pad(r.startHour)}:00–${u.pad(r.endHour)}:00`, courtText: courts }
  }
  return u.ok({
    regular: { weekday: current.weekday, weekend: current.weekend, effectiveFrom: current.effectiveFrom || '' },
    scheduled: scheduled.map(r => ({ _id: r._id, weekday: r.weekday, weekend: r.weekend, effectiveFrom: r.effectiveFrom })),
    daily: all.filter(r => r.lastDate >= today).sort((a, b) => (a.dates[0] < b.dates[0] ? -1 : 1)).map(view),
    expired: all.filter(r => r.lastDate < today).sort((a, b) => (a.lastDate > b.lastDate ? -1 : 1)).slice(0, 50).map(view)
  })
}

async function saveRegular(user, { weekday, weekend, effectiveFrom }) {
  weekday = Math.round(weekday)
  weekend = Math.round(weekend)
  if (!(weekday > 0 && weekend > 0)) return u.fail('请填写正确的价格')
  const today = u.dateStr(Date.now())
  const from = effectiveFrom && effectiveFrom > today ? effectiveFrom : today
  const same = await db.collection('prices').where({ type: 'regular', effectiveFrom: from }).get()
  if (same.data.length) await db.collection('prices').doc(same.data[0]._id).update({ data: { weekday, weekend, updatedAt: Date.now() } })
  else await db.collection('prices').add({ data: { type: 'regular', weekday, weekend, effectiveFrom: from, createdAt: Date.now() } })
  await audit(user, 'price_regular', { weekday, weekend, from })
  return u.ok(true)
}

async function saveDaily(user, r) {
  const dates = [...new Set((r.dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
  const startHour = Math.floor(r.startHour)
  const endHour = Math.floor(r.endHour)
  const courts = [...new Set((r.courts || []).map(Number).filter(c => u.COURTS.includes(c)))].sort((a, b) => a - b)
  const price = Math.round(r.price)
  if (!dates.length) return u.fail('请选择日期')
  if (!(endHour > startHour)) return u.fail('结束时间要晚于开始时间')
  if (!courts.length) return u.fail('请选择场地')
  if (!(price > 0)) return u.fail('请填写正确的价格')
  if (dates[0] < u.dateStr(Date.now())) return u.fail('不能设置已过去的日期')

  // 時段超出營業時間：不允許保存（澄清 C5）
  const cfg = await cal.loadConfig(db)
  for (const d of dates) {
    const h = cal.hoursFor(cfg, d)
    if (!h || startHour < h.open || endHour > h.close) return u.fail(`部分时段不在营业时间内（${u.cnDate(d)}）`)
  }
  // 單日價格之間不能重疊
  const others = (await cal.getAll(db.collection('prices'), { type: 'daily', lastDate: _.gte(dates[0]) })).filter(x => x._id !== r._id)
  for (const o of others) {
    const shareDate = o.dates.some(d => dates.includes(d))
    const shareCourt = o.courts.some(c => courts.includes(c))
    const shareHour = o.startHour < endHour && startHour < o.endHour
    if (shareDate && shareCourt && shareHour) {
      return u.fail(`与已有单日价格冲突：${u.cnDate(o.dates[0])} ${u.pad(o.startHour)}:00–${u.pad(o.endHour)}:00`, 'CONFLICT', { conflictId: o._id })
    }
  }
  const data = { type: 'daily', dates, lastDate: dates[dates.length - 1], startHour, endHour, courts, price, updatedAt: Date.now() }
  if (r._id) await db.collection('prices').doc(r._id).update({ data })
  else await db.collection('prices').add({ data: { ...data, createdAt: Date.now() } })
  await audit(user, 'price_daily', { dates: dates.length, price })
  return u.ok(true)
}

async function pricePreview(date) {
  const cfg = await cal.loadConfig(db)
  const h = cal.hoursFor(cfg, date)
  if (!h) return u.ok({ date, closed: true, hours: [], cells: [] })
  const hours = []
  const cells = []
  for (let hour = h.open; hour < h.close; hour++) {
    hours.push({ hour, label: `${u.pad(hour)}:00` })
    cells.push(u.COURTS.map(c => {
      const p = cal.priceFor(cfg, date, c, hour)
      return { p: p.price, sp: p.special }
    }))
  }
  return u.ok({ date, closed: false, courts: u.COURTS, hours, cells })
}

async function hoursConfig() {
  const cfg = await cal.loadConfig(db)
  const today = u.dateStr(Date.now())
  const current = cal.hoursFor({ ...cfg, special: {} }, today)
  return u.ok({
    daily: { ...current },
    scheduled: cfg.daily.filter(d => d.effectiveFrom > today).reverse().map(d => ({ _id: d._id, open: d.open, close: d.close, effectiveFrom: d.effectiveFrom })),
    special: Object.values(cfg.special).filter(s => s.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))
      .map(s => ({ _id: s._id, date: s.date, dateText: u.dateLabel(s.date), closed: !!s.closed, open: s.open, close: s.close }))
  })
}

// 縮短營業時間時，被縮掉的時段已有訂單 → 不允許保存；open 為 null 表示全天休息
async function ordersOutside(dates, open, close) {
  const now = Date.now()
  const locks = await cal.getAll(db.collection('slot_locks'), { date: dates[0], status: _.in(['booked', 'pending']) })
  return locks
    .filter(l => (l.status === 'booked' || l.expiresAt > now) && (open === null || l.hour < open || l.hour >= close))
    .map(l => `${u.cnDate(l.date)} ${u.hourRange(l.hour)} ${l.court}号场`)
}

async function saveDailyHours(user, { open, close, effectiveFrom }) {
  open = Math.floor(open)
  close = Math.floor(close)
  if (!(open >= 0 && close <= 24 && close > open)) return u.fail('请填写正确的营业时间')
  const today = u.dateStr(Date.now())
  const from = effectiveFrom && effectiveFrom > today ? effectiveFrom : today
  // 只檢查沒有特殊日期覆蓋的日子
  const cfg = await cal.loadConfig(db)
  const list = await ordersOutsideRange(from, open, close, cfg)
  if (list.length) return u.fail('以下时段已有订单，请先处理', 'HAS_ORDERS', { orders: list.slice(0, 30) })
  const same = await db.collection('business_hours').where({ type: 'daily', effectiveFrom: from }).get()
  if (same.data.length) await db.collection('business_hours').doc(same.data[0]._id).update({ data: { open, close } })
  else await db.collection('business_hours').add({ data: { type: 'daily', open, close, effectiveFrom: from, createdAt: Date.now() } })
  await audit(user, 'hours_daily', { open, close, from })
  return u.ok(true)
}

async function ordersOutsideRange(from, open, close, cfg) {
  const now = Date.now()
  const locks = await cal.getAll(db.collection('slot_locks'), { date: _.gte(from), status: _.in(['booked', 'pending']) })
  return locks
    .filter(l => !cfg.special[l.date])
    .filter(l => (l.status === 'booked' || l.expiresAt > now) && (l.hour < open || l.hour >= close))
    .map(l => `${u.cnDate(l.date)} ${u.hourRange(l.hour)} ${l.court}号场`)
}

async function saveSpecial(user, { date, closed, open, close }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date < u.dateStr(Date.now())) return u.fail('请选择今天或以后的日期')
  closed = !!closed
  if (!closed) {
    open = Math.floor(open)
    close = Math.floor(close)
    if (!(open >= 0 && close <= 24 && close > open)) return u.fail('请填写正确的营业时间')
  }
  const list = await ordersOutside([date], closed ? null : open, close)
  if (list.length) return u.fail('以下时段已有订单，请先处理', 'HAS_ORDERS', { orders: list.slice(0, 30) })
  const data = { type: 'special', date, closed, open: closed ? 0 : open, close: closed ? 0 : close, updatedAt: Date.now() }
  const same = await db.collection('business_hours').where({ type: 'special', date }).get()
  if (same.data.length) await db.collection('business_hours').doc(same.data[0]._id).update({ data })
  else await db.collection('business_hours').add({ data })
  await audit(user, 'hours_special', { date, closed })
  return u.ok(true)
}

async function deleteSpecial(user, id) {
  const sp = (await db.collection('business_hours').doc(id).get().catch(() => ({ data: null }))).data
  if (!sp) return u.ok(true)
  const cfg = await cal.loadConfig(db)
  const normal = cal.hoursFor({ ...cfg, special: {} }, sp.date)
  const list = await ordersOutside([sp.date], normal.open, normal.close)
  if (list.length) return u.fail('以下时段已有订单，请先处理', 'HAS_ORDERS', { orders: list.slice(0, 30) })
  await db.collection('business_hours').doc(id).remove()
  await audit(user, 'hours_special_delete', { date: sp.date })
  return u.ok(true)
}

// ======================= 報表（僅老闆） =======================
// 口徑：收入按付款日、退款按退款日、場地使用率按打球日（澄清 B7）

function periodKey(ts, mode) {
  const d = u.dateStr(ts)
  return mode === 'month' ? d.slice(0, 7) : d
}

async function buildReport({ mode, from, to }) {
  mode = mode === 'month' ? 'month' : 'day'
  const start = u.dayStart(from)
  const end = u.dayStart(to) + u.DAY
  if (!(end > start) || end - start > 400 * u.DAY) throw new Error('日期范围不正确（最长 400 天）')

  const orders = await cal.getAll(db.collection('orders'), {
    payTime: _.gte(start).and(_.lt(end)),
    status: _.in(['active', 'completed', 'refunded'])
  })
  const orderIds = orders.map(o => o._id)
  const items = []
  for (let i = 0; i < orderIds.length; i += 100) {
    items.push(...(await cal.getAll(db.collection('order_items'), { orderId: _.in(orderIds.slice(i, i + 100)) })))
  }
  const payTimeOf = Object.fromEntries(orders.map(o => [o._id, o.payTime]))
  const refunds = (await cal.getAll(db.collection('refunds'), { status: 'success', at: _.gte(start).and(_.lt(end)) }))
    .filter(r => r.by !== 'system' || r.reason !== '超时付款自动退款')

  const rows = {}
  const row = k => (rows[k] = rows[k] || { period: k, court: 0, product: 0, refund: 0 })
  for (const it of items) {
    const r = row(periodKey(payTimeOf[it.orderId], mode))
    if (it.kind === 'court') r.court += it.price
    else r.product += it.price * it.qty
  }
  for (const rf of refunds) row(periodKey(rf.at, mode)).refund += rf.amount

  // 使用率：按打球日，期內所有有效（未全額退款）的場地卡片
  const cfg = await cal.loadConfig(db)
  const played = await cal.getAll(db.collection('order_items'), {
    kind: 'court', date: _.gte(from).and(_.lte(to)), status: _.in(['active', 'used'])
  })
  const courtCount = {}
  const hourCount = {}
  let capacityPerCourt = 0
  const hourCapacity = {}
  for (let d = from; d <= to; d = u.addDays(d, 1)) {
    const h = cal.hoursFor(cfg, d)
    if (!h) continue
    capacityPerCourt += h.close - h.open
    for (let x = h.open; x < h.close; x++) hourCapacity[x] = (hourCapacity[x] || 0) + 10
  }
  for (const it of played) {
    if (ord.courtFullyRefunded(it)) continue
    courtCount[it.court] = (courtCount[it.court] || 0) + 1
    hourCount[it.hour] = (hourCount[it.hour] || 0) + 1
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)
  const list = Object.values(rows).sort((a, b) => (a.period < b.period ? -1 : 1)).map(r => ({ ...r, income: r.court + r.product, net: r.court + r.product - r.refund }))
  const total = list.reduce((s, r) => ({ court: s.court + r.court, product: s.product + r.product, refund: s.refund + r.refund }), { court: 0, product: 0, refund: 0 })
  return {
    mode, from, to, rows: list,
    total: { ...total, income: total.court + total.product, net: total.court + total.product - total.refund },
    usageByCourt: u.COURTS.map(c => ({ court: c, count: courtCount[c] || 0, rate: pct(courtCount[c] || 0, capacityPerCourt) })),
    usageByHour: Object.keys(hourCapacity).map(Number).sort((a, b) => a - b).map(h => ({ hour: h, label: `${u.pad(h)}:00`, count: hourCount[h] || 0, rate: pct(hourCount[h] || 0, hourCapacity[h]) })),
    hot: Object.keys(hourCount).map(Number).map(h => ({ label: u.hourRange(h), count: hourCount[h] })).sort((a, b) => b.count - a.count).slice(0, 5)
  }
}

async function reportExport(rep) {
  const yuan = f => Math.round(f) / 100
  const wb = XLSX.utils.book_new()
  const sheet1 = [['日期', '场地收入（元）', '活动收入（元）', '收入合计（元）', '退款（元）', '实收（元）']]
  rep.rows.forEach(r => sheet1.push([r.period, yuan(r.court), yuan(r.product), yuan(r.income), yuan(r.refund), yuan(r.net)]))
  sheet1.push(['合计', yuan(rep.total.court), yuan(rep.total.product), yuan(rep.total.income), yuan(rep.total.refund), yuan(rep.total.net)])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet1), '收入')
  const sheet2 = [['场地', '被订小时数', '使用率（%）']]
  rep.usageByCourt.forEach(c => sheet2.push([`${c.court}号场`, c.count, c.rate]))
  sheet2.push([])
  sheet2.push(['时段', '被订次数', '使用率（%）'])
  rep.usageByHour.forEach(h => sheet2.push([h.label, h.count, h.rate]))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet2), '场地使用率')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const name = `飞翔球馆报表_${rep.from}_${rep.to}.xlsx`
  const up = await cloud.uploadFile({ cloudPath: `reports/${Date.now()}_${rep.from}_${rep.to}.xlsx`, fileContent: buf })
  return { fileID: up.fileID, name }
}

// ======================= 紅點 =======================

async function badges(user) {
  const since = user.noticeSeenAt || 0
  const res = await db.collection('notices').where({ at: _.gt(since) }).count()
  return u.ok({ orders: res.total })
}

// ======================= 入口 =======================

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return u.fail('请在小程序内使用', 'NO_OPENID')
  try {
    const user = await getCaller(db, OPENID)
    if (!isAdmin(user)) return u.fail('无权限', 'FORBIDDEN')
    if (OWNER_ONLY.includes(event.action) && !isOwner(user)) return u.fail('只有老板可以操作', 'FORBIDDEN')

    switch (event.action) {
      case 'me':
        return u.ok({ role: user.role, name: displayName(user) })
      case 'badges':
        return await badges(user)
      case 'markSeen':
        await db.collection('users').doc(user._id).update({ data: { noticeSeenAt: Date.now() } })
        return u.ok(true)

      case 'verifyLookup':
        return await verifyLookup(event.code)
      case 'verifyConfirm':
        return await verifyConfirm(user, event.itemId, event.qty)
      case 'verifyLogs':
        return await verifyLogs(event.day)
      case 'verifyUndo':
        return await verifyUndo(user, event.logId)

      case 'orders':
        return await adminOrders(event)
      case 'orderDetail':
        return await adminOrderDetail(event.orderId)
      case 'viewPhone':
        return await viewPhone(user, event.orderId)
      case 'refund':
        return await adminRefund(user, event.orderId, event.parts)

      case 'courtSchedule':
        return await courtSchedule(event.date)
      case 'setLocks':
        return await setLocks(user, event.date, event.cells, !!event.lock)

      case 'productList':
        return await productList()
      case 'productGet':
        return await productGet(event.id)
      case 'productSave':
        return await productSave(user, event.product || {})
      case 'productDelete':
        return await productDelete(user, event.id)
      case 'productToggle':
        return await productToggle(user, event.id, event.onShelf)

      case 'bannerList':
        return await bannerList()
      case 'bannerSave':
        return await bannerSave(user, event.banner || {})
      case 'bannerToggle':
        return await bannerToggle(user, event.id, event.enabled)
      case 'bannerDelete':
        await db.collection('banners').doc(event.id).remove()
        await audit(user, 'banner_delete', { id: event.id })
        return u.ok(true)
      case 'bannerReorder':
        return await bannerReorder(event.ids || [])

      case 'priceConfig':
        return await priceConfig()
      case 'saveRegular':
        return await saveRegular(user, event)
      case 'saveDaily':
        return await saveDaily(user, event.rule || {})
      case 'deleteDaily':
        await db.collection('prices').doc(event.id).remove()
        await audit(user, 'price_daily_delete', { id: event.id })
        return u.ok(true)
      case 'pricePreview':
        return await pricePreview(event.date)

      case 'hoursConfig':
        return await hoursConfig()
      case 'saveDailyHours':
        return await saveDailyHours(user, event)
      case 'saveSpecial':
        return await saveSpecial(user, event)
      case 'deleteSpecial':
        return await deleteSpecial(user, event.id)

      case 'report':
        return u.ok(await buildReport(event))
      case 'reportExport':
        return u.ok(await reportExport(await buildReport(event)))

      default:
        return u.fail('未知操作')
    }
  } catch (e) {
    console.error(e)
    return u.fail(e.message && /[一-龥]/.test(e.message) ? e.message : '操作失败，请稍后再试')
  }
}
