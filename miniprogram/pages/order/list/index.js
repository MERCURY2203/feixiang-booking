// 我的訂單：按狀態分頁（澄清 A1，任務 T11）；待支付卡片直接顯示倒計時和兩個按鈕
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')
const { split } = require('../../../utils/cards')
const { now, syncServerTime, formatBeijing } = require('../../../utils/time')

const linesOf = o => o.lines || String(o.summary || '').split('；').filter(Boolean).map(t => ({ kind: 'text', title: t, n: 0 }))

const TABS = [
  { key: 'all', name: '全部' },
  { key: 'pending', name: '待支付' },
  { key: 'active', name: '待使用' },
  { key: 'completed', name: '已完成' },
  { key: 'refund', name: '退款' }
]

Page({
  data: { tabs: TABS, tab: 'all', list: [], more: false, loaded: false },

  onLoad(options) {
    if (options.tab) this.setData({ tab: options.tab })
  },

  onShow() {
    this.load(true)
    this.timer = setInterval(() => this.tick(), 1000)
  },

  onHide() {
    clearInterval(this.timer)
  },

  onUnload() {
    clearInterval(this.timer)
  },

  onReachBottom() {
    if (this.data.more) this.load(false)
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.key
    if (tab === this.data.tab) return
    this.loadingMore = false
    this.setData({ tab, list: [], loaded: false })
    this.load(true)
  },

  // 只採用最後一次切換分頁後的結果；翻頁載入中不重複追加（澄清 K8）
  load(reset) {
    if (reset) this.gen = (this.gen || 0) + 1
    else if (this.loadingMore) return
    const gen = this.gen
    const skip = reset ? 0 : this.data.list.length
    if (!reset) this.loadingMore = true
    return api
      .call('booking', 'myOrders', { tab: this.data.tab, skip })
      .then(res => {
        if (gen !== this.gen) return
        syncServerTime(res.serverNow)
        const rows = res.list.map(o => ({
          ...o,
          cards: split(o, linesOf(o)),
          totalText: formatFen(o.totalFee),
          created: formatBeijing(o.createdAt),
          left: ''
        }))
        this.setData({ list: reset ? rows : this.data.list.concat(rows), more: res.more, loaded: true })
        this.tick()
      })
      .catch(err => gen === this.gen && api.toast(err.message))
      .then(() => {
        if (!reset && gen === this.gen) this.loadingMore = false
      })
  },

  tick() {
    const diff = {}
    let expired = false
    this.data.list.forEach((o, i) => {
      if (o.status !== 'pending') return
      const ms = o.expiresAt - now()
      const s = Math.max(0, Math.ceil(ms / 1000))
      const left = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      if (left !== o.left) diff[`list[${i}].left`] = left
      if (s === 0) expired = true
    })
    if (Object.keys(diff).length) this.setData(diff)
    if (expired && !this.reloading) {
      this.reloading = true
      setTimeout(() => this.load(true).then(() => (this.reloading = false)), 1500)
    }
  },

  open(e) {
    const o = this.data.list[e.currentTarget.dataset.index]
    const url = o.status === 'pending' ? `/pages/order/pay/index?id=${o._id}` : `/pages/order/detail/index?id=${o._id}`
    wx.navigateTo({ url })
  },

  pay(e) {
    wx.navigateTo({ url: `/pages/order/pay/index?id=${this.data.list[e.currentTarget.dataset.index]._id}` })
  },

  noop() {},

  cancel(e) {
    const index = e.currentTarget.dataset.index
    const o = this.data.list[index]
    wx.showModal({
      title: '取消订单',
      content: '确定取消订单？',
      confirmText: '取消订单',
      confirmColor: '#E54545',
      cancelText: '再想想',
      success: res => {
        if (!res.confirm) return
        api
          .call('booking', 'cancel', { orderId: o._id })
          .then(r => this.setData({ [`list[${index}].status`]: r.status, [`list[${index}].statusText`]: r.statusText }))
          .catch(err => api.toast(err.message))
      }
    })
  }
})
