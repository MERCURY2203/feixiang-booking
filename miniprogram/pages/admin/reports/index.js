// 報表（僅老闆，規格書「報表」，任務 T20）：收入、退款、實收、場地使用率、熱門時段、導出 Excel
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')
const { now, beijingParts, pad } = require('../../../utils/time')

function todayParts() {
  return beijingParts(now())
}

function lastDay(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

Page({
  data: { mode: 'day', from: '', to: '', fromMonth: '', toMonth: '', rep: null, today: '' },

  onLoad() {
    const p = todayParts()
    const today = `${p.year}-${pad(p.month)}-${pad(p.day)}`
    const month = `${p.year}-${pad(p.month)}`
    this.setData({ today, from: `${month}-01`, to: today, fromMonth: month, toMonth: month })
    this.load()
  },

  setMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode })
    this.load()
  },

  pick(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
    this.load()
  },

  range() {
    if (this.data.mode === 'day') return { from: this.data.from, to: this.data.to }
    const [y2, m2] = this.data.toMonth.split('-').map(Number)
    return { from: `${this.data.fromMonth}-01`, to: `${this.data.toMonth}-${pad(lastDay(y2, m2))}` }
  },

  load() {
    const { from, to } = this.range()
    if (from > to) return api.toast('开始日期不能晚于结束日期')
    wx.showLoading({ title: '统计中' })
    api
      .call('admin', 'report', { mode: this.data.mode, from, to })
      .then(r => {
        wx.hideLoading()
        const f = formatFen
        this.setData({
          rep: {
            total: { income: f(r.total.income), court: f(r.total.court), product: f(r.total.product), refund: f(r.total.refund), net: f(r.total.net) },
            rows: r.rows.map(x => ({ period: x.period, court: f(x.court), product: f(x.product), refund: f(x.refund), net: f(x.net) })),
            courts: r.usageByCourt,
            hours: r.usageByHour,
            hot: r.hot
          }
        })
      })
      .catch(err => {
        wx.hideLoading()
        api.toast(err.message)
      })
  },

  // 導出 Excel：生成後用微信打開，可轉發給自己再在電腦打開
  exportExcel() {
    const { from, to } = this.range()
    wx.showLoading({ title: '生成中', mask: true })
    api
      .call('admin', 'reportExport', { mode: this.data.mode, from, to })
      .then(r => wx.cloud.downloadFile({ fileID: r.fileID }))
      .then(res => {
        wx.hideLoading()
        wx.openDocument({ filePath: res.tempFilePath, fileType: 'xlsx', showMenu: true })
      })
      .catch(err => {
        wx.hideLoading()
        api.toast(err.message || '导出失败')
      })
  }
})
