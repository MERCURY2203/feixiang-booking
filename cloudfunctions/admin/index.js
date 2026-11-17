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
const games = require('./lib/games')
const gops = require('./lib/gameops')
const { getCaller, isAdmin, isOwner, displayName } = require('./lib/auth')

// 組局員（role host）只能用這些操作，且只能管自己發起的球局（澄清 N1）
const HOST_ACTIONS = ['me', 'badges', 'courtSchedule', 'gameList', 'gameGet', 'gamePublish', 'gameUpdate', 'gameKick', 'gameCancel']

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
function statusText(o, refunding) {
  if (o.status === 'timeout_refunded' && o.refundState !== 'success') return o.refundState === 'failed' ? '超时退款失败·请人工处理' : '超时退款处理中'
  const base = STATUS_TEXT[o.status] || o.status
  if (o.status === 'active' || o.status === 'completed') {
    if (refunding) return `${base} · 退款处理中`
    if (o.refundedFee > 0) return `${base} · 部分退款`
  }
  return base
}

// 版本鎖（澄清 K6、K10）：先記下 locks/{name} 的版本，check() 用一般查詢做檢查（不通過就返回失敗），
// 再在事務裡確認版本沒變，write(t) 寫入並把版本加一。兩個同時保存時，後提交的一方會發現版本變了，
// 重新檢查（就能看到前一方剛存的內容）
async function withVersionLock(name, check, write) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const lock = await ord.dget(db, 'locks', name)
    const ver = (lock && lock.ver) || 0
    const bad = await check()
    if (bad) return bad
    try {
      await ord.tx(db, async t => {
        const cur = await ord.tget(t, 'locks', name)
        if (((cur && cur.ver) || 0) !== ver) return ord.rollbackWith(t, 'RETRY', '数据已变动')
        await write(t)
        await t.collection('locks').doc(name).set({ data: { ver: ver + 1, at: Date.now() } })
      })
      return null
    } catch (e) {
      if (e.business && e.code === 'RETRY') continue
      throw e
    }
  }
  return u.fail('操作太频繁，请稍后再试')
}

function hm(ts) {
  const d = new Date(ts + 8 * u.HOUR)
  return `${u.pad(d.getUTCHours())}:${u.pad(d.getUTCMinutes())}`
}

// ======================= 核銷 =======================

// 用券碼找卡片：coupon_codes/{券碼} 保證一個券碼只對應一張卡片
async function findCoupon(code) {
  code = String(code || '').trim()
  if (!/^\d{6}$/.test(code)) return null
  const c = await ord.dget(db, 'coupon_codes', code)
  if (c) return ord.dget(db, 'order_items', c.itemId)
  // 兼容：舊數據沒有 coupon_codes 記錄
  const res = await db.collection('order_items').where({ code, codeActive: true }).limit(1).get()
  return res.data[0] || null
}

async function verifyLookup(code) {
  const it = await findCoupon(code)
  if (!it || it.kind !== 'product' || !it.codeActive) return u.fail('券码已失效')
  if (ord.productExpired(it, Date.now())) return u.fail('券码已过期')
  const available = ord.productAvailable(it)
  if (available <= 0) return u.fail(it.refunding ? '该券正在退款中' : '券码已失效')
  const order = await ord.dget(db, 'orders', it.orderId)
  if (!order || !['active', 'completed'].includes(order.status)) return u.fail('该订单未付款或已关闭，不能核销')
  return u.ok({ itemId: it._id, name: it.name, phone: u.maskPhone(order.phone), available, code: it.code })
}

