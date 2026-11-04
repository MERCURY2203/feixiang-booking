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

module.exports = { syncServerTime, now, beijingParts, formatBeijing, pad }
