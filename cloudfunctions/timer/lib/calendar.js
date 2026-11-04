// 營業時間、7 個營業日、價格計算（規格書「價格與營業時間」、澄清 B6）
const u = require('./util')

const DEFAULT_HOURS = { open: 9, close: 23 }
const DEFAULT_PRICE = { weekday: 6500, weekend: 10000 }

// 分頁讀取整個集合（雲數據庫每次最多 1000 條）
async function getAll(coll, where) {
  const out = []
  const q = where ? coll.where(where) : coll
  for (let skip = 0; ; skip += 1000) {
    const res = await q.skip(skip).limit(1000).get()
    out.push(...res.data)
    if (res.data.length < 1000) break
  }
  return out
}

async function loadConfig(db) {
  const today = u.dateStr(Date.now())
  const _ = db.command
  const [hours, regular, daily] = await Promise.all([
    getAll(db.collection('business_hours')),
    getAll(db.collection('prices'), { type: 'regular' }),
    getAll(db.collection('prices'), { type: 'daily', lastDate: _.gte(u.addDays(today, -1)) })
  ])
  return {
    daily: hours.filter(h => h.type === 'daily').sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)),
    special: Object.fromEntries(hours.filter(h => h.type === 'special').map(h => [h.date, h])),
    regular: regular.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)),
    dailyPrices: daily
  }
}

// 某天的營業時間；全天休息返回 null
function hoursFor(cfg, date) {
  const sp = cfg.special[date]
  if (sp) return sp.closed ? null : { open: sp.open, close: sp.close }
  const d = cfg.daily.find(h => h.effectiveFrom <= date)
  return d ? { open: d.open, close: d.close } : { ...DEFAULT_HOURS }
}

// 7 個營業日：今天還有未開始的時段就含今天，否則從明天起；全天休息跳過
function bookableDays(cfg, now, count = 7) {
  const days = []
  let date = u.dateStr(now)
  for (let i = 0; i < 60 && days.length < count; i++, date = u.addDays(date, 1)) {
    const h = hoursFor(cfg, date)
    if (!h) continue
    if (u.slotStart(date, h.close - 1) <= now) continue // 當天最後一個時段已開始
    days.push(date)
  }
  return days
}

function regularFor(cfg, date) {
  return cfg.regular.find(r => r.effectiveFrom <= date) || DEFAULT_PRICE
}

function dailyRuleFor(cfg, date, court, hour) {
  return cfg.dailyPrices.find(
    r => r.dates.includes(date) && hour >= r.startHour && hour < r.endHour && r.courts.includes(court)
  )
}

// 單日價格 ＞ 常用價格
function priceFor(cfg, date, court, hour) {
  const rule = dailyRuleFor(cfg, date, court, hour)
  if (rule) return { price: rule.price, special: true }
  const reg = regularFor(cfg, date)
  const wd = u.weekday(date)
  return { price: wd === 0 || wd === 6 ? reg.weekend : reg.weekday, special: false }
}

module.exports = { loadConfig, hoursFor, bookableDays, priceFor, regularFor, getAll, DEFAULT_HOURS, DEFAULT_PRICE }
