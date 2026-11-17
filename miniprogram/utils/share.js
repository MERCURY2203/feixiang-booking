// 分享（規格書「分享」，澄清 M4–M6、N 節）：只有訂場首頁、活動列表、活動詳情、球局詳情可以分享
// 朋友圈打開的是微信的「單頁模式」（場景值 1154）：不能登入、不能購買，很多功能用不了
function isSinglePage() {
  try {
    return wx.getEnterOptionsSync().scene === 1154
  } catch (e) {
    return false
  }
}

const BOOKING = { title: '飞翔球馆 · 在线订场', path: '/pages/booking/index' }
const ACTIVITY = { title: '飞翔球馆 · 活动', path: '/pages/activity/index' }

// 活動詳情的分享內容：標題「名稱 ¥價格」，路徑帶商品編號；名稱和價格一併帶上，給朋友圈單頁模式顯示
function productShare(p, imageUrl, priceText) {
  if (!p) return { app: ACTIVITY, timeline: { title: ACTIVITY.title } }
  const title = `${p.name} ${priceText}`
  const query = `id=${p._id}&n=${encodeURIComponent(p.name)}&pr=${p.price}`
  const app = { title, path: `/pages/product/index?${query}` }
  const timeline = { title, query }
  if (imageUrl) {
    app.imageUrl = imageUrl
    timeline.imageUrl = imageUrl
  }
  return { app, timeline }
}

// 球局詳情的分享內容（澄清 N 節）：標題「球局標題 男¥45.00 女¥35.00」，點開直接進這場球局
function gameShare(g, imageUrl) {
  if (!g) return { app: ACTIVITY, timeline: { title: ACTIVITY.title } }
  const title = `${g.title} 男${g.priceMText} 女${g.priceFText}`
  const query = `id=${g._id}&n=${encodeURIComponent(g.title)}&pm=${g.priceM}&pf=${g.priceF}`
  const app = { title, path: `/pages/game/index?${query}` }
  const timeline = { title, query }
  if (imageUrl) {
    app.imageUrl = imageUrl
    timeline.imageUrl = imageUrl
  }
  return { app, timeline }
}

module.exports = { isSinglePage, productShare, gameShare, BOOKING, ACTIVITY }
