// 訂單核心邏輯：付款確認、到期關單、取消、逾期退款、卡片退款、狀態計算、通知
// 對應：立項書「訂單關閉的定義」「超時付款的處理」、技術方案「關鍵機制 2–4」
//
// 並發原則（2026-11-04 依 Codex 檢查報告修正）：
// 1. 所有狀態轉換（付款成立、關單、取消、退款、核銷）都在數據庫事務裡「重新讀取最新狀態」再決定，
//    兩個請求同時到達時只有一個能轉換成功，另一個看到新狀態後什麼都不做。
// 2. 事務裡先全部讀取、再全部寫入，寫入一律用絕對值（不用 _.inc），讀不到文檔才當作不存在，其他錯誤直接拋出。
// 3. 釋放場地只釋放「仍屬於本訂單」的車位牌，絕不刪掉別人的。
// 4. 退款先在事務裡「預留」（固定退款單號、卡片標記退款中、退款次數 +1），再向微信申請；
//    結果不明時保留預留，由定時任務用同一個退款單號重試，微信保證同一單號只退一次。
// 5. 退款單號用只增不減的 refundSeq 產生；refundCount 只用來控制 50 次上限，失敗可還回（澄清 H1）。
const https = require('https')
const u = require('./util')
const pay = require('./pay')
const games = require('./games')

const FINAL = ['cancelled', 'closed', 'timeout_refunded']
const MAX_REFUNDS = 50

// ---------- 數據庫小工具 ----------

function isNotFound(e) {
  const msg = String((e && (e.errMsg || e.message)) || e || '')
  return /not exist|not found|cannot find|-502005|DATABASE_DOCUMENT_NOT_EXIST/i.test(msg)
}

