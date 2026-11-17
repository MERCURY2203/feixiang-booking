// 伺服器時間（全局規則 G4）：手機時間不參與任何判斷
// 登入時雲函數返回伺服器時間，這裡記下與手機時間的差，之後都用 now() 取得「伺服器的現在」
let offset = 0

function syncServerTime(serverNow) {
  offset = serverNow - Date.now()
}

function now() {
  return Date.now() + offset
}

// 以北京時間（UTC+8）拆出年月日時分，不受手機時區影響
function beijingParts(ts = now()) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay() // 0 = 周日
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatBeijing(ts = now()) {
  const p = beijingParts(ts)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

// 日期條兩行文字（澄清 M1）：上行「今天／明天／周四」，下行「11-17」；date 是 'YYYY-MM-DD'
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function dayTab(date, ts = now()) {
  const p = beijingParts(ts)
  const today = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  const t = beijingParts(ts + 24 * 3600 * 1000)
  const tomorrow = `${t.year}-${pad(t.month)}-${pad(t.day)}`
  const [y, m, d] = date.split('-').map(Number)
  const top = date === today ? '今天' : date === tomorrow ? '明天' : WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return { top, bottom: `${pad(m)}-${pad(d)}` }
}

module.exports = { syncServerTime, now, beijingParts, formatBeijing, pad, dayTab }