// 核銷（事務）：重新讀取卡片和訂單，確認已付款、未過期、張數足夠（退款處理中的張數不算可用）。
// 扣券和核銷記錄在同一個事務裡寫入，要嘛一起成功、要嘛一起失敗（澄清 I1）。
// reqId 是前端每次打開核銷確認時產生的操作編號，核銷記錄就用它當編號：
// 同一編號重試（例如網絡出錯後再按一次）時認出已做過，直接返回原結果，不會再扣券。
async function verifyConfirm(user, itemId, qty, reqId) {
  qty = Number(qty)
  if (!Number.isInteger(qty) || qty < 1) return u.fail('请选择核销张数')
  const logId = /^[A-Za-z0-9_-]{8,40}$/.test(String(reqId || '')) ? `V${reqId}` : u.newId('V')
  let result
  try {
    result = await ord.tx(db, async t => {
      const done = await ord.tget(t, 'verify_logs', logId)
      if (done) {
        if (done.itemId !== String(itemId || '') || done.type !== 'verify') return ord.rollbackWith(t, 'BAD', '操作编号重复，请重新扫码')
        return { repeat: true, log: done }
      }
      const it = await ord.tget(t, 'order_items', String(itemId || ''))
      if (!it || it.kind !== 'product') return ord.rollbackWith(t, 'BAD', '券码已失效')
      const order = await ord.tget(t, 'orders', it.orderId)
      if (!order || !['active', 'completed'].includes(order.status)) return ord.rollbackWith(t, 'BAD', '该订单未付款或已关闭，不能核销')
      if (ord.productExpired(it, Date.now())) return ord.rollbackWith(t, 'BAD', '券码已过期')
      const available = ord.productAvailable(it)
      if (!it.codeActive || available <= 0) return ord.rollbackWith(t, 'BAD', '券码已失效')
      if (qty > available) return ord.rollbackWith(t, 'BAD', `最多可核销 ${available} 张`)
      const left = available - qty
      const now = Date.now()
      const log = {
        type: 'verify', itemId: it._id, orderId: order._id, userId: order.userId, name: it.name, qty, left,
        phone: order.phone, operatorId: user._id, operatorName: displayName(user), at: now, day: u.dateStr(now), undone: false
      }
      await t.collection('order_items').doc(it._id).update({ data: { verifiedQty: (it.verifiedQty || 0) + qty, codeActive: left > 0 || !!it.refunding } })
      await t.collection('verify_logs').doc(logId).set({ data: log })
      return { log }
    })
  } catch (e) {
    if (e.business) return u.fail(e.message)
    throw e
  }
  // 扣券和記錄已完成；訂單狀態是推算出來的，這裡失敗不影響結果（打開訂單時會重新計算）
  if (!result.repeat) await ord.refreshStatus(db, result.log.orderId).catch(e => console.error('verify refreshStatus', e))
  return u.ok({ left: result.log.left, qty: result.log.qty, repeat: !!result.repeat })
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

// 撤銷核銷：撤銷動作和「撤銷記錄」在同一個事務裡寫入（澄清 I1）；
// 撤銷記錄的編號固定為 U + 原記錄編號，重試時認出已撤銷過，直接返回成功
async function verifyUndo(user, logId) {
  const today = u.dateStr(Date.now())
  logId = String(logId || '')
  const undoId = `U${logId}`
  let result
  try {
    result = await ord.tx(db, async t => {
      const log = await ord.tget(t, 'verify_logs', logId)
      if (!log || log.type !== 'verify') return ord.rollbackWith(t, 'BAD', '该记录不能撤销')
      if (log.undone) {
        if (await ord.tget(t, 'verify_logs', undoId)) return { repeat: true, log }
        return ord.rollbackWith(t, 'BAD', '该记录不能撤销')
      }
      if (log.day !== today) return ord.rollbackWith(t, 'BAD', '只能撤销当天的核销记录')
      const it = await ord.tget(t, 'order_items', log.itemId)
      if (!it) return ord.rollbackWith(t, 'BAD', '该记录不能撤销')
      const order = await ord.tget(t, 'orders', it.orderId)
      const paid = order && ['active', 'completed'].includes(order.status)
      const stillValid = paid && !ord.productExpired(it, Date.now())
      const now = Date.now()
      await t.collection('order_items').doc(log.itemId).update({ data: { verifiedQty: Math.max(0, (it.verifiedQty || 0) - log.qty), codeActive: stillValid } })
      await t.collection('verify_logs').doc(log._id).update({ data: { undone: true, undoneBy: user._id, undoneAt: now } })
      await t.collection('verify_logs').doc(undoId).set({
        data: {
          type: 'undo', itemId: log.itemId, orderId: log.orderId, userId: log.userId || '', name: log.name, qty: log.qty,
          phone: log.phone, operatorId: user._id, operatorName: displayName(user), at: now, day: u.dateStr(now), undone: false
        }
      })
      return { log }
    })
  } catch (e) {
    if (e.business) return u.fail(e.message)
    throw e
  }
  if (!result.repeat) await ord.refreshStatus(db, result.log.orderId).catch(e => console.error('undo refreshStatus', e))
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
  const ids = res.data.filter(o => o.status === 'active' || o.status === 'completed').map(o => o._id)
  const refunding = new Set(ids.length
    ? (await db.collection('refunds').where({ orderId: _.in(ids), status: _.in(['pending', 'unknown']), kind: _.neq('timeout') }).limit(100).get()).data.map(r => r.orderId)
    : [])
  return u.ok({
    list: res.data.map(o => ({
      _id: o._id, created: `${u.dateStr(o.createdAt).slice(5)} ${hm(o.createdAt)}`, summary: o.summary, lines: o.lines || u.legacyLines(o.summary),
      totalFee: o.totalFee, statusText: statusText(o, refunding.has(o._id)), phone: o.deletedUser || o.phonePurged ? '已注销用户' : u.maskPhone(o.phone)
    })),
    more: res.data.length === 20
  })
}

function adminItemView(order, it, now) {
  const v = { _id: it._id, kind: it.kind, price: it.price, qty: it.qty, refundedFee: it.refundedFee || 0, refundable: ord.itemRefundable(it) }
  const paidish = ['active', 'completed'].includes(order.status)
  if (it.kind === 'court') {
    v.title = `${u.cnDate(it.date)} ${u.hourRange(it.hour)} ${it.court}号场`
    v.state = ord.courtFullyRefunded(it) ? '已退款' : it.refunding ? '退款中' : it.startAt + u.HOUR <= now ? '已使用' : it.startAt <= now ? '进行中' : '待使用'
    if (v.refundedFee > 0 && !ord.courtFullyRefunded(it)) v.state += ` · 已退 ${u.formatFen(v.refundedFee)}`
  } else if (it.kind === 'game') {
    v.title = `球局 · ${it.name}（${it.gender === 'F' ? '女' : '男'}）`
    const refunded = ord.courtFullyRefunded(it)
    v.state = refunded ? `${gops.OUT_REASON[it.gameOut] || '已退出'} · 已退款` : it.refunding ? '退款中' : it.endAt <= now ? '已结束' : '已报名'
  } else {
    v.title = `${it.name} ×${it.qty}`
    v.available = ord.productAvailable(it)
    const parts = []
    if (v.available > 0) parts.push(`未使用 ${v.available}`)
    if (it.refunding && it.refundingQty) parts.push(`退款中 ${it.refundingQty}`)
    if (it.verifiedQty) parts.push(`已核销 ${it.verifiedQty}`)
    if (it.refundedQty) parts.push(`已退款 ${it.refundedQty}`)
    if (it.expiredQty) parts.push(`已过期 ${it.expiredQty}`)
    v.state = parts.join(' · ') || (it.refunding ? '退款中' : '')
  }
  // 管理端退款不受開場前 15 分鐘限制
  v.canRefund = paidish && v.refundable > 0 && !it.refunding
  return v
}

async function adminOrderDetail(orderId) {
  const order = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
  if (!order) return u.fail('订单不存在')
  const items = (await ord.getItems(db, orderId)).sort((a, b) => (a._id < b._id ? -1 : 1))
  const refunds = await db.collection('refunds').where({ orderId, status: _.in(['success', 'pending', 'unknown']) }).orderBy('at', 'asc').get()
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
      _id: order._id, statusText: statusText(order, items.some(it => it.refunding)), totalFee: order.totalFee, refundedFee: order.refundedFee || 0,
      created: `${u.dateStr(order.createdAt)} ${hm(order.createdAt)}`,
      phone: order.deletedUser || order.phonePurged ? '已注销用户' : u.maskPhone(order.phone), hasPhone: !!order.phone && !order.deletedUser,
      refundWarn: (order.refundCount || 0) >= 45 ? `此订单剩余退款次数 ${left} 次，请合并退款` : ''
    },
    items: items.map(it => adminItemView(order, it, now)),
    refunds: refunds.data.map(r => ({
      time: `${u.dateStr(r.at).slice(5)} ${hm(r.at)}`, amount: r.amount,
      by: r.by === 'system' ? '系统' : operators[r.operatorId] || (r.by === 'customer' ? '客人' : ''),
      reason: (r.status === 'success' ? '' : '处理中 ') + (r.reason || '')
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
    const qty = it.kind === 'product' ? Math.floor(Number(p.qty) || 0) : 1
    if (!(qty >= 0)) return u.fail('退款张数有误')
    if (it.kind === 'product' && qty > ord.productAvailable(it)) return u.fail('退款张数超过未使用张数')
    clean.push({ itemId: it._id, qty, amount })
  }
  let r
  try {
    r = await ord.refundItems(cloud, db, { order, parts: clean, operatorId: user._id, by: 'admin', reason: '' })
  } catch (e) {
    if (e.business) return u.fail(e.message)
    throw e
  }
  await audit(user, 'refund', { orderId, amount: r.amount })
  return u.ok({ amount: r.amount, processing: r.processing })
}

// ======================= 球局（澄清 N 節） =======================

const GAME_TAGS = 4

async function loadGame(user, id) {
  const g = await ord.dget(db, 'games', String(id || ''))
  if (!g) return { err: u.fail('球局不存在') }
  if (user.role === 'host' && g.hostId !== user._id) return { err: u.fail('只能管理自己发起的球局', 'FORBIDDEN') }
  return { g }
}

function cleanTags(tags) {
  return (Array.isArray(tags) ? tags : String(tags || '').split(/[,，、\s]+/))
    .map(t => String(t).trim().slice(0, 8)).filter(Boolean).slice(0, GAME_TAGS)
}

function optInt(v) {
  if (v === '' || v === undefined || v === null) return 0
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

// 必填項一次全部列出（澄清 N16）
function gameMissing(g) {
  const miss = []
  if (!Array.isArray(g.cells) || !g.cells.length) miss.push('场地')
  if (!String(g.title || '').trim()) miss.push('标题')
  if (!String(g.desc || '').trim()) miss.push('详情说明')
  if (!(Math.round(g.priceM) > 0)) miss.push('男价格')
  if (!(Math.round(g.priceF) > 0)) miss.push('女价格')
  return miss
}

async function gamePublish(user, g) {
  const miss = gameMissing(g)
  if (miss.length) return u.fail(`还有必填项没填：${miss.join('、')}`, 'MISSING', { missing: miss })
  const date = String(g.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return u.fail('请选择日期')
  const cap = optInt(g.cap)
  const capM = optInt(g.capM)
  const capF = optInt(g.capF)
  const minPlayers = optInt(g.minPlayers)
  if ([cap, capM, capF, minPlayers].some(Number.isNaN)) return u.fail('人数请填写整数')
  if (cap && minPlayers > cap) return u.fail('最少人数不能大于总人数上限')
  const seen = new Set()
  const cells = []
  for (const c of g.cells) {
    const court = Number(c && c.court)
    const hour = Number(c && c.hour)
    if (!u.COURTS.includes(court) || !Number.isInteger(hour) || hour < 0 || hour > 23) return u.fail('格子有误')
    const k = `${court}_${hour}`
    if (seen.has(k)) continue
    seen.add(k)
    cells.push({ court, hour })
  }
  if (cells.length > 30) return u.fail('一场球局最多锁 30 格')
  const hours = [...new Set(cells.map(c => c.hour))].sort((a, b) => a - b)
  if (hours[hours.length - 1] - hours[0] + 1 !== hours.length) return u.fail('所选时段要连续')
  const now = Date.now()
  const cfg = await cal.loadConfig(db)
  if (!cal.bookableDays(cfg, now).includes(date)) return u.fail('该日期不可预订')
  const h = cal.hoursFor(cfg, date)
  if (!h || hours[0] < h.open || hours[hours.length - 1] >= h.close) return u.fail('所选时段不在营业时间内')
  if (u.slotStart(date, hours[0]) <= now) return u.fail('所选时段已开始')

  // 已過期的待支付佔用：先查單關單（與下單相同），確認沒付款才能鎖
  const lockIds = cells.map(c => u.slotId(date, c.court, c.hour))
  const res = await db.collection('slot_locks').where({ _id: _.in(lockIds) }).get()
  for (const orderId of [...new Set(res.data.filter(l => l.status === 'pending' && l.expiresAt < now).map(l => l.orderId))]) {
    const o = await ord.dget(db, 'orders', orderId)
    if (o) await ord.settle(cloud, db, o)
  }
  const dayLock = await ord.dget(db, 'locks', `day_${date}`)
  const hoursVer = (dayLock && dayLock.hoursVer) || 0

  const game = {
    title: String(g.title).trim().slice(0, 40), cover: typeof g.cover === 'string' && g.cover.startsWith('cloud://') ? g.cover : '',
    tags: cleanTags(g.tags), desc: String(g.desc).trim().slice(0, 1000), date, cells,
    startHour: hours[0], endHour: hours[hours.length - 1] + 1,
    startAt: u.slotStart(date, hours[0]), endAt: u.slotStart(date, hours[hours.length - 1] + 1),
    priceM: Math.round(g.priceM), priceF: Math.round(g.priceF), cap, capM, capF, minPlayers,
    status: 'open', hostId: user._id, hostName: displayName(user), roster: [], views: 0, createdAt: now
  }
  let id = u.newId('G', 6)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ord.tx(db, async t => {
        if (await ord.tget(t, 'games', id)) return ord.rollbackWith(t, 'ID_TAKEN', '编号冲突')
        const day = await ord.tget(t, 'locks', `day_${date}`)
        if (((day && day.hoursVer) || 0) !== hoursVer) return ord.rollbackWith(t, 'TAKEN', '营业时间已调整，请刷新后重试')
        for (const lid of lockIds) {
          if (await ord.tget(t, 'slot_locks', lid)) return ord.rollbackWith(t, 'TAKEN', '部分格子刚被订走，请重新选择')
        }
        // 改寫日期鎖：和同時進行的「改營業時間」互斥（澄清 K2）
        await t.collection('locks').doc(`day_${date}`).set({ data: { hoursVer, n: ((day && day.n) || 0) + 1, at: now } })
        for (const c of cells) {
          await t.collection('slot_locks').doc(u.slotId(date, c.court, c.hour)).set({ data: { date, court: c.court, hour: c.hour, status: 'game', gameId: id, orderId: '' } })
        }
        await t.collection('games').doc(id).set({ data: game })
      })
      break
    } catch (e) {
      if (e.business && e.code === 'ID_TAKEN') {
        id = u.newId('G', 6)
        continue
      }
      if (e.business) return u.fail(e.message, e.code)
      throw e
    }
  }
  await audit(user, 'game_publish', { id, date, cells: cells.length })
  return u.ok({ _id: id })
}

function adminGameCard(g, now) {
  const c = games.counts(g, now)
  const status = g.status === 'cancelled' ? '已取消' : g.endAt <= now ? '已结束' : g.startAt <= now ? '进行中' : '报名中'
  return {
    _id: g._id, title: g.title, when: `${u.dateLabel(g.date)} ${u.pad(g.startHour)}:00–${u.pad(g.endHour)}:00`, courtsText: gops.cellsText(g),
    count: `已报 ${c.joined}${g.cap ? `/${g.cap}` : ''}（${c.M}男${c.F}女）${c.waiting ? ` · 候补 ${c.waiting}` : ''}`,
    host: g.hostName || '', status
  }
}

async function gameList(user, tab) {
  const now = Date.now()
  const base = user.role === 'host' ? { hostId: user._id } : {}
  const where = tab === 'ended'
    ? _.and([base, _.or([{ status: 'cancelled' }, { endAt: _.lte(now) }])])
    : { ...base, status: 'open', endAt: _.gt(now) }
  const res = await db.collection('games').where(where).orderBy('startAt', tab === 'ended' ? 'desc' : 'asc').limit(50).get()
  return u.ok(res.data.map(g => adminGameCard(g, now)))
}

async function gameGet(user, id) {
  const { g, err } = await loadGame(user, id)
  if (err) return err
  const now = Date.now()
  const c = games.counts(g, now)
  const paidItems = await db.collection('order_items').where({ gameId: g._id, kind: 'game', status: _.in(['active', 'used']) }).limit(1000).get()
  const income = paidItems.data.reduce((s, i) => s + i.price - (i.refundedFee || 0), 0)
  const wait = (g.roster || []).filter(p => p.state === 'w').sort((a, b) => a.at - b.at)
  const ids = (g.roster || []).map(p => p.userId)
  const people = {}
  for (let i = 0; i < ids.length; i += 100) {
    const r = await db.collection('users').where({ _id: _.in(ids.slice(i, i + 100)) }).limit(100).get()
    r.data.forEach(x => (people[x._id] = x))
  }
  const list = (g.roster || []).filter(p => games.live(p, now)).sort((a, b) => a.at - b.at).map(p => ({
    userId: p.userId, itemId: p.itemId, nick: (people[p.userId] && people[p.userId].nickname) || '球友', avatar: (people[p.userId] && people[p.userId].avatar) || '', gender: p.gender,
    userGender: (people[p.userId] && people[p.userId].gender) || '',
    stateText: p.state === 'j' ? '已报名' : p.state === 'w' ? `候补第 ${wait.findIndex(x => x.userId === p.userId) + 1} 位` : '待支付',
    paid: p.state === 'j' || p.state === 'w', time: `${u.dateStr(p.at).slice(5)} ${hm(p.at)}`,
    price: p.gender === 'F' ? g.priceF : g.priceM
  }))
  return u.ok({
    ...adminGameCard(g, now), cover: g.cover || '', tags: g.tags || [], desc: g.desc || '', priceM: g.priceM, priceF: g.priceF,
    cap: g.cap || 0, capM: g.capM || 0, capF: g.capF || 0, minPlayers: g.minPlayers || 0,
    joined: c.joined, M: c.M, F: c.F, waiting: c.waiting, income, list,
    canCancel: g.status === 'open' && g.startAt > now, canKick: g.status === 'open' && g.endAt > now,
    canEditGender: user.role !== 'host'
  })
}

async function gameUpdate(user, id, p) {
  const { g, err } = await loadGame(user, id)
  if (err) return err
  const miss = []
  if (!String(p.title || '').trim()) miss.push('标题')
  if (!String(p.desc || '').trim()) miss.push('详情说明')
  if (miss.length) return u.fail(`还有必填项没填：${miss.join('、')}`, 'MISSING', { missing: miss })
  const data = {
    title: String(p.title).trim().slice(0, 40), desc: String(p.desc).trim().slice(0, 1000), tags: cleanTags(p.tags),
    cover: typeof p.cover === 'string' && p.cover.startsWith('cloud://') ? p.cover : ''
  }
  await db.collection('games').doc(g._id).update({ data })
  await audit(user, 'game_update', { id: g._id })
  return u.ok(true)
}

async function gameKick(user, id, itemId) {
  const { g, err } = await loadGame(user, id)
  if (err) return err
  if (g.status !== 'open' || g.endAt <= Date.now()) return u.fail('球局已结束或已取消')
  const r = await gops.kick(cloud, db, g, String(itemId || ''), user)
  if (r.ok) await audit(user, 'game_kick', { id: g._id, itemId })
  return r
}

async function gameCancel(user, id) {
  const { g, err } = await loadGame(user, id)
  if (err) return err
  try {
    await gops.cancelGame(cloud, db, g._id, { by: 'admin', operatorId: user._id, reason: `${displayName(user)} 取消` })
  } catch (e) {
    if (e.business) return u.fail(e.message)
    throw e
  }
  await audit(user, 'game_cancel', { id: g._id })
  return u.ok(true)
}

// 店員改客人性別：只影響之後的報名（澄清 N7）
async function setGender(user, userId, gender) {
  if (gender !== 'M' && gender !== 'F') return u.fail('性别有误')
  const res = await db.collection('users').where({ _id: String(userId || '') }).update({ data: { gender } })
  if (!res.stats.updated) return u.fail('客人不存在')
  await audit(user, 'set_gender', { userId, gender })
  return u.ok(true)
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
      return { s: l.status === 'locked' ? 'locked' : l.status === 'pending' ? 'pending' : l.status === 'game' ? 'game' : 'booked' }
    }))
  }
  return u.ok(out)
}

