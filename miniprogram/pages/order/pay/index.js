// 待支付頁（規格書「下單、待支付與支付結果 · 待支付頁」，任務 T9）
const api = require('../../../utils/api')
const checkout = require('../../../utils/checkout')
const { formatFen } = require('../../../utils/money')
const { now, syncServerTime } = require('../../../utils/time')

Page({
  data: { order: null, items: [], left: '', closed: false, confirming: false, totalText: '' },

  onLoad(options) {
    this.orderId = options.id
  },

  onShow() {
    this.load()
  },

  onHide() {
    clearInterval(this.timer)
  },

  onUnload() {
    clearInterval(this.timer)
  },

  load() {
    if (!this.orderId) return
    api
      .call('booking', 'pendingDetail', { orderId: this.orderId })
      .then(res => {
        syncServerTime(res.serverNow)
        const o = res.order
        if (o.status === 'active' || o.status === 'completed') {
          wx.redirectTo({ url: `/pages/order/result/index?id=${o._id}` })
          return
        }
        this.setData({
          order: o,
          totalText: formatFen(o.totalFee),
          items: res.items.map(i => ({ ...i, amountText: formatFen(i.amount) })),
          closed: o.status !== 'pending',
          confirming: o.confirming
        })
        if (o.status === 'pending') this.startTimer()
      })
      .catch(err => api.toast(err.message))
  },

  startTimer() {
    clearInterval(this.timer)
    const tick = () => {
      const ms = this.data.order.expiresAt - now()
      if (ms <= 0) {
        clearInterval(this.timer)
        this.setData({ left: '00:00' })
        this.check()
        return
      }
      const s = Math.ceil(ms / 1000)
      this.setData({ left: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` })
    }
    tick()
    this.timer = setInterval(tick, 1000)
  },

  // 倒計時歸零：由雲函數查單、關單後返回結果
  check() {
    api
      .call('booking', 'orderStatus', { orderId: this.orderId, check: true })
      .then(o => {
        if (o.status === 'active' || o.status === 'completed') {
          wx.redirectTo({ url: `/pages/order/result/index?id=${o._id}` })
        } else if (o.status === 'pending') {
          this.setData({ confirming: true })
          setTimeout(() => this.check(), 3000)
        } else {
          this.setData({ closed: true, confirming: false, 'order.statusText': o.statusText })
        }
      })
      .catch(() => setTimeout(() => this.check(), 3000))
  },

  continuePay() {
    api
      .call('booking', 'repay', { orderId: this.orderId })
      .then(res => checkout.payOrder(res.orderId, res.payment, res.mock))
      .then(paid => {
        if (paid) wx.redirectTo({ url: `/pages/order/result/index?id=${this.orderId}` })
      })
      .catch(err => {
        api.toast(err.message)
        this.load()
      })
  },

  cancelOrder() {
    wx.showModal({
      title: '取消订单',
      content: '确定取消订单？',
      confirmText: '取消订单',
      confirmColor: '#E54545',
      cancelText: '再想想',
      success: res => {
        if (!res.confirm) return
        clearInterval(this.timer)
        api
          .call('booking', 'cancel', { orderId: this.orderId })
          .then(o => {
            if (o.status === 'active') wx.redirectTo({ url: `/pages/order/result/index?id=${o._id}` })
            else this.setData({ closed: true, 'order.statusText': o.statusText })
          })
          .catch(err => api.toast(err.message))
      }
    })
  },

  backToBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  }
})
