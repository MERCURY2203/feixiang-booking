// 球局的系統操作：取消、移出、系統退款、定時任務（澄清 N9–N13，技術方案「關鍵機制 10」）
// 需要系統退款的報名先在卡片記 gameOut，再退款；退款失敗由定時任務重試，保證最終都退到
const u = require('./util')
const ord = require('./orders')
const games = require('./games')

const OUT_REASON = { kicked: '被移出球局', cancelled: '球局已取消', nofill: '候补未补上' }

function cellsText(g) {
  const courts = [...new Set((g.cells || []).map(c => c.court))].sort((a, b) => a - b)
  return `${courts.map(c => `${c}号`).join('、')}场 · ${u.pad(g.startHour)}:00–${u.pad(g.endHour)}:00`
}

// 一張已付款的球局卡片退全款（by：system／admin）
async function refundGameItem(cloud, db, it, by, operatorId) {
  const amount = ord.itemRefundable(it)
  if (amount <= 0 || it.refunding) return null
  return ord.refundItems(cloud, db, {
    order: { _id: it.orderId }, parts: [{ itemId: it._id, qty: 0, amount }],
    operatorId: operatorId || '', by, reason: OUT_REASON[it.gameOut] || ''
  })
}

// 給一批卡片記上 gameOut（只記已付款、還沒退完、沒記過的）
async function markOut(db, where, reason) {
  const _ = db.command
  await db.collection('order_items').where({ ...where, kind: 'game', status: 'active', gameOut: _.exists(false) }).update({ data: { gameOut: reason } })
}

// 取消球局：事務裡改狀態並放回格子；之後所有已付款的報名記 cancelled 並退款
async function cancelGame(cloud, db, gameId, { by, operatorId, reason }) {
  const r = await ord.tx(db, async t => {
    const g = await ord.tget(t, 'games', gameId)
    if (!g) return ord.rollbackWith(t, 'NOT_FOUND', '球局不存在')
    if (g.status !== 'open') return { already: true, g }
    if (by !== 'system' && g.startAt <= Date.now()) return ord.rollbackWith(t, 'STARTED', '球局已开始，不能取消')
    const unlock = []
    for (const c of g.cells || []) {
      const id = u.slotId(g.date, c.court, c.hour)
      const l = await ord.tget(t, 'slot_locks', id)
      if (l && l.status === 'game' && l.gameId === g._id) unlock.push(id)
    }
    for (const id of unlock) await t.collection('slot_locks').doc(id).remove()
    // refundPending：和「已取消」同一個事務寫入，退款沒全部做完前定時任務會一直補（澄清 O1）
    const data = { status: 'cancelled', cancelledAt: Date.now(), cancelBy: by, cancelReason: reason || '', refundPending: true }
    await t.collection('games').doc(gameId).update({ data })
    return { g: { ...g, ...data } }
  })
  // 取消已經成立；標記和退款中途出錯也不影響，定時任務會接著做
  await finishCancelRefunds(cloud, db, gameId).catch(e => console.error('cancel refunds', gameId, e))
  if (!r.already) {
    await ord.notify(db, 'game', `【球局已取消】${r.g.title}\n${u.cnDate(r.g.date)} ${cellsText(r.g)}${reason ? `\n原因：${reason}` : ''}`)
  }
  return r.g
}

// 已取消球局的退款：標記 → 退款 → 全部已付款的卡片都退完（沒有 status active 的）才清掉 refundPending
async function finishCancelRefunds(cloud, db, gameId) {
  await markOut(db, { gameId }, 'cancelled')
  await refundOutItems(cloud, db, { gameId })
  const left = await db.collection('order_items').where({ gameId, kind: 'game', status: 'active' }).count()
  if (!left.total) await db.collection('games').doc(gameId).update({ data: { refundPending: false } })
  return left.total
}

