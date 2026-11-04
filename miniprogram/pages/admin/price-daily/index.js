// 新增／編輯單日價格（規格書「新增單日價格頁」）：4 步——選日期、時間段、場地、價格
const api = require('../../../utils/api')
const { yuanToFen } = require('../../../utils/money')
const { now, beijingParts, pad } = require('../../../utils/time')

const HOURS = Array.from({ length: 25 }, (_, h) => `${pad(h)}:00`)
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function ymd(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`
}

Page({
  data: {
    id: '', mode: 'multi', selected: {}, rangeStart: '', rangeEnd: '', count: 0,
    year: 0, month: 0, weeks: WEEK, cells: [], today: '',
    hours: HOURS, range: [[], []], hourIndex: [19, 21],
    courts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ({ n, on: true })), allOn: true,
    price: ''
  },

  onLoad(options) {
    const p = beijingParts(now())
    const today = ymd(p.year, p.month, p.day)
    this.setData({ today, year: p.year, month: p.month, range: [HOURS, HOURS] })
    if (options.edit) {
      const r = wx.getStorageSync('editingDaily')
      if (r) {
        const selected = {}
        r.dates.forEach(d => (selected[d] = true))
        this.setData({
          id: r._id, selected, count: r.dates.length, hourIndex: [r.startHour, r.endHour],
          courts: this.data.courts.map(c => ({ ...c, on: r.courts.includes(c.n) })), allOn: r.courts.length === 10,
          price: (r.price / 100).toFixed(2)
        })
        const [y, m] = r.dates[0].split('-').map(Number)
        this.setData({ year: y, month: m })
      }
    }
    this.renderMonth()
  },

  renderMonth() {
    const { year, month, today } = this.data
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const cells = []
    for (let i = 0; i < first; i++) cells.push({ d: 0 })
    for (let d = 1; d <= days; d++) {
      const date = ymd(year, month, d)
      cells.push({ d, date, past: date < today, cls: this.cellClass(date) })
    }
    this.setData({ cells })
  },

  cellClass(date) {
    const { mode, selected, rangeStart, rangeEnd } = this.data
    if (mode === 'multi') return selected[date] ? 'on' : ''
    if (!rangeStart) return ''
    const end = rangeEnd || rangeStart
    const lo = rangeStart < end ? rangeStart : end
    const hi = rangeStart < end ? end : rangeStart
    if (date === lo || date === hi) return 'on'
    return date > lo && date < hi ? 'mid' : ''
  },

  prevMonth() {
    let { year, month } = this.data
    month--
    if (month < 1) { month = 12; year-- }
    this.setData({ year, month })
    this.renderMonth()
  },

  nextMonth() {
    let { year, month } = this.data
    month++
    if (month > 12) { month = 1; year++ }
    this.setData({ year, month })
    this.renderMonth()
  },

  setMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, selected: {}, rangeStart: '', rangeEnd: '', count: 0 })
    this.renderMonth()
  },

  tapDay(e) {
    const c = this.data.cells[e.currentTarget.dataset.index]
    if (!c.d || c.past) return
    if (this.data.mode === 'multi') {
      const selected = { ...this.data.selected }
      if (selected[c.date]) delete selected[c.date]
      else selected[c.date] = true
      this.setData({ selected, count: Object.keys(selected).length })
    } else if (!this.data.rangeStart || this.data.rangeEnd) {
      this.setData({ rangeStart: c.date, rangeEnd: '', count: 1 })
    } else {
      this.setData({ rangeEnd: c.date })
      this.setData({ count: this.rangeDates().length })
    }
    this.renderMonth()
  },

  rangeDates() {
    const { rangeStart, rangeEnd } = this.data
    if (!rangeStart) return []
    const end = rangeEnd || rangeStart
    let lo = rangeStart < end ? rangeStart : end
    const hi = rangeStart < end ? end : rangeStart
    const out = []
    while (lo <= hi && out.length < 400) {
      out.push(lo)
      const [y, m, d] = lo.split('-').map(Number)
      const n = new Date(Date.UTC(y, m - 1, d + 1))
      lo = ymd(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate())
    }
    return out
  },

  // 時間段：兩個滾輪「开始时间 至 结束时间」
  pickHours(e) {
    this.setData({ hourIndex: e.detail.value.map(Number) })
  },

  toggleCourt(e) {
    const i = e.currentTarget.dataset.index
    const courts = this.data.courts.slice()
    courts[i] = { ...courts[i], on: !courts[i].on }
    this.setData({ courts, allOn: courts.every(c => c.on) })
  },

  toggleAll() {
    const on = !this.data.allOn
    this.setData({ courts: this.data.courts.map(c => ({ ...c, on })), allOn: on })
  },

  inputPrice(e) {
    this.setData({ price: e.detail.value })
  },

  save() {
    const dates = this.data.mode === 'multi' ? Object.keys(this.data.selected).sort() : this.rangeDates()
    const [startHour, endHour] = this.data.hourIndex
    const courts = this.data.courts.filter(c => c.on).map(c => c.n)
    const price = yuanToFen(this.data.price)
    if (!dates.length) return api.toast('请选择日期')
    if (endHour <= startHour) return api.toast('结束时间要晚于开始时间')
    if (!courts.length) return api.toast('请选择场地')
    if (!price) return api.toast('请填写正确的价格（最多两位小数）')
    api
      .call('admin', 'saveDaily', { rule: { _id: this.data.id || undefined, dates, startHour, endHour, courts, price } })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch(err => wx.showModal({ title: '无法保存', content: err.message, showCancel: false }))
  }
})
