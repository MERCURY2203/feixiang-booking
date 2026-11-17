// 球局名單計算（澄清 N 節、技術方案「關鍵機制 10」）
// 名單 roster 直接存在球局記錄裡：報名、付款、退出、移出、補位都在事務裡讀改同一條記錄，名額不會超賣。
// state：pj 待支付佔名額、pw 待支付排候補、j 已報名、w 候補
const QUIT_BEFORE = 15 * 60 * 1000 // 開局前 15 分鐘之前可自行退出
const AUTO_CANCEL_BEFORE = 2 * 60 * 60 * 1000 // 開局前 2 小時人數不足自動取消

// 這條名單記錄現在還算不算數（待支付過了到期時間就不算，等定時任務正式關單）
function live(p, now) {
  if (p.state === 'pj' || p.state === 'pw') return !(p.expiresAt < now)
  return p.state === 'j' || p.state === 'w'
}

// 佔名額的人數（已報名 + 待支付佔名額）
function seats(game, now, exceptUserId) {
  const c = { total: 0, M: 0, F: 0 }
  for (const p of game.roster || []) {
    if (p.userId === exceptUserId || !live(p, now)) continue
    if (p.state === 'j' || p.state === 'pj') {
      c.total++
      c[p.gender]++
    }
  }
  return c
}

function fits(game, gender, c) {
  if (game.cap && c.total >= game.cap) return false
  const cap = gender === 'M' ? game.capM : game.capF
  if (cap && c[gender] >= cap) return false
  return true
}

function canSeat(game, gender, now, exceptUserId) {
  return fits(game, gender, seats(game, now, exceptUserId))
}

// 補位：按候補先後，符合上限的候補變成已報名，直到沒有可補的。返回新名單和補上的人
// 只在球局未取消、還沒開局時補位；開局那一刻還在候補的一律按「候补未补上」退款（澄清 O2）
function promote(game, now) {
  const roster = (game.roster || []).map(p => ({ ...p }))
  const promoted = []
  if (game.status !== 'open' || now >= game.startAt) return { roster, promoted }
  const waiting = roster.filter(p => p.state === 'w').sort((a, b) => a.at - b.at)
  for (const p of waiting) {
    const c = seats({ ...game, roster }, now)
    if (fits(game, p.gender, c)) {
      p.state = 'j'
      promoted.push(p.userId)
    }
  }
  return { roster, promoted }
}

// 從名單移除某張卡片（只移除仍屬於這張卡片的記錄），再補位
function removeItem(game, itemId, now) {
  const before = game.roster || []
  const roster = before.filter(p => p.itemId !== itemId)
  if (roster.length === before.length) return null
  return promote({ ...game, roster }, now).roster
}

function counts(game, now) {
  const c = { joined: 0, M: 0, F: 0, waiting: 0 }
  for (const p of game.roster || []) {
    if (!live(p, now)) continue
    if (p.state === 'j') {
      c.joined++
      c[p.gender]++
    } else if (p.state === 'w') c.waiting++
  }
  return c
}

// 候補排第幾位（只算已付款的候補）
function waitRank(game, userId) {
  const w = (game.roster || []).filter(p => p.state === 'w').sort((a, b) => a.at - b.at)
  const i = w.findIndex(p => p.userId === userId)
  return i < 0 ? 0 : i + 1
}

// 這場球局會不會在開局前 2 小時被自動檢查（發布時間早於那個時間點才會）
function autoChecks(g) {
  return (g.createdAt || 0) <= g.startAt - AUTO_CANCEL_BEFORE
}

// 開局前 2 小時檢查：要自動取消時返回原因，否則返回空字串（澄清 N13）
function autoCancelReason(g, now) {
  if (!autoChecks(g)) return ''
  const c = counts(g, now)
  if (c.joined === 0) return '开局前 2 小时无人报名，自动取消'
  if (g.minPlayers && c.joined < g.minPlayers) return `报名不足 ${g.minPlayers} 人，自动取消`
  return ''
}

module.exports = { QUIT_BEFORE, AUTO_CANCEL_BEFORE, autoChecks, autoCancelReason, live, seats, fits, canSeat, promote, removeItem, counts, waitRank }