async function setLocks(user, date, cells, lock) {
  if (!Array.isArray(cells) || !cells.length) return u.fail('请先选择格子')
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return u.fail('日期有误')
  if (cells.some(c => !c || !u.COURTS.includes(Number(c.court)) || !Number.isInteger(Number(c.hour)) || c.hour < 0 || c.hour > 23)) return u.fail('格子有误')
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
        const l = await ord.tget(t, 'slot_locks', id)
        if (l && l.status === 'locked') return null
        if (l && l.status === 'game') return '该时段已被球局锁定'
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
  const stock = Number(p.stock)
  if (!Number.isInteger(stock) || stock < 0) return u.fail('请填写正确的库存')
  const images = (p.images || []).filter(x => typeof x === 'string' && x.startsWith('cloud://')).slice(0, 6)
  if (!images.length) return u.fail('请至少上传一张图片')
  const data = { name, price, images, desc: String(p.desc || '').slice(0, 2000), fixedDate: !!p.fixedDate, onShelf: !!p.onShelf, updatedAt: Date.now() }
  if (data.fixedDate) {
    const t = parseHm(p.activityStartTime)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.activityDate || '') || !t) return u.fail('固定日期活动需填写活动日期和开始时间')
    data.activityDate = p.activityDate
    data.activityStartAt = u.dayStart(p.activityDate) + t.h * u.HOUR + t.mi * 60000
    // 活動開始時間不能早於現在（澄清 L6）；編輯已開始的活動、沒改開始時間的可以保存
    if (data.activityStartAt < minuteNow()) {
      const old = p._id ? await ord.dget(db, 'products', String(p._id)) : null
      if (!old || !old.fixedDate || old.activityStartAt !== data.activityStartAt) return u.fail('活动开始时间不能早于现在')
    }
  } else {
    data.activityDate = ''
    data.activityStartAt = 0
  }
  if (p._id) {
    // 庫存按「打開編輯頁時的庫存 → 保存時填的庫存」的增減量計算，編輯期間賣出的不會被加回來。
    // 每次打開編輯頁帶一個操作編號 opId：同一個編號重送（連按、網絡重試）只調整一次庫存
    const from = Number(p.stockFrom)
    const delta = Number.isInteger(from) ? stock - from : 0
    const opId = typeof p.opId === 'string' ? p.opId.slice(0, 40) : ''
    if (delta !== 0 && !opId) return u.fail('请重新打开编辑页再保存')
    try {
      await ord.tx(db, async t => {
        const cur = await ord.tget(t, 'products', String(p._id))
        if (!cur) return ord.rollbackWith(t, 'BAD', '商品不存在')
        const ops = Array.isArray(cur.stockOps) ? cur.stockOps : []
        const done = opId && ops.find(o => o.id === opId)
        if (done && done.delta !== delta) return ord.rollbackWith(t, 'BAD', '库存已按上次保存调整过，请重新打开编辑页再修改')
        const next = done ? cur.stock || 0 : (cur.stock || 0) + delta
        if (next < 0) return ord.rollbackWith(t, 'BAD', `库存已被买走，当前仅剩 ${cur.stock}，请重新填写`)
        const stockOps = done || !opId ? ops : ops.concat([{ id: opId, delta, at: Date.now() }]).slice(-20)
        await t.collection('products').doc(cur._id).update({ data: { ...data, stock: next, stockOps } })
      })
    } catch (e) {
      if (e.business) return u.fail(e.message)
      throw e
    }
    await audit(user, 'product_update', { id: p._id, price, stockDelta: delta })
    return u.ok({ _id: p._id })
  }
  const res = await db.collection('products').add({ data: { ...data, stock, sort: 0, soldCount: 0, createdAt: Date.now() } })
  await audit(user, 'product_create', { id: res._id })
  return u.ok({ _id: res._id })
}

