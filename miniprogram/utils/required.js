// 必填項檢查（澄清 N16）：一次列出全部沒填的項目，頁面把這些欄位名標紅
const { yuanToFen } = require('./money')

// 發起球局；edit 為 true 時只檢查可以修改的標題和說明
function gameMissing(d, edit) {
  const miss = []
  if (!edit && !d.picked) miss.push('场地')
  if (!String(d.title || '').trim()) miss.push('标题')
  if (!String(d.desc || '').trim()) miss.push('详情说明')
  if (!edit && !yuanToFen(d.priceM)) miss.push('男价格')
  if (!edit && !yuanToFen(d.priceF)) miss.push('女价格')
  return miss
}

// 商品保存
function productMissing(d) {
  const miss = []
  if (!String(d.name || '').trim()) miss.push('名称')
  if (!(d.images || []).length) miss.push('图片')
  if (!yuanToFen(d.price)) miss.push('价格')
  if (!/^\d+$/.test(String(d.stock || ''))) miss.push('库存')
  if (d.fixedDate && !d.activityDate) miss.push('活动日期')
  if (d.fixedDate && !d.activityStartTime) miss.push('开始时间')
  return miss
}

const KEYS = {
  场地: 'cells', 标题: 'title', 详情说明: 'desc', 男价格: 'priceM', 女价格: 'priceF',
  名称: 'name', 图片: 'images', 价格: 'price', 库存: 'stock', 活动日期: 'activityDate', 开始时间: 'activityStartTime'
}

// 轉成 { 欄位代號: true }，給 wxml 判斷要不要把欄位名標紅
function flags(miss) {
  const o = {}
  miss.forEach(m => (o[KEYS[m] || m] = true))
  return o
}

module.exports = { gameMissing, productMissing, flags }
