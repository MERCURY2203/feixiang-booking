// 購物車：存在手機緩存（澄清 B3）；加入購物車不鎖場（規格書「購物車」）
const KEY = 'cartV1'
const MAX_LINES = 40 // 購物車最多 40 項（一格場地或一種商品算一項），與一張訂單的上限相同
const FULL_TIP = `购物车最多 ${MAX_LINES} 项，请先结算或删除一些`

function list() {
  return wx.getStorageSync(KEY) || []
}

function save(items) {
  wx.setStorageSync(KEY, items)
}

function courtKey(i) {
  return `${i.date}_${i.court}_${i.hour}`
}

function hasCourt(date, court, hour) {
  return list().some(i => i.type === 'court' && courtKey(i) === `${date}_${court}_${hour}`)
}

function toggleCourt(date, court, hour) {
  const items = list()
  const idx = items.findIndex(i => i.type === 'court' && courtKey(i) === `${date}_${court}_${hour}`)
  if (idx >= 0) items.splice(idx, 1)
  else if (items.length >= MAX_LINES) return null // 已滿，沒有加入
  else items.push({ type: 'court', date, court, hour })
  save(items)
  return idx < 0
}

function addProduct(productId, qty) {
  const items = list()
  const it = items.find(i => i.type === 'product' && i.productId === productId)
  if (it) it.qty = Math.min(99, it.qty + qty)
  else if (items.length >= MAX_LINES) return false // 已滿，沒有加入
  else items.push({ type: 'product', productId, qty })
  save(items)
  return true
}

function setProductQty(productId, qty) {
  const items = list()
  const it = items.find(i => i.type === 'product' && i.productId === productId)
  if (it) it.qty = qty
  save(items)
}

function remove(match) {
  save(list().filter(i => !match(i)))
}

function sameItem(a, b) {
  if (a.type !== b.type) return false
  return a.type === 'court' ? courtKey(a) === courtKey(b) : a.productId === b.productId
}

// 付款成功後，已買的項目自動從購物車移除（澄清 C4）。
// 商品只扣掉這張訂單買了的數量，結算之後才加的保留（澄清 K9）；場地按格子移除
function removeBought(bought) {
  const items = []
  for (const i of list()) {
    const b = bought.find(x => sameItem(i, x))
    if (!b) items.push(i)
    else if (i.type === 'product') {
      const left = (i.qty || 0) - (b.qty || 0)
      if (left > 0) items.push({ ...i, qty: left })
    }
  }
  save(items)
}

function count() {
  return list().reduce((s, i) => s + (i.type === 'product' ? i.qty : 1), 0)
}

module.exports = { MAX_LINES, FULL_TIP, list, save, hasCourt, toggleCourt, addProduct, setProductQty, remove, removeBought, count, sameItem }