// 刪除商品（澄清 K5、L4）：有人買過也可以刪除。已購券自帶名稱、價格、活動日期，
// 核銷、退款、過期自動退款都不依賴商品記錄（退款時商品不在就跳過加回庫存）。
// 刪除在事務裡做：下單事務會改寫同一個商品（扣庫存），兩者互斥——
// 刪除先完成，同時結算的訂單整單失敗；購買先完成，刪除照常成功，剛賣出的券照常可用。
// 商品圖片不刪，訂單裡仍可顯示
async function productDelete(user, id) {
  let sold = 0
  try {
    await ord.tx(db, async t => {
      const p = await ord.tget(t, 'products', String(id || ''))
      if (!p) return ord.rollbackWith(t, 'BAD', '商品不存在')
      sold = p.soldCount || 0
      await t.collection('products').doc(p._id).remove()
    })
  } catch (e) {
    if (e.business) return u.fail(e.message)
    throw e
  }
  await audit(user, 'product_delete', { id, sold })
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

// 橫幅的顯示區間：長期橫幅從現在起一直顯示；限時橫幅按開始、結束時間
function bannerSpan(b, now) {
  return b.mode === 'timed' ? [Math.max(b.startAt, now), b.endAt] : [now, Infinity]
}

// 加入 b 之後，任何一個時刻同時顯示的橫幅是否會超過 5 張（澄清 K10）
async function bannerOverLimit(b, now) {
  if (!bannerShowing(b, now)) return null
  const [s, e] = bannerSpan(b, now)
  const others = (await db.collection('banners').where({ enabled: true }).limit(100).get()).data
    .filter(x => x._id !== b._id && bannerShowing(x, now))
    .map(x => bannerSpan(x, now))
    .filter(([xs, xe]) => xs < e && s < xe)
  // 最多同時顯示的時刻一定出現在某張橫幅開始的那一刻
  const points = [s, ...others.map(([xs]) => xs).filter(x => x >= s && x < e)]
  for (const p of points) {
    if (others.filter(([xs, xe]) => xs <= p && p < xe).length >= 5) return u.fail('该时段已有 5 张横幅同时显示，请先下架一张或调整时间')
  }
  return null
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

// 「現在」所在那一分鐘的開始：時間精確到分鐘，同一分鐘內選的時間算現在（澄清 L6）
function minuteNow() {
  return Math.floor(Date.now() / 60000) * 60000
}

async function bannerSave(user, b) {
  if (!b.image || !String(b.image).startsWith('cloud://')) return u.fail('请上传横幅图片')
  const old = b._id ? await ord.dget(db, 'banners', String(b._id)) : null
  const data = { image: b.image, enabled: b.enabled !== false, mode: b.mode === 'timed' ? 'timed' : 'long', updatedAt: Date.now() }
  const tt = b.target || {}
  data.target = tt.type === 'product' ? { type: 'product', productId: tt.productId } : tt.type === 'activity' ? { type: 'activity' } : tt.type === 'booking' ? { type: 'booking', date: tt.date || '' } : { type: 'none' }
  if (data.target.type === 'product' && !data.target.productId) return u.fail('请选择跳转的商品')
  if (data.target.type === 'booking' && data.target.date && data.target.date < u.dateStr(Date.now())) return u.fail('跳转的订场日期不能早于今天')
  if (data.mode === 'timed') {
    const s = parseHm(b.startTime)
    const e = parseHm(b.endTime)
    if (!b.startDate || !b.endDate || !s || !e) return u.fail('请填写开始和结束时间')
    data.startAt = u.dayStart(b.startDate) + s.h * u.HOUR + s.mi * 60000
    data.endAt = u.dayStart(b.endDate) + e.h * u.HOUR + e.mi * 60000
    if (data.endAt <= data.startAt) return u.fail('结束时间要晚于开始时间')
    // 不能選已經過去的時間（澄清 L6）；編輯已開始的橫幅、沒改開始時間的可以保存
    if (data.endAt <= Date.now()) return u.fail('结束时间已过，请重新选择')
    const keepStart = old && old.mode === 'timed' && old.startAt === data.startAt
    if (data.startAt < minuteNow() && !keepStart) return u.fail('开始时间不能早于现在')
  } else {
    data.startAt = 0
    data.endAt = 0
  }
  let full = null
  if (!b._id) {
    const last = await db.collection('banners').orderBy('sort', 'desc').limit(1).get()
    full = { ...data, sort: last.data.length ? last.data[0].sort + 1 : 0, createdAt: Date.now() }
  }
  const id = b._id || u.newId('BN')
  const bad = await withVersionLock('banners', () => bannerOverLimit({ ...data, _id: b._id }, Date.now()),
    t => (b._id ? t.collection('banners').doc(id).update({ data }) : t.collection('banners').doc(id).set({ data: full })))
  if (bad) return bad
  await audit(user, 'banner_save', { id: b._id || 'new' })
  return u.ok(true)
}

async function bannerToggle(user, id, enabled) {
  const b = (await db.collection('banners').doc(id).get()).data
  if (!enabled) {
    await db.collection('banners').doc(id).update({ data: { enabled: false } })
    return u.ok(true)
  }
  const bad = await withVersionLock('banners', () => bannerOverLimit({ ...b, enabled: true }, Date.now()),
    t => t.collection('banners').doc(id).update({ data: { enabled: true } }))
  return bad || u.ok(true)
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
    regular: { weekday: current.weekday, weekend: current.weekend, slots: current.slots || [], effectiveFrom: current.effectiveFrom || '' },
    scheduled: scheduled.map(r => ({ _id: r._id, weekday: r.weekday, weekend: r.weekend, slots: r.slots || [], effectiveFrom: r.effectiveFrom })),
    daily: all.filter(r => r.lastDate >= today).sort((a, b) => (a.dates[0] < b.dates[0] ? -1 : 1)).map(view),
    expired: all.filter(r => r.lastDate < today).sort((a, b) => (a.lastDate > b.lastDate ? -1 : 1)).slice(0, 50).map(view)
  })
}