// 事務內讀取單個文檔：不存在返回 null，其他錯誤拋出
async function tget(t, coll, id) {
  try {
    const r = await t.collection(coll).doc(id).get()
    return r.data || null
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

// 事務外讀取單個文檔
async function dget(db, coll, id) {
  try {
    const r = await db.collection(coll).doc(id).get()
    return r.data || null
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

// 事務裡拋出的業務錯誤（rollback 後由調用方顯示給客人）
function rollbackWith(t, code, message, extra) {
  return t.rollback({ code, message, ...(extra || {}) })
}

// 把 runTransaction 的 rollback 結果統一變成錯誤
async function tx(db, fn) {
  try {
    return await db.runTransaction(fn, 3)
  } catch (e) {
    if (e && e.code && e.message && !e.errCode) {
      const err = new Error(e.message)
      Object.assign(err, e)
      err.business = true
      throw err
    }
    throw e
  }
}

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
  try {
    await db.collection('notices').add({ data: { type, text, orderId: orderId || '', at: Date.now() } })
    const hook = process.env.WECOM_WEBHOOK
    if (hook) await postJson(hook, { msgtype: 'text', text: { content: text } })
  } catch (e) {
    console.error('notify', e)
  }
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

// ---------- 讀取與計算 ----------

async function getItems(db, orderId) {
  const res = await db.collection('order_items').where({ orderId }).limit(1000).get()
  return res.data
}

// 事務只能按 _id 讀取，所以訂單上要有完整的卡片編號清單 itemIds。
// 缺少清單時直接報錯阻止轉換，絕不把「讀不到卡片」當成「沒有卡片」。
// 舊結構兼容：訂單沒有 itemIds 時，先按 orderId 查出卡片補寫上去（事務外，可重複執行）
async function ensureItemIds(db, orderId) {
  const order = await dget(db, 'orders', orderId)
  if (!order || (Array.isArray(order.itemIds) && order.itemIds.length)) return order
  const items = await getItems(db, orderId)
  if (!items.length) return order // 仍然沒有：交給 txItems 報錯
  const itemIds = items.map(i => i._id).sort()
  await db.collection('orders').doc(orderId).update({ data: { itemIds } })
  return { ...order, itemIds }
}

async function txItems(t, order) {
  if (!Array.isArray(order.itemIds) || !order.itemIds.length) throw new Error(`订单 ${order._id} 缺少卡片清单，请先执行数据迁移`)
  const items = []
  for (const id of order.itemIds) {
    const it = await tget(t, 'order_items', id)
    if (it) items.push(it)
  }
  return items
}

// 還能退的金額（扣除已退和退款處理中的金額）
function itemRefundable(item) {
  return item.price * item.qty - (item.refundedFee || 0) - (item.refundingFee || 0)
}

// 還能使用的張數（扣除已核銷、已退、已過期、退款處理中的張數）
function productAvailable(item) {
  return item.qty - (item.verifiedQty || 0) - (item.refundedQty || 0) - (item.expiredQty || 0) - (item.refundingQty || 0)
}

function courtFullyRefunded(item) {
  return (item.refundedFee || 0) >= item.price
}

// 固定日期活動是否已過期（活動日期早於今天）
function productExpired(item, now) {
  return !!item.fixedDate && !!item.activityDate && item.activityDate < u.dateStr(now)
}

function computeStatus(order, items, now) {
  if (order.status === 'pending' || FINAL.includes(order.status)) return order.status
  if (!items.length) return order.status // 讀不到卡片時不改狀態
  // 場地和球局卡片按金額算「退完」；商品按張數
  const allRefunded = items.every(i => (i.kind === 'product' ? (i.refundedQty || 0) >= i.qty : courtFullyRefunded(i)))
  if (allRefunded) return 'refunded'
  const done = items.every(i =>
    i.kind === 'court' ? courtFullyRefunded(i) || i.startAt + u.HOUR <= now
      : i.kind === 'game' ? courtFullyRefunded(i) || (i.endAt <= now && !i.refunding && !i.gameOut)
        : productAvailable(i) <= 0 && !i.refunding
  )
  return done ? 'completed' : 'active'
}

// 重新計算訂單狀態（事務內讀取，避免覆蓋同時發生的退款結果）
async function refreshStatus(db, orderId) {
  await ensureItemIds(db, orderId)
  return tx(db, async t => {
    const order = await tget(t, 'orders', orderId)
    if (!order) return null
    const items = await txItems(t, order)
    const status = computeStatus(order, items, Date.now())
    if (status !== order.status) await t.collection('orders').doc(orderId).update({ data: { status } })
    return { ...order, status }
  })
}

// ---------- 釋放佔用（只在事務內調用；必須先讀後寫） ----------

// 讀取：返回之後要寫入的動作清單
async function planRelease(t, order, items) {
  const ops = []
  for (const it of items) {
    if (it.kind === 'court') {
      const id = u.slotId(it.date, it.court, it.hour)
      const lock = await tget(t, 'slot_locks', id)
      if (lock && lock.orderId === order._id) ops.push({ type: 'unlock', id })
    } else if (it.kind === 'game') {
      // 待支付的報名從名單移除，空出的名額補給候補
      const g = await tget(t, 'games', it.gameId)
      const p = g && (g.roster || []).find(x => x.itemId === it._id)
      if (p && (p.state === 'pj' || p.state === 'pw')) ops.push({ type: 'roster', id: g._id, roster: games.removeItem(g, it._id, Date.now()) })
    } else {
      const p = await tget(t, 'products', it.productId)
      if (p) ops.push({ type: 'stock', id: p._id, stock: (p.stock || 0) + it.qty, soldCount: Math.max(0, (p.soldCount || 0) - it.qty) })
      if (it.code) {
        const c = await tget(t, 'coupon_codes', it.code)
        if (c && c.itemId === it._id) ops.push({ type: 'uncode', id: it.code })
      }
    }
  }
  return ops
}

async function applyRelease(t, ops) {
  for (const op of ops) {
    if (op.type === 'unlock') await t.collection('slot_locks').doc(op.id).remove()
    else if (op.type === 'stock') await t.collection('products').doc(op.id).update({ data: { stock: op.stock, soldCount: op.soldCount } })
    else if (op.type === 'uncode') await t.collection('coupon_codes').doc(op.id).remove()
    else if (op.type === 'roster') await t.collection('games').doc(op.id).update({ data: { roster: op.roster } })
  }
}

// ---------- 待支付 → 關閉／取消（事務，只有仍是待支付時才轉換） ----------

async function closePending(db, orderId, status) {
  await ensureItemIds(db, orderId)
  return tx(db, async t => {
    const order = await tget(t, 'orders', orderId)
    if (!order) return null
    if (order.status !== 'pending') return order
    const items = await txItems(t, order)
    const ops = await planRelease(t, order, items)
    await applyRelease(t, ops)
    for (const it of items) await t.collection('order_items').doc(it._id).update({ data: { status, codeActive: false } })
    const data = { status, [status === 'closed' ? 'closedAt' : 'cancelledAt']: Date.now() }
    await t.collection('orders').doc(orderId).update({ data })
    return { ...order, ...data }
  })
}

// ---------- 付款確認（只能在向微信查單確認已付款後調用） ----------
// 返回最新訂單。付款在有效期內、且車位牌仍屬於本訂單 → 訂單成立；
// 否則（逾期付款、訂單已關閉／取消、場地已轉給別人）→ 全額退款，絕不復活已關閉的訂單
async function markPaid(cloud, db, orderId, payTime) {
  await ensureItemIds(db, orderId)
  const r = await tx(db, async t => {
    const order = await tget(t, 'orders', orderId)
    if (!order) return { action: 'none', order: null }
    if (['active', 'completed', 'refunded', 'timeout_refunded'].includes(order.status)) return { action: 'none', order }

    const items = await txItems(t, order)
    if (order.status === 'pending' && payTime && payTime <= order.expiresAt) {
      const locks = []
      let allOwned = true
      for (const it of items.filter(i => i.kind === 'court')) {
        const id = u.slotId(it.date, it.court, it.hour)
        const lock = await tget(t, 'slot_locks', id)
        if (!lock || lock.orderId !== order._id) allOwned = false
        else locks.push(lock)
      }
      // 球局報名：要仍在名單上、球局沒取消、還沒開始，才算成立
      const gameWrites = []
      for (const it of items.filter(i => i.kind === 'game')) {
        const g = await tget(t, 'games', it.gameId)
        const p = g && (g.roster || []).find(x => x.itemId === it._id)
        if (!g || g.status !== 'open' || g.startAt <= Date.now() || !p || (p.state !== 'pj' && p.state !== 'pw')) {
          allOwned = false
          continue
        }
        const roster = g.roster.map(x => (x.itemId === it._id ? { ...x, state: x.state === 'pj' ? 'j' : 'w', expiresAt: 0 } : x))
        gameWrites.push({ id: g._id, roster: games.promote({ ...g, roster }, Date.now()).roster })
      }
      if (allOwned) {
        for (const w of gameWrites) await t.collection('games').doc(w.id).update({ data: { roster: w.roster } })
        for (const l of locks) await t.collection('slot_locks').doc(l._id).update({ data: { status: 'booked' } })
        for (const it of items) await t.collection('order_items').doc(it._id).update({ data: { status: 'active' } })
        const data = { status: 'active', payTime }
        await t.collection('orders').doc(orderId).update({ data })
        return { action: 'paid', order: { ...order, ...data }, items }
      }
    }

    // 需要全額退款：還在待支付的先釋放（只釋放仍屬於本訂單的）
    if (order.status === 'pending') {
      const ops = await planRelease(t, order, items)
      await applyRelease(t, ops)
      for (const it of items) await t.collection('order_items').doc(it._id).update({ data: { status: 'closed', codeActive: false } })
    }
    const outRefundNo = `${order._id}T`
    const refund = {
      orderId: order._id, kind: 'timeout', amount: order.totalFee, parts: [], reason: '超时付款自动退款',
      by: 'system', operatorId: '', status: 'pending', attempts: 0, at: Date.now()
    }
    await t.collection('refunds').doc(outRefundNo).set({ data: refund })
    const data = { status: 'timeout_refunded', payTime: payTime || 0, timeoutRefundNo: outRefundNo, refundState: 'pending' }
    await t.collection('orders').doc(orderId).update({ data })
    return { action: 'refund', order: { ...order, ...data }, outRefundNo }
  })

  if (r.action === 'paid') {
    const order = r.order
    await db.collection('users').doc(order.userId).update({ data: { lastBookedAt: payTime } }).catch(() => {})
    const summary = r.items
      .map(i => (i.kind === 'court' ? `${u.cnDate(i.date)} ${u.hourRange(i.hour)} ${i.court}号场` : i.kind === 'game' ? `球局：${i.name}（${i.gender === 'F' ? '女' : '男'}）` : `${i.name} ×${i.qty}`))
      .join('；')
    await notify(db, 'order', `【新订单】${u.formatFen(order.totalFee)}\n${summary}\n客人：${u.maskPhone(order.phone)}\n订单号：${order._id}`, order._id)
    return order
  }
  if (r.action === 'refund') {
    await processRefund(cloud, db, r.outRefundNo).catch(e => console.error('timeout refund', e))
    return (await dget(db, 'orders', orderId)) || r.order
  }
  return r.order
}

// 向微信查單；確認已付款且金額一致才算付款
async function verifyPaid(cloud, order) {
  const q = await pay.queryOrder(cloud, order)
  if (!q.paid) return null
  if (q.totalFee !== order.totalFee) {
    console.error('amount mismatch', order._id, q.totalFee, order.totalFee)
    throw new Error('amount mismatch')
  }
  return q
}

// 查單 → 已付款就確認付款；返回最新訂單或 null（未付款）
async function confirmIfPaid(cloud, db, order) {
  const q = await verifyPaid(cloud, order)
  if (!q) return null
  return markPaid(cloud, db, order._id, q.payTime || Date.now())
}

// ---------- 到期處理：查單 → 關單 → 放出場地 ----------
// 返回最新訂單；聯絡不上微信時保持 pending 並帶 confirming 標記，場地繼續鎖住
async function settle(cloud, db, order) {
  if (order.status !== 'pending' || Date.now() < order.expiresAt) return order
  try {
    const paid = await confirmIfPaid(cloud, db, order)
    if (paid) return paid
    const closed = await pay.closeOrder(cloud, order)
    if (!closed) return { ...order, confirming: true }
    // 關單後再查一次，防止關單前一瞬間付款成功
    const paid2 = await confirmIfPaid(cloud, db, order)
    if (paid2) return paid2
    return (await closePending(db, order._id, 'closed')) || order
  } catch (e) {
    console.error('settle', order._id, e)
    return { ...order, confirming: true }
  }
}

// 待支付期間客人主動取消（訂單未滿 5 分鐘無法向微信關單；之後若仍收到錢，由三道防線自動全額退款）
async function cancelPending(cloud, db, order) {
  if (order.status !== 'pending') return order
  let paid = null
  try {
    paid = await confirmIfPaid(cloud, db, order)
  } catch (e) {
    console.error('cancel query', order._id, e)
  }
  if (paid) return paid
  return (await closePending(db, order._id, 'cancelled')) || order
}

// ---------- 退款 ----------

// 1. 預留（事務）：parts = [{ itemId, qty, amount }]；qty 為商品退的張數（場地填 1），amount 為退款金額（分）
// 舊訂單沒有退款流水號 refundSeq 時，從已有退款記錄的最大編號接著編（澄清 H1）
async function legacyRefundSeq(db, orderId) {
  const order = await dget(db, 'orders', orderId)
  if (!order || order.refundSeq !== undefined) return 0
  const res = await db.collection('refunds').where({ orderId }).limit(1000).get()
  let max = 0
  for (const r of res.data) {
    const m = String(r._id).slice(orderId.length).match(/^R(\d+)$/)
    if (m) max = Math.max(max, +m[1])
  }
  return max
}

async function reserveRefund(db, { orderId, parts, operatorId, by, reason, asExpired }) {
  await ensureItemIds(db, orderId)
  const legacySeq = await legacyRefundSeq(db, orderId)
  return tx(db, async t => {
    const order = await tget(t, 'orders', orderId)
    if (!order) return rollbackWith(t, 'NOT_FOUND', '订单不存在')
    if (!['active', 'completed'].includes(order.status)) return rollbackWith(t, 'BAD_STATUS', '该订单当前不能退款')
    const count = order.refundCount || 0
    if (count >= MAX_REFUNDS) return rollbackWith(t, 'TOO_MANY', '此订单已达微信退款次数上限，请联系球馆')
    // 退款單號用只增不減的流水號（不能用 refundCount：它在失敗時會還回去，會讓別人的單號被重用）
    let seq = Math.max(order.refundSeq || 0, legacySeq, order.refundSeq === undefined ? count : 0) + 1
    let outRefundNo = `${order._id}R${u.pad(seq)}`
    // 保險：單號已有記錄就往後找，絕不覆蓋已有的退款記錄
    for (let n = 0; await tget(t, 'refunds', outRefundNo); n++) {
      if (n >= 20) return rollbackWith(t, 'BUSY', '退款繁忙，请稍后再试')
      seq += 1
      outRefundNo = `${order._id}R${u.pad(seq)}`
    }

    const seen = new Set()
    const writes = []
    let total = 0
    for (const p of parts) {
      if (seen.has(p.itemId)) return rollbackWith(t, 'DUP', '退款项目重复')
      seen.add(p.itemId)
      const it = await tget(t, 'order_items', p.itemId)
      if (!it || it.orderId !== order._id) return rollbackWith(t, 'NOT_FOUND', '退款项目不存在')
      if (it.refunding) return rollbackWith(t, 'BUSY', '该项正在退款中，请稍后再试')
      const amount = Math.round(p.amount)
      if (!(amount > 0)) return rollbackWith(t, 'BAD_AMOUNT', '退款金额必须大于 0')
      if (amount > itemRefundable(it)) return rollbackWith(t, 'BAD_AMOUNT', '该项已退款或超出可退金额')
      let qty = 0
      if (it.kind === 'product') {
        qty = Math.floor(p.qty || 0)
        if (!(qty >= 0) || qty > productAvailable(it)) return rollbackWith(t, 'BAD_QTY', '可退张数不足')
      }
      writes.push({ id: it._id, data: { refunding: outRefundNo, refundingQty: qty, refundingFee: amount } })
      total += amount
    }
    if (!writes.length) return rollbackWith(t, 'EMPTY', '请选择要退款的项目')

    const refund = {
      orderId: order._id, kind: 'items', amount: total,
      parts: parts.map(p => ({ itemId: p.itemId, qty: Math.floor(p.qty || 0), amount: Math.round(p.amount) })),
      reason: reason || '', by, operatorId: operatorId || '', asExpired: !!asExpired,
      status: 'pending', attempts: 0, at: Date.now()
    }
    await t.collection('refunds').doc(outRefundNo).set({ data: refund })
    for (const w of writes) await t.collection('order_items').doc(w.id).update({ data: w.data })
    await t.collection('orders').doc(order._id).update({ data: { refundCount: count + 1, refundSeq: seq } })
    return { outRefundNo, amount: total, order }
  })
}

// 2. 微信已受理 → 結算（事務，可重複執行，只會生效一次）
async function finalizeRefund(db, outRefundNo) {
  return tx(db, async t => {
    const r = await tget(t, 'refunds', outRefundNo)
    if (!r || r.status === 'success' || r.status === 'failed') return { refund: r, changed: false }
    const order = await tget(t, 'orders', r.orderId)
    const now = Date.now()

    if (r.kind === 'timeout') {
      await t.collection('refunds').doc(outRefundNo).update({ data: { status: 'success', doneAt: now, settledAmount: r.amount, wxState: 'ACCEPTED' } })
      await t.collection('orders').doc(order._id).update({
        data: { refundState: 'success', refundedFee: order.totalFee, refundCount: (order.refundCount || 0) + 1 }
      })
      return { refund: r, order, changed: true }
    }

    // 先讀：全部卡片、要釋放的車位牌、要退回庫存的商品
    const items = await txItems(t, order)
    const byId = Object.fromEntries(items.map(i => [i._id, i]))
    const plan = []
    let settled = 0 // 本次真正結算的金額：只計仍標記為「本退款處理中」的卡片，避免重複記帳
    for (const p of r.parts) {
      const it = byId[p.itemId]
      if (!it || it.refunding !== outRefundNo) continue
      settled += p.amount
      const data = { refunding: '', refundingQty: 0, refundingFee: 0, refundedFee: (it.refundedFee || 0) + p.amount }
      const extra = {}
      if (it.kind === 'court') {
        if (data.refundedFee >= it.price) {
          data.status = 'refunded'
          const lockId = u.slotId(it.date, it.court, it.hour)
          const lock = await tget(t, 'slot_locks', lockId)
          if (lock && lock.orderId === order._id) extra.unlock = lockId
        }
      } else if (it.kind === 'game') {
        // 球局報名退完：從名單移除，空位補給候補（退出、移出、取消、候補未補上都走這裡）
        if (data.refundedFee >= it.price) {
          data.status = 'refunded'
          const g = await tget(t, 'games', it.gameId)
          const roster = g && games.removeItem(g, it._id, now)
          if (roster) extra.roster = { id: g._id, roster }
        }
      } else if (p.qty > 0) {
        if (r.asExpired) data.expiredQty = (it.expiredQty || 0) + p.qty
        else {
          data.refundedQty = (it.refundedQty || 0) + p.qty
          const prod = await tget(t, 'products', it.productId)
          if (prod) extra.stock = { id: prod._id, stock: (prod.stock || 0) + p.qty }
        }
      }
      const merged = { ...it, ...data }
      if (it.kind === 'product' && productAvailable(merged) <= 0) data.codeActive = false
      if (r.asExpired) data.codeActive = false
      Object.assign(byId[p.itemId], data)
      plan.push({ id: it._id, data, extra })
    }

    // 再寫
    for (const x of plan) {
      await t.collection('order_items').doc(x.id).update({ data: x.data })
      if (x.extra.unlock) await t.collection('slot_locks').doc(x.extra.unlock).remove()
      if (x.extra.stock) await t.collection('products').doc(x.extra.stock.id).update({ data: { stock: x.extra.stock.stock } })
      if (x.extra.roster) await t.collection('games').doc(x.extra.roster.id).update({ data: { roster: x.extra.roster.roster } })
    }
    const updatedOrder = { ...order, refundedFee: (order.refundedFee || 0) + settled }
    updatedOrder.status = computeStatus(updatedOrder, Object.values(byId), now)
    await t.collection('orders').doc(order._id).update({ data: { refundedFee: updatedOrder.refundedFee, status: updatedOrder.status } })
    await t.collection('refunds').doc(outRefundNo).update({ data: { status: 'success', doneAt: now, settledAmount: settled, wxState: 'ACCEPTED' } })
    if (settled !== r.amount) console.error('finalizeRefund settled mismatch', outRefundNo, settled, r.amount)
    return { refund: r, order: updatedOrder, changed: true }
  })
}

// 3. 微信明確拒絕 → 撤銷預留（事務）
async function abortRefund(db, outRefundNo, error) {
  return tx(db, async t => {
    const r = await tget(t, 'refunds', outRefundNo)
    if (!r || r.status === 'success' || r.status === 'failed') return r
    const order = await tget(t, 'orders', r.orderId)
    if (r.kind === 'timeout') {
      await t.collection('orders').doc(order._id).update({ data: { refundState: 'failed' } })
    } else {
      const writes = []
      for (const p of r.parts) {
        const it = await tget(t, 'order_items', p.itemId)
        if (it && it.refunding === outRefundNo) writes.push(it._id)
      }
      for (const id of writes) await t.collection('order_items').doc(id).update({ data: { refunding: '', refundingQty: 0, refundingFee: 0 } })
      // 微信沒有受理，這次不算退款次數（預留時加的 1 次要還回去），否則失敗重試會把 50 次額度耗光
      await t.collection('orders').doc(order._id).update({ data: { refundCount: Math.max(0, (order.refundCount || 0) - 1) } })
    }
    await t.collection('refunds').doc(outRefundNo).update({ data: { status: 'failed', error: String(error || '').slice(0, 200), doneAt: Date.now() } })
    return r
  })
}

async function markUnknown(db, outRefundNo, e) {
  return tx(db, async t => {
    const cur = await tget(t, 'refunds', outRefundNo)
    if (!cur || cur.status === 'success' || cur.status === 'failed') return cur
    const now = Date.now()
    const attempts = (cur.attempts || 0) + 1
    await t.collection('refunds').doc(outRefundNo).update({
      data: {
        status: 'unknown', attempts, lastError: String((e && e.message) || e).slice(0, 200), lastTryAt: now,
        // 下次重試時間：1、2、4、8 分鐘遞增，最長 10 分鐘；未到時間的不佔定時任務每輪名額（澄清 H2）
        nextRetryAt: now + Math.min(10, 2 ** (attempts - 1)) * 60 * 1000
      }
    })
    return { ...cur, status: 'unknown' }
  })
}

// 微信「受理」退款不等於「已到帳」：定時任務用退款查詢確認最終結果，異常時通知管理端人工處理
async function confirmRefund(cloud, db, outRefundNo) {
  const r = await dget(db, 'refunds', outRefundNo)
  if (!r || r.status !== 'success' || r.wxState === 'SUCCESS' || r.wxState === 'ABNORMAL') return r
  const order = await dget(db, 'orders', r.orderId)
  const state = await pay.queryRefund(cloud, order, outRefundNo)
  if (state === 'PROCESSING' || state === 'UNKNOWN') {
    await db.collection('refunds').doc(outRefundNo).update({ data: { wxCheckedAt: Date.now() } })
    return r
  }
  if (state === 'SUCCESS') {
    await db.collection('refunds').doc(outRefundNo).update({ data: { wxState: 'SUCCESS', wxCheckedAt: Date.now() } })
    return r
  }
  // REFUNDCLOSE（退款關閉）／CHANGE（退款異常，例如客人銀行卡已註銷）
  await db.collection('refunds').doc(outRefundNo).update({ data: { wxState: 'ABNORMAL', wxRawState: state, wxCheckedAt: Date.now() } })
  await notify(db, 'refund', `【退款异常，请人工处理】${u.formatFen(r.amount)}\n微信状态：${state}\n退款单号：${outRefundNo}\n订单号：${r.orderId}`, r.orderId)
  return r
}

// 向微信申請（或重試）一筆已預留的退款。返回 { status: 'success' | 'processing' | 'failed', refund, order }
async function processRefund(cloud, db, outRefundNo) {
  const r = await dget(db, 'refunds', outRefundNo)
  if (!r) throw new Error('refund not found')
  if (r.status === 'success' || r.status === 'failed') return { status: r.status, refund: r }
  const order = await dget(db, 'orders', r.orderId)
  try {
    await pay.refund(cloud, order, outRefundNo, r.amount)
  } catch (e) {
    if (e.permanent) {
      await abortRefund(db, outRefundNo, e.message)
      await notify(db, 'refund', `【退款失败，请人工处理】${u.formatFen(r.amount)}\n原因：${e.message}\n订单号：${order._id}`, order._id)
      return { status: 'failed', refund: r, error: e.message }
    }
    // 結果不明：保留預留，由定時任務用同一單號重試。
    // 在事務裡確認仍未結束才標記，晚到的錯誤不能把別人已完成的退款改回「不明」
    const cur = await markUnknown(db, outRefundNo, e).catch(() => null)
    console.error('refund unknown', outRefundNo, e)
    if (cur && (cur.status === 'success' || cur.status === 'failed')) return { status: cur.status, refund: cur }
    return { status: 'processing', refund: r }
  }

  // 微信已受理；本地記帳失敗時同樣標為「結果不明」並排下次重試，
  // 用原單號重試（微信不會重複退錢、記帳本身也只會做一次），絕不當成退款失敗（澄清 I3）
  let f
  try {
    f = await finalizeRefund(db, outRefundNo)
  } catch (e) {
    const cur = await markUnknown(db, outRefundNo, new Error(`微信已受理，本地记账失败：${(e && e.message) || e}`)).catch(() => null)
    console.error('refund finalize', outRefundNo, e)
    if (cur && (cur.status === 'success' || cur.status === 'failed')) return { status: cur.status, refund: cur }
    return { status: 'processing', refund: r }
  }
  if (f.changed) {
    try {
      if (r.kind === 'timeout') {
        await notify(db, 'refund', `【超时付款自动退款】${u.formatFen(r.amount)}\n订单号：${order._id}`, order._id)
        await sendTimeoutRefundMsg(cloud, order)
      } else {
        const who = r.by === 'customer' ? '客人自行退款' : r.by === 'system' ? '系统自动退款' : '管理端退款'
        await notify(db, 'refund', `【${who}】${u.formatFen(r.amount)}${r.reason ? `（${r.reason}）` : ''}\n客人：${u.maskPhone(order.phone)}\n订单号：${order._id}`, order._id)
      }
    } catch (e) {
      console.error('refund notify', outRefundNo, e) // 退款和記帳都已完成，通知失敗不影響結果
    }
  }
  return { status: 'success', refund: r, order: f.order }
}

// 卡片退款（客人自退、管理端退、系統過期退）
async function refundItems(cloud, db, { order, parts, operatorId, by, reason, asExpired }) {
  const res = await reserveRefund(db, { orderId: order._id, parts, operatorId, by, reason, asExpired })
  const p = await processRefund(cloud, db, res.outRefundNo)
  if (p.status === 'failed') throw new Error('退款失败，请联系球馆')
  return { amount: res.amount, outRefundNo: res.outRefundNo, processing: p.status === 'processing', order: p.order }
}

module.exports = {
  FINAL, MAX_REFUNDS, isNotFound, tget, dget, tx, rollbackWith, notify, getItems, txItems, ensureItemIds,
  itemRefundable, productAvailable, courtFullyRefunded, productExpired, computeStatus, refreshStatus,
  planRelease, applyRelease, closePending, markPaid, verifyPaid, confirmIfPaid, settle, cancelPending,
  reserveRefund, finalizeRefund, abortRefund, markUnknown, confirmRefund, processRefund, refundItems
}
