// 支付結果頁：付款後向雲函數確認；聯絡不上微信時顯示「正在确认支付结果…」並自動重試
const api = require('../../../utils/api')
const cart = require('../../../utils/cart')
const { formatFen } = require('../../../utils/money')

Page({
  data: { state: 'checking', order: null, totalText: '' },

  onLoad(options) {
    this.orderId = options.id
    this.tries = 0
    this.check()
  },

  onUnload() {
    clearTimeout(this.timer)
  },

  check() {
    api
      .call('booking', 'orderStatus', { orderId: this.orderId, check: true })
      .then(o => {
        if (o.status === 'active' || o.status === 'completed') {
          const last = wx.getStorageSync('lastCheckout')
          if (last && last.orderId === o._id) {
            cart.removeBought(last.items)
            wx.removeStorageSync('lastCheckout')
          }
          this.setData({ state: 'ok', order: o, totalText: formatFen(o.totalFee) })
        } else if (o.status === 'pending') {
          this.retry()
        } else {
          this.setData({ state: 'fail', order: o })
        }
      })
      .catch(() => this.retry())
  },

  retry() {
    this.tries++
    this.setData({ state: 'checking' })
    if (this.tries > 40) {
      wx.redirectTo({ url: `/pages/order/pay/index?id=${this.orderId}` })
      return
    }
    this.timer = setTimeout(() => this.check(), 2000)
  },

  viewOrder() {
    wx.redirectTo({ url: `/pages/order/detail/index?id=${this.orderId}` })
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  }
})