async function saveRegular(user, { weekday, weekend, effectiveFrom, slots }) {
  weekday = Math.round(weekday)
  weekend = Math.round(weekend)
  if (!(weekday > 0 && weekend > 0)) return u.fail('请填写正确的价格')
  // 分时段价格：每段「开始—结束」整点，平日价和周末价；时段之间不能重叠
  const list = []
  for (const s of Array.isArray(slots) ? slots : []) {
    const startHour = Math.floor(s.startHour)
    const endHour = Math.floor(s.endHour)
    const wd = Math.round(s.weekday)
    const we = Math.round(s.weekend)
    if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) return u.fail('时段的开始时间要早于结束时间')
    if (!(wd > 0 && we > 0)) return u.fail('请填写每个时段的平日价和周末价')
    list.push({ startHour, endHour, weekday: wd, weekend: we })
  }
  if (list.length > 24) return u.fail('时段最多 24 段')
  list.sort((x, y) => x.startHour - y.startHour)
  for (let i = 1; i < list.length; i++) {
    if (list[i].startHour < list[i - 1].endHour) {
      return u.fail(`${u.pad(list[i - 1].startHour)}:00–${u.pad(list[i - 1].endHour)}:00 和 ${u.pad(list[i].startHour)}:00–${u.pad(list[i].endHour)}:00 的时段重叠了`)
    }
  }
  slots = list
  const today = u.dateStr(Date.now())
  const from = effectiveFrom && effectiveFrom > today ? effectiveFrom : today
  let id
  const bad = await withVersionLock('prices', async () => {
    const same = await db.collection('prices').where({ type: 'regular', effectiveFrom: from }).get()
    id = same.data.length ? same.data[0]._id : ''
    return null
  }, t => (id
    ? t.collection('prices').doc(id).update({ data: { weekday, weekend, slots, updatedAt: Date.now() } })
    : t.collection('prices').doc(u.newId('PR')).set({ data: { type: 'regular', weekday, weekend, slots, effectiveFrom: from, createdAt: Date.now() } })))
  if (bad) return bad
  await audit(user, 'price_regular', { weekday, weekend, slots, from })
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
  // 單日價格之間不能重疊；檢查和保存用「價格鎖」保護，同時保存兩筆重疊的只會有一筆成功（澄清 K6）
  const check = async () => {
    const others = (await cal.getAll(db.collection('prices'), { type: 'daily', lastDate: _.gte(dates[0]) })).filter(x => x._id !== r._id)
    for (const o of others) {
      const shareDate = o.dates.some(d => dates.includes(d))
      const shareCourt = o.courts.some(c => courts.includes(c))
      const shareHour = o.startHour < endHour && startHour < o.endHour
      if (shareDate && shareCourt && shareHour) {
        return u.fail(`与已有单日价格冲突：${u.cnDate(o.dates[0])} ${u.pad(o.startHour)}:00–${u.pad(o.endHour)}:00`, 'CONFLICT', { conflictId: o._id })
      }
    }
    return null
  }
  const data = { type: 'daily', dates, lastDate: dates[dates.length - 1], startHour, endHour, courts, price, updatedAt: Date.now() }
  const bad = await withVersionLock('prices', check, t => (r._id
    ? t.collection('prices').doc(r._id).update({ data })
    : t.collection('prices').doc(u.newId('PR')).set({ data: { ...data, createdAt: Date.now() } })))
  if (bad) return bad
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
  const locks = await cal.getAll(db.collection('slot_locks'), { date: dates[0], status: _.in(['booked', 'pending', 'game']) })
  return locks
    .filter(l => (l.status !== 'pending' || l.expiresAt > now) && (open === null || l.hour < open || l.hour >= close))
    .map(l => `${u.cnDate(l.date)} ${u.hourRange(l.hour)} ${l.court}号场`)
}

