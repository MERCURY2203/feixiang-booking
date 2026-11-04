// 訂單詳情（規格書「我的 · 訂單詳情」，任務 T11、T12）
// 每格場地、每種商品一張卡片；右下角「退款」；點商品卡片看券碼
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')

Page({
  data: { order: null, items: [], hasCourt: false, coupon: null, refundSheet: null },

  onLoad(options) {
    this.orderId = options.id
  },

  onShow() {
    this.load()
  },

  load() {
    return api
      .call('booking', 'orderDetail', { orderId: this.orderId })
      .then(res => {
        this.setData({
          order: { ...res.order, totalText: formatFen(res.order.totalFee), refundedText: formatFen(res.order.refundedFee) },
          items: res.items.map(i => ({ ...i, priceText: formatFen(i.price) })),
          hasCourt: res.hasCourt
        })
      })
      .catch(err => api.toast(err.message))
  },

  // 只刷新卡片，不跳回頂部（G1）
  refresh() {
    return this.load()
  },

  openCoupon(e) {
    const it = this.data.items[e.currentTarget.dataset.index]
    if (it.kind !== 'product' || !it.hasCode) return
    wx.showLoading({ title: '加载中' })
    api
      .call('booking', 'couponQr', { itemId: it._id })
      .then(c => {
        wx.hideLoading()
        this.setData({ coupon: c })
      })
      .catch(err => {
        wx.hideLoading()
        api.toast(err.message)
      })
  },

  closeCoupon() {
    this.setData({ coupon: null })
    this.refresh()
  },

  refund(e) {
    const index = e.currentTarget.dataset.index
    const it = this.data.items[index]
    if (!it.canRefund) {
      if (it.refundHint) api.toast(it.refundHint)
      return
    }
    if (it.kind === 'product') {
      this.setData({ refundSheet: { index, qty: 1, max: it.available, amountText: formatFen(it.price) } })
      return
    }
    this.confirmRefund(it, 1, it.refundable)
  },

  changeRefundQty(e) {
    const s = this.data.refundSheet
    const it = this.data.items[s.index]
    const qty = Math.min(s.max, Math.max(1, s.qty + +e.currentTarget.dataset.delta))
    this.setData({ 'refundSheet.qty': qty, 'refundSheet.amountText': formatFen(Math.min(qty * it.price, it.refundable)) })
  },

  closeRefundSheet() {
    this.setData({ refundSheet: null })
  },

  submitRefundSheet() {
    const s = this.data.refundSheet
    const it = this.data.items[s.index]
    this.setData({ refundSheet: null })
    this.confirmRefund(it, s.qty, Math.min(s.qty * it.price, it.refundable))
  },

  confirmRefund(it, qty, amount) {
    wx.showModal({
      title: '确认退款',
      content: `将退款 ${formatFen(amount)}，原路退回`,
      confirmText: '确认',
      cancelText: '取消',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '退款中', mask: true })
        api
          .call('booking', 'refund', { orderId: this.orderId, itemId: it._id, qty })
          .then(r => {
            wx.hideLoading()
            wx.showToast({ title: r.processing ? '退款处理中，稍后到账' : `已退款 ${formatFen(r.amount)}`, icon: 'none' })
            this.refresh()
          })
          .catch(err => {
            wx.hideLoading()
            api.toast(err.message)
            this.refresh()
          })
      }
    })
  },

  noop() {}
})
