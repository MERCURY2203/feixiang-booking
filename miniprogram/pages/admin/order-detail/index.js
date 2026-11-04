// 管理端訂單詳情：查看電話（留痕）、任何時候退款、部分金額、多選合併退款（規格書「訂單管理」）
const api = require('../../../utils/api')
const { formatFen, yuanToFen } = require('../../../utils/money')

Page({
  data: { order: null, items: [], refunds: [], phone: '', selected: {}, selectedCount: 0, sheet: null },

  onLoad(options) {
    this.orderId = options.id
    this.load()
  },

  load() {
    return api
      .call('admin', 'orderDetail', { orderId: this.orderId })
      .then(r => {
        this.setData({
          order: { ...r.order, totalText: formatFen(r.order.totalFee), refundedText: formatFen(r.order.refundedFee) },
          items: r.items.map(i => ({ ...i, priceText: formatFen(i.price), refundableText: formatFen(i.refundable) })),
          refunds: r.refunds.map(x => ({ ...x, amountText: formatFen(x.amount) })),
          selected: {},
          selectedCount: 0
        })
      })
      .catch(err => api.toast(err.message))
  },

  viewPhone() {
    api
      .call('admin', 'viewPhone', { orderId: this.orderId })
      .then(r => this.setData({ phone: r.phone }))
      .catch(err => api.toast(err.message))
  },

  call() {
    wx.makePhoneCall({ phoneNumber: this.data.phone })
  },

  toggleSelect(e) {
    const it = this.data.items[e.currentTarget.dataset.index]
    if (!it.canRefund) return
    const selected = { ...this.data.selected }
    if (selected[it._id]) delete selected[it._id]
    else selected[it._id] = true
    this.setData({ selected, selectedCount: Object.keys(selected).length })
  },

  // 單張卡片退款：可改金額（部分退款）、商品可選張數
  openRefund(e) {
    const it = this.data.items[e.currentTarget.dataset.index]
    if (!it.canRefund) return
    const qty = it.kind === 'product' ? it.available : 1
    const amount = it.kind === 'product' ? Math.min(qty * it.price, it.refundable) : it.refundable
    this.setData({ sheet: { item: it, qty, amount: (amount / 100).toFixed(2), max: it.refundableText } })
  },

  sheetQty(e) {
    const s = this.data.sheet
    const qty = Math.min(s.item.available, Math.max(0, s.qty + +e.currentTarget.dataset.delta))
    const amount = Math.min(qty * s.item.price, s.item.refundable)
    this.setData({ 'sheet.qty': qty, 'sheet.amount': (amount / 100).toFixed(2) })
  },

  sheetAmount(e) {
    this.setData({ 'sheet.amount': e.detail.value })
  },

  closeSheet() {
    this.setData({ sheet: null })
  },

  submitSheet() {
    const s = this.data.sheet
    const amount = yuanToFen(s.amount)
    if (!amount) return api.toast('请输入正确的退款金额')
    if (amount > s.item.refundable) return api.toast(`最多可退 ${s.max}`)
    this.setData({ sheet: null })
    this.doRefund([{ itemId: s.item._id, qty: s.item.kind === 'product' ? s.qty : 1, amount }])
  },

  // 多選合併退款：每張卡片退剩餘全部可退金額，合併為一筆微信退款
  refundSelected() {
    const parts = this.data.items
      .filter(i => this.data.selected[i._id])
      .map(i => ({ itemId: i._id, qty: i.kind === 'product' ? i.available : 1, amount: i.refundable }))
    if (!parts.length) return
    this.doRefund(parts)
  },

  doRefund(parts) {
    const total = parts.reduce((s, p) => s + p.amount, 0)
    wx.showModal({
      title: '确认退款',
      content: `将退款 ${formatFen(total)}，原路退回`,
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '退款中', mask: true })
        api
          .call('admin', 'refund', { orderId: this.orderId, parts })
          .then(r => {
            wx.hideLoading()
            wx.showToast({ title: r.processing ? '退款处理中，稍后到账' : `已退款 ${formatFen(r.amount)}`, icon: 'none' })
            this.load()
          })
          .catch(err => {
            wx.hideLoading()
            api.toast(err.message)
            this.load()
          })
      }
    })
  },

  noop() {}
})