// 改營業時間與下單互斥（澄清 K2）：在事務裡改寫受影響日期的「日期鎖」並把營業時間版本加一，
// 同時寫入營業時間記錄（write(t) 負責）。下單事務會確認版本沒變並改寫同一把鎖，兩邊只有一邊能成功
async function writeHours(dates, write) {
  await ord.tx(db, async t => {
    const cur = {}
    for (const d of dates) cur[d] = await ord.tget(t, 'locks', `day_${d}`)
    for (const d of dates) {
      const l = cur[d] || {}
      await t.collection('locks').doc(`day_${d}`).set({ data: { hoursVer: (l.hoursVer || 0) + 1, n: l.n || 0, at: Date.now() } })
    }
    await write(t)
  })
}

// 營業時間記錄寫回原樣（old 為 null 代表原本沒有這條記錄）
function restoreHours(t, id, old) {
  if (old) {
    const { _id, ...data } = old
    return t.collection('business_hours').doc(id).set({ data })
  }
  return t.collection('business_hours').doc(id).remove()
}

// 順序：先存新設定 → 再查訂單 → 有訂單落在新的休息時段就還原並提示（澄清 K2）
async function saveDailyHours(user, { open, close, effectiveFrom }) {
  open = Math.floor(open)
  close = Math.floor(close)
  if (!(open >= 0 && close <= 24 && close > open)) return u.fail('请填写正确的营业时间')
  const now = Date.now()
  const today = u.dateStr(now)
  const from = effectiveFrom && effectiveFrom > today ? effectiveFrom : today
  const cfg = await cal.loadConfig(db)
  const dates = cal.bookableDays(cfg, now).filter(d => d >= from)
  const same = await db.collection('business_hours').where({ type: 'daily', effectiveFrom: from }).get()
  const old = same.data[0] || null
  const id = old ? old._id : u.newId('BH')
  const data = { type: 'daily', open, close, effectiveFrom: from, createdAt: old ? old.createdAt || now : now, updatedAt: now }
  await writeHours(dates, t => t.collection('business_hours').doc(id).set({ data }))
  // 只檢查沒有特殊日期覆蓋的日子
  const list = await ordersOutsideRange(from, open, close, cfg)
  if (list.length) {
    await writeHours(dates, t => restoreHours(t, id, old))
    return u.fail('以下时段已有订单，请先处理', 'HAS_ORDERS', { orders: list.slice(0, 30) })
  }
  await audit(user, 'hours_daily', { open, close, from })
  return u.ok(true)
}

