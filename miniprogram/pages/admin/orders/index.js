// 訂單管理（規格書「訂單管理」，任務 T16）：搜索手機號後 4 位或訂單號、按日期和狀態篩選
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')

const TABS = [
  { key: 'all', name: '全部' },
  { key: 'pending', name: '待支付' },
  { key: 'active', name: '待使用' },
  { key: 'completed', name: '已完成' },
  { key: 'refund', name: '退款' }
]

const linesOf = o => o.lines || String(o.summary || '').split('；').filter(Boolean).map(t => ({ kind: 'text', title: t, n: 0 }))

Page({
  data: { tabs: TABS, tab: 'all', keyword: '', date: '', list: [], more: false, loaded: false },

  onShow() {
    this.load(true)
  },

  onReachBottom() {
    if (this.data.more) this.load(false)
  },

  load(reset) {
    const skip = reset ? 0 : this.data.list.length
    api
      .call('admin', 'orders', { keyword: this.data.keyword, date: this.data.date, tab: this.data.tab, skip })
      .then(r => {
        const rows = r.list.map(o => ({ ...o, lines: linesOf(o), totalText: formatFen(o.totalFee) }))
        this.setData({ list: reset ? rows : this.data.list.concat(rows), more: r.more, loaded: true })
      })
      .catch(err => api.toast(err.message))
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value.trim() })
  },

  search() {
    this.load(true)
  },

  pickDate(e) {
    this.setData({ date: e.detail.value })
    this.load(true)
  },

  clearDate() {
    this.setData({ date: '' })
    this.load(true)
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key })
    this.load(true)
  },

  open(e) {
    wx.navigateTo({ url: `/pages/admin/order-detail/index?id=${this.data.list[e.currentTarget.dataset.index]._id}` })
  }
})
