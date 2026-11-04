// 購物車：存在手機緩存（澄清 B3）；加入購物車不鎖場（規格書「購物車」）
const KEY = 'cartV1'

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
  else items.push({ type: 'court', date, court, hour })
  save(items)
  return idx < 0
}

function addProduct(productId, qty) {
  const items = list()
  const it = items.find(i => i.type === 'product' && i.productId === productId)
  if (it) it.qty += qty
  else items.push({ type: 'product', productId, qty })
  save(items)
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

// 付款成功後，已買的項目自動從購物車移除（澄清 C4）
function removeBought(bought) {
  save(list().filter(i => !bought.some(b => sameItem(i, b))))
}

function count() {
  return list().reduce((s, i) => s + (i.type === 'product' ? i.qty : 1), 0)
}

module.exports = { list, save, hasCourt, toggleCourt, addProduct, setProductQty, remove, removeBought, count, sameItem }
