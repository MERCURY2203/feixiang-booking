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

// 編號 = 前綴 + 北京時間（到秒）+ 隨機數字。隨機部分用加密等級的隨機數（澄清 K1）；
// 仍可能撞號，所以建立記錄時一律在事務裡確認編號沒被用過
function newId(prefix, digits = 6) {
  const d = new Date(Date.now() + BJ)
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  let r = ''
  for (let i = 0; i < digits; i++) r += require('crypto').randomInt(0, 10)
  return `${prefix}${stamp}${r}`
}

// 訂單卡片用的明細：場地按日期分組，每個時段一行「時段 … 場號」（依時間、場號排序）；
// 同一種商品合併成一組，n＝件數（顯示在右上角圓圈）
function orderLines(items) {
  const days = new Map()
  const products = new Map()
  for (const i of items) {
    if (i.type === 'court') {
      if (!days.has(i.date)) days.set(i.date, [])
      days.get(i.date).push(i)
    } else {
      const k = i.productId || i.label
      if (!products.has(k)) products.set(k, { title: i.label, n: 0, fee: 0 })
      products.get(k).n += i.qty
      products.get(k).fee += (i.price || 0) * i.qty
    }
  }
  const lines = []
  for (const date of [...days.keys()].sort()) {
    const rows = days.get(date).sort((x, y) => x.hour - y.hour || x.court - y.court)
    lines.push({ kind: 'court', date: cnDate(date), fee: rows.reduce((t, r) => t + (r.price || 0), 0), rows: rows.map(r => ({ time: hourRange(r.hour), court: `${r.court}号场` })) })
  }
  for (const p of products.values()) lines.push({ kind: 'product', title: p.title, n: p.n, fee: p.fee })
  return lines
}

// 舊訂單沒有明細：把原來的摘要拆成一行一項（沒有圓圈）
function legacyLines(summary) {
  return String(summary || '').split('；').filter(Boolean).map(t => ({ kind: 'text', title: t, n: 0 }))
}

module.exports = {
  HOUR, DAY, ok, fail, pad, dateStr, dayStart, slotStart, addDays, weekday, hourNow,
  dateLabel, cnDate, hourRange, orderLines, legacyLines, slotId, parseWxTime, toWxTime, formatFen, maskPhone,
  randomDigits, newId, COURTS: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
}
