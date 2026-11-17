// 活動頁（規格書「活動 · 商品列表」，任務 T14）
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const { formatFen } = require('../../utils/money')
const share = require('../../utils/share')

Page({
  data: { list: [], loaded: false },

  onShow() {
    api
      .call('booking', 'products')
      .then(list => this.setData({ list: list.map(p => ({ ...p, priceText: formatFen(p.price) })), loaded: true }))
      .catch(err => {
        if (share.isSinglePage()) this.setData({ single: true, loaded: true })
        else api.toast(err.message)
      })
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
  }
})
