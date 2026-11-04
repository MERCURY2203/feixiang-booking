// 全項目唯一的金額格式化函數（全局規則 G3）
// 金額一律以「分」存儲，只在顯示時轉成 ¥88.50 這種格式
function formatFen(fen) {
  const n = Math.round(Number(fen) || 0)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const yuan = Math.floor(abs / 100)
  const cent = String(abs % 100).padStart(2, '0')
  return `${sign}¥${yuan}.${cent}`
}

// 把老闆輸入的「88.5」「88.55」轉成分（8850、8855）；不合法返回 null
function yuanToFen(input) {
  const s = String(input).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [y, c = ''] = s.split('.')
  return Number(y) * 100 + Number(c.padEnd(2, '0'))
}

module.exports = { formatFen, yuanToFen }
