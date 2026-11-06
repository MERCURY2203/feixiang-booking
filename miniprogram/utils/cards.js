// 訂單拆卡片：場地一張卡片，每種活動商品各一張卡片（已付款後才拆，待支付仍是一張，因為只有一筆付款）
// 舊訂單沒有各項金額，不拆。
const { formatFen } = require('./money')

function split(order, lines, flat) {
  const whole = [{ key: 'all', lines: flat ? flat(lines) : lines, totalText: formatFen(order.totalFee) }]
  const hasFee = lines.length > 1 && lines.every(l => typeof l.fee === 'number')
  if (order.status === 'pending' || !hasFee) return whole
  const courts = lines.filter(l => l.kind === 'court')
  const cards = []
  if (courts.length) {
    const fee = courts.reduce((t, l) => t + l.fee, 0)
    cards.push({ key: 'court', lines: flat ? flat(courts) : courts, totalText: formatFen(fee) })
  }
  lines.filter(l => l.kind !== 'court').forEach((l, i) => cards.push({ key: 'p' + i, lines: [l], totalText: formatFen(l.fee) }))
  return cards
}

module.exports = { split }
