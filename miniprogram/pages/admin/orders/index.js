// 訂單管理（規格書「訂單管理」，任務 T16）：搜索手機號後 4 位或訂單號、按日期和狀態篩選
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')
const { split } = require('../../../utils/cards')

const TABS = [
  { key: 'all', name: '全部' },
  { key: 'pending', name: '待支付' },
  { key: 'active', name: '待使用' },
  { key: 'completed', name: '已完成' },
  { key: 'refund', name: '退款' }
]

// 後台訂單卡片不合併：每個場地時段單獨一行（日期、時段、場號），每種商品單獨一行
const flatLines = lines => {
  const out = []
  for (const ln of lines) {
    if (ln.kind === 'court') ln.rows.forEach(r => out.push({ kind: 'courtRow', date: ln.date, time: r.time, court: r.court }))
    else out.push(ln)
  }
  return out
}
const rawLines = o => o.lines || String(o.summary || '').split('；').filter(Boolean).map(t => ({ kind: 'text', title: t, n: 0 }))

Page({
  data: { tabs: TABS, tab: 'all', keyword: '', date: '', list: [], more: false, loaded: false },

  onShow() {
    this.load(true)
  },

  onReachBottom() {
    if (this.data.more) this.load(false)
  },

  // 只採用最後一次篩選的結果；翻頁載入中不重複追加（澄清 K8）
  load(reset) {
    if (reset) {
      this.gen = (this.gen || 0) + 1
      this.loadingMore = false
    } else if (this.loadingMore) return
    const gen = this.gen
    const skip = reset ? 0 : this.data.list.length
    if (!reset) this.loadingMore = true
    api
      .call('admin', 'orders', { keyword: this.data.keyword, date: this.data.date, tab: this.data.tab, skip })
      .then(r => {
        if (gen !== this.gen) return
        const rows = r.list.map(o => ({ ...o, cards: split(o, rawLines(o), flatLines), totalText: formatFen(o.totalFee) }))
        this.setData({ list: reset ? rows : this.data.list.concat(rows), more: r.more, loaded: true })
      })
      .catch(err => gen === this.gen && api.toast(err.message))
      .then(() => {
        if (!reset && gen === this.gen) this.loadingMore = false
      })
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
