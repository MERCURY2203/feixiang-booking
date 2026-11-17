// 活動頁（規格書「活動」「球局」）：頂部兩個標籤「活动｜球局」（澄清 N 節）
// 活动：商品列表 + 底部結算欄；球局：球局列表（報名直接付款，不顯示結算欄）
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const { formatFen } = require('../../utils/money')
const share = require('../../utils/share')

Page({
  data: { tab: 'product', list: [], games: [], loaded: false, gamesLoaded: false },

  onShow() {
    // 其他頁面要帶到球局列表時，先設好 globalData.activityTab 再 switchTab
    const app = getApp()
    const want = app.globalData && app.globalData.activityTab
    if (want) {
      app.globalData.activityTab = ''
      if (want !== this.data.tab) this.setData({ tab: want })
    }
    this.loadProducts()
    this.loadGames()
  },

  loadProducts() {
    return api
      .call('booking', 'products')
      .then(list => this.setData({ list: list.map(p => ({ ...p, priceText: formatFen(p.price) })), loaded: true }))
      .catch(err => {
        if (share.isSinglePage()) this.setData({ single: true, loaded: true })
        else if (this.data.tab === 'product') api.toast(err.message)
      })
  },

  loadGames() {
    return api
      .call('booking', 'games')
      .then(games => this.setData({ games: games.map(g => ({ ...g, priceMText: formatFen(g.priceM), priceFText: formatFen(g.priceF) })), gamesLoaded: true }))
      .catch(err => {
        if (share.isSinglePage()) this.setData({ single: true, gamesLoaded: true })
        else if (this.data.tab === 'game') api.toast(err.message)
      })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab !== this.data.tab) this.setData({ tab })
  },

  onShareAppMessage() {
    return share.ACTIVITY
  },

  onShareTimeline() {
    return { title: share.ACTIVITY.title }
  },

  add(e) {
    const p = this.data.list[e.currentTarget.dataset.index]
    if (p.stock <= 0) return
    const inCart = cart.list().find(i => i.type === 'product' && i.productId === p._id)
    if (inCart && inCart.qty + 1 > p.stock) {
      api.toast(`库存仅剩 ${p.stock}`)
      return
    }
    if (!cart.addProduct(p._id, 1)) return api.toast(cart.FULL_TIP)
    const bar = this.selectComponent('#cartBar')
    if (bar) bar.refresh()
    wx.showToast({ title: '已加入购物车', icon: 'none', duration: 1000 })
  },

  open(e) {
    wx.navigateTo({ url: `/pages/product/index?id=${this.data.list[e.currentTarget.dataset.index]._id}` })
  },

  openGame(e) {
    wx.navigateTo({ url: `/pages/game/index?id=${this.data.games[e.currentTarget.dataset.index]._id}` })
  }
})