// 退掉記了 gameOut 但還沒退的卡片（盡力而為，失敗的留給定時任務）
async function refundOutItems(cloud, db, where, limit = 50) {
  const _ = db.command
  const res = await db.collection('order_items')
    .where(_.and([{ ...where, kind: 'game', status: 'active', gameOut: _.exists(true) }, _.or([{ refunding: _.exists(false) }, { refunding: '' }])]))
    .limit(limit).get()
  let n = 0
  for (const it of res.data) {
    try {
      await refundGameItem(cloud, db, it, 'system')
      n++
    } catch (e) {
      console.error('game refund', it._id, e)
    }
  }
  return n
}

// 移出：記 kicked 再退款，退款結算時從名單移除並補位
async function kick(cloud, db, game, itemId, operator) {
  const it = await ord.dget(db, 'order_items', itemId)
  if (!it || it.kind !== 'game' || it.gameId !== game._id) return u.fail('报名记录不存在')
  if (!(game.roster || []).some(p => p.itemId === itemId && (p.state === 'j' || p.state === 'w'))) return u.fail('该客人不在名单上')
  if (it.status !== 'active') return u.fail('该报名还没付款或已退款')
  if (it.refunding) return u.fail('正在退款中，请稍后')
  if (!it.gameOut) await db.collection('order_items').doc(itemId).update({ data: { gameOut: 'kicked' } })
  const r = await refundGameItem(cloud, db, { ...it, gameOut: 'kicked' }, 'admin', operator._id)
  return u.ok({ amount: r ? r.amount : 0, processing: r ? r.processing : true })
}

// 定時任務：人數不足自動取消、開局時候補記 nofill、退款重試、結束後標「已使用」
async function tick(cloud, db, now, timeLeft) {
  const _ = db.command
  // 1. 開局前 2 小時檢查一次（澄清 N13）：沒人報名、或未達最少人數 → 自動取消；
  //    開局前不到 2 小時才發布的不檢查（檢查時間點已過），由發起人自己決定
  const due = await db.collection('games').where({ status: 'open', startAt: _.lte(now + games.AUTO_CANCEL_BEFORE), autoChecked: _.neq(true) }).limit(20).get()
  for (const g of due.data) {
    if (!timeLeft()) return
    const reason = games.autoCancelReason(g, now)
    if (reason) await cancelGame(cloud, db, g._id, { by: 'system', reason }).catch(e => console.error('autoCancel', g._id, e))
    else await db.collection('games').doc(g._id).update({ data: { autoChecked: true } })
  }
  // 1b. 已取消但退款還沒全部做完的球局：接著標記和退款（澄清 O1）
  const pend = await db.collection('games').where({ status: 'cancelled', refundPending: true }).limit(10).get()
  for (const g of pend.data) {
    if (!timeLeft()) return
    await finishCancelRefunds(cloud, db, g._id).catch(e => console.error('finishCancelRefunds', g._id, e))
  }
  // 2. 開局了：候補還沒補上的記 nofill（開局後不再補位，所以這時的候補名單不會再變）
  const started = await db.collection('games').where({ status: 'open', startAt: _.lte(now), nofillDone: _.neq(true) }).limit(20).get()
  for (const g of started.data) {
    if (!timeLeft()) return
    const ids = (g.roster || []).filter(p => p.state === 'w').map(p => p.itemId)
    if (ids.length) await markOut(db, { _id: _.in(ids) }, 'nofill')
    await db.collection('games').doc(g._id).update({ data: { nofillDone: true } })
  }
  // 3. 退款重試
  if (timeLeft()) await refundOutItems(cloud, db, {}, 30)
  // 4. 結束了的已報名卡片
  const done = await db.collection('order_items').where({ kind: 'game', status: 'active', endAt: _.lte(now), gameOut: _.exists(false) }).limit(200).get()
  if (done.data.length) {
    const ids = done.data.map(i => i._id)
    await db.collection('order_items').where({ _id: _.in(ids), status: 'active', gameOut: _.exists(false) }).update({ data: { status: 'used' } })
    for (const orderId of [...new Set(done.data.map(i => i.orderId))]) {
      if (!timeLeft()) break
      await ord.refreshStatus(db, orderId).catch(e => console.error('game refreshStatus', orderId, e))
    }
  }
}

module.exports = { OUT_REASON, cellsText, refundGameItem, cancelGame, finishCancelRefunds, refundOutItems, kick, tick }
