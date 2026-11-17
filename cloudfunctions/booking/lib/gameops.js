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
    const data = { status: 'cancelled', cancelledAt: Date.now(), cancelBy: by, cancelReason: reason || '' }
    await t.collection('games').doc(gameId).update({ data })
    return { g: { ...g, ...data } }
  })
  await markOut(db, { gameId }, 'cancelled')
  await refundOutItems(cloud, db, { gameId })
  if (!r.already) {
    await ord.notify(db, 'game', `【球局已取消】${r.g.title}\n${u.cnDate(r.g.date)} ${cellsText(r.g)}${reason ? `\n原因：${reason}` : ''}`)
  }
  return r.g
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
  // 1. 人數不足：開局前 2 小時（含已開始還沒處理的）
  const low = await db.collection('games').where({ status: 'open', minPlayers: _.gt(0), startAt: _.lte(now + games.AUTO_CANCEL_BEFORE), autoChecked: _.neq(true) }).limit(20).get()
  for (const g of low.data) {
    if (!timeLeft()) return
    const c = games.counts(g, now)
    if (c.joined < g.minPlayers) await cancelGame(cloud, db, g._id, { by: 'system', reason: `报名不足 ${g.minPlayers} 人，自动取消` }).catch(e => console.error('autoCancel', g._id, e))
    else await db.collection('games').doc(g._id).update({ data: { autoChecked: true } })
  }
  // 2. 開局了：候補還沒補上的記 nofill
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

module.exports = { OUT_REASON, cellsText, refundGameItem, cancelGame, refundOutItems, kick, tick }
