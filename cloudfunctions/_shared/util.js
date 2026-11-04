// 公共工具（由 scripts/sync-shared.js 複製到各雲函數的 lib/ 目錄，請只改 _shared 裡的原檔）
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const BJ = 8 * HOUR // 北京時間 = UTC+8

const ok = data => ({ ok: true, data })
const fail = (message, code = 'ERROR', extra) => ({ ok: false, code, message, ...(extra || {}) })

function pad(n) {
  return String(n).padStart(2, '0')
}

// 'YYYY-MM-DD'（北京時間）
function dateStr(ts) {
  const d = new Date(ts + BJ)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// 某天北京時間 00:00 的時間戳
function dayStart(date) {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - BJ
}

// 某天某整點的時間戳
function slotStart(date, hour) {
  return dayStart(date) + hour * HOUR
}

function addDays(date, n) {
  return dateStr(dayStart(date) + n * DAY + HOUR)
}

// 0 = 周日 … 6 = 周六
function weekday(date) {
  return new Date(dayStart(date) + BJ).getUTCDay()
}

function hourNow(ts) {
  return new Date(ts + BJ).getUTCHours()
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function dateLabel(date) {
  const [, m, d] = date.split('-')
  return `${m}/${d} ${WEEK[weekday(date)]}`
}

function cnDate(date) {
  const [, m, d] = date.split('-').map(Number)
  return `${m}月${d}日`
}

function hourRange(h) {
  return `${pad(h)}:00–${pad(h + 1)}:00`
}

function slotId(date, court, hour) {
  return `${date}_${court}_${hour}`
}

// 微信支付時間 yyyyMMddHHmmss（北京時間）→ 時間戳
function parseWxTime(s) {
  if (!s) return 0
  const t = String(s)
  return Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)) - BJ
}

function toWxTime(ts) {
  const d = new Date(ts + BJ)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

function formatFen(fen) {
  const n = Math.round(fen || 0)
  return `¥${Math.floor(Math.abs(n) / 100)}.${pad(Math.abs(n) % 100)}`
}

function maskPhone(p) {
  return p ? `${p.slice(0, 3)}****${p.slice(-4)}` : ''
}

function randomDigits(n) {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
  return s
}

function newId(prefix) {
  const d = new Date(Date.now() + BJ)
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  return `${prefix}${stamp}${randomDigits(6)}`
}

module.exports = {
  HOUR, DAY, ok, fail, pad, dateStr, dayStart, slotStart, addDays, weekday, hourNow,
  dateLabel, cnDate, hourRange, slotId, parseWxTime, toWxTime, formatFen, maskPhone,
  randomDigits, newId, COURTS: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
}