async function ordersOutsideRange(from, open, close, cfg) {
  const now = Date.now()
  const locks = await cal.getAll(db.collection('slot_locks'), { date: _.gte(from), status: _.in(['booked', 'pending', 'game']) })
  return locks
    .filter(l => !cfg.special[l.date])
    .filter(l => (l.status !== 'pending' || l.expiresAt > now) && (l.hour < open || l.hour >= close))
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
  const same = await db.collection('business_hours').where({ type: 'special', date }).get()
  const old = same.data[0] || null
  const id = old ? old._id : `special_${date}`
  const data = { type: 'special', date, closed, open: closed ? 0 : open, close: closed ? 0 : close, updatedAt: Date.now() }
  await writeHours([date], t => t.collection('business_hours').doc(id).set({ data }))
  const list = await ordersOutside([date], closed ? null : open, close)
  if (list.length) {
    await writeHours([date], t => restoreHours(t, id, old))
    return u.fail('以下时段已有订单，请先处理', 'HAS_ORDERS', { orders: list.slice(0, 30) })
  }
  await audit(user, 'hours_special', { date, closed })
  return u.ok(true)
}

async function deleteSpecial(user, id) {
  const sp = (await db.collection('business_hours').doc(id).get().catch(() => ({ data: null }))).data
  if (!sp) return u.ok(true)
  const cfg = await cal.loadConfig(db)
  const normal = cal.hoursFor({ ...cfg, special: {} }, sp.date)
  await writeHours([sp.date], t => t.collection('business_hours').doc(id).remove())
  const list = await ordersOutside([sp.date], normal ? normal.open : null, normal ? normal.close : 0)
  if (list.length) {
    await writeHours([sp.date], t => restoreHours(t, id, sp))
    return u.fail('以下时段已有订单，请先处理', 'HAS_ORDERS', { orders: list.slice(0, 30) })
  }
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
  // 退款按「微信受理、系統記帳」那天（doneAt）歸日；舊記錄沒有 doneAt 才用申請時間 at（澄清 H7）
  const inRange = _.gte(start).and(_.lt(end))
  const refunds = (await cal.getAll(db.collection('refunds'), _.and([
    { status: 'success' },
    _.or([{ doneAt: inRange }, { doneAt: _.exists(false), at: inRange }])
  ])))
    .filter(r => r.kind !== 'timeout' && (r.by !== 'system' || r.reason !== '超时付款自动退款'))

  const rows = {}
  const row = k => (rows[k] = rows[k] || { period: k, court: 0, product: 0, refund: 0 })
  for (const it of items) {
    const r = row(periodKey(payTimeOf[it.orderId], mode))
    if (it.kind === 'court') r.court += it.price
    else r.product += it.price * it.qty
  }
  for (const rf of refunds) row(periodKey(rf.doneAt || rf.at, mode)).refund += rf.amount

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
    if (user && user.role === 'host') {
      if (!HOST_ACTIONS.includes(event.action)) return u.fail('无权限', 'FORBIDDEN')
    } else if (!isAdmin(user)) return u.fail('无权限', 'FORBIDDEN')
    if (OWNER_ONLY.includes(event.action) && !isOwner(user)) return u.fail('只有老板可以操作', 'FORBIDDEN')

    switch (event.action) {
      case 'me':
        return u.ok({ role: user.role, name: displayName(user) })
      case 'badges':
        if (user.role === 'host') return u.ok({ orders: 0 })
        return await badges(user)

      case 'gameList':
        return await gameList(user, event.tab)
      case 'gameGet':
        return await gameGet(user, event.id)
      case 'gamePublish':
        return await gamePublish(user, event.game || {})
      case 'gameUpdate':
        return await gameUpdate(user, event.id, event.game || {})
      case 'gameKick':
        return await gameKick(user, event.id, event.itemId)
      case 'gameCancel':
        return await gameCancel(user, event.id)
      case 'setGender':
        return await setGender(user, event.userId, event.gender)
      case 'markSeen':
        await db.collection('users').doc(user._id).update({ data: { noticeSeenAt: Date.now() } })
        return u.ok(true)

      case 'verifyLookup':
        return await verifyLookup(event.code)
      case 'verifyConfirm':
        return await verifyConfirm(user, event.itemId, event.qty, event.reqId)
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
