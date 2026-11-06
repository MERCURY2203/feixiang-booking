// 場地管理（鎖場，規格書「場地管理」，任務 T17）：點格子多選，再按「锁定」或「解锁」一次處理
const api = require('../../../utils/api')

const LABEL = { free: { cls: 'free', text: '' }, locked: { cls: 'locked', text: '已锁' }, booked: { cls: 'booked', text: '已订' }, pending: { cls: 'booked', text: '待支付' }, past: { cls: 'past', text: '' } }

Page({
  data: { days: [], date: '', courts: [], hours: [], cells: [], gridHeight: 400, picked: 0 },

  onShow() {
    this.load()
  },

  onReady() {
    this.measure()
  },

  // 表格高度 = 底部操作列的頂邊 − 表格的頂邊，剛好不被操作列蓋住（直接量，不猜數字）
  measure() {
    const q = wx.createSelectorQuery()
    q.select('.grid-anchor').boundingClientRect()
    q.select('.bottom-bar').boundingClientRect()
    q.exec(res => {
      const anchor = res && res[0]
      const bar = res && res[1]
      if (!anchor || !bar) return
      this.setData({ gridHeight: Math.max(240, Math.floor(bar.top - anchor.top)) })
    })
  },

  load(date) {
    return api
      .call('admin', 'courtSchedule', { date: date || this.data.date })
      .then(r => {
        this.raw = r.cells
        this.sel = {}
        this.setData({
          days: r.days, date: r.date, courts: r.courts, hours: r.hours, picked: 0,
          cells: r.cells.map(row => row.map(c => ({ ...LABEL[c.s] })))
        }, () => this.measure())
      })
      .catch(err => api.toast(err.message))
  },

  pickDate(e) {
    this.load(e.currentTarget.dataset.date)
  },

  onCellTap(e) {
    const { r, c } = e.detail
    const s = this.raw[r][c].s
    if (s === 'past') return
    if (s === 'booked') return api.toast('该时段已有订单，请先退款再锁定')
    if (s === 'pending') return api.toast('该时段有待支付订单，请稍后再试')
    const key = `${r}_${c}`
    if (this.sel[key]) delete this.sel[key]
    else this.sel[key] = true
    const base = LABEL[s]
    this.setData({
      [`cells[${r}][${c}]`]: this.sel[key] ? { cls: 'sel', text: s === 'locked' ? '已锁' : '已选' } : { ...base },
      picked: Object.keys(this.sel).length
    })
  },

  submit(e) {
    const lock = e.currentTarget.dataset.lock === '1'
    const cells = Object.keys(this.sel).map(k => {
      const [r, c] = k.split('_').map(Number)
      return { court: this.data.courts[c], hour: this.data.hours[r].hour }
    })
    if (!cells.length) return api.toast('请先选择格子')
    api
      .call('admin', 'setLocks', { date: this.data.date, cells, lock })
      .then(r => {
        if (r.failed.length) {
          wx.showModal({ title: '部分未完成', content: r.failed.map(f => `${f.court}号场 ${f.hour}:00 ${f.reason}`).join('\n'), showCancel: false })
        } else wx.showToast({ title: lock ? '已锁定' : '已解锁', icon: 'none' })
        this.load()
      })
      .catch(err => api.toast(err.message))
  },

  clearPick() {
    this.load()
  }
})
