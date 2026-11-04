// 價格設置（僅老闆，規格書「價格與營業時間 · 價格頁」，任務 T18）
// 兩個分頁：常用价格（全局）、单日价格（突發狀況和節假日）；頂部「价格预览」
const api = require('../../../utils/api')
const { formatFen, yuanToFen } = require('../../../utils/money')
const { now, beijingParts, pad } = require('../../../utils/time')

function today() {
  const p = beijingParts(now())
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

Page({
  data: {
    tab: 'regular', today: '', cfg: null, form: { weekday: '', weekend: '', mode: 'now', from: '' },
    showExpired: false, preview: null, previewDate: ''
  },

  onShow() {
    this.setData({ today: today() })
    this.load()
  },

  load() {
    api
      .call('admin', 'priceConfig')
      .then(cfg => {
        const view = r => ({ ...r, priceText: formatFen(r.price) })
        this.setData({
          cfg: {
            regular: { ...cfg.regular, weekdayText: formatFen(cfg.regular.weekday), weekendText: formatFen(cfg.regular.weekend) },
            scheduled: cfg.scheduled.map(s => ({ ...s, weekdayText: formatFen(s.weekday), weekendText: formatFen(s.weekend) })),
            daily: cfg.daily.map(view),
            expired: cfg.expired.map(view)
          },
          'form.weekday': (cfg.regular.weekday / 100).toFixed(2),
          'form.weekend': (cfg.regular.weekend / 100).toFixed(2)
        })
      })
      .catch(err => api.toast(err.message))
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  input(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value })
  },

  setMode(e) {
    this.setData({ 'form.mode': e.currentTarget.dataset.mode })
  },

  saveRegular() {
    const f = this.data.form
    const weekday = yuanToFen(f.weekday)
    const weekend = yuanToFen(f.weekend)
    if (!weekday || !weekend) return api.toast('请填写正确的价格（最多两位小数）')
    if (f.mode === 'date' && !f.from) return api.toast('请选择生效日期')
    api
      .call('admin', 'saveRegular', { weekday, weekend, effectiveFrom: f.mode === 'date' ? f.from : '' })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'none' })
        this.load()
      })
      .catch(err => api.toast(err.message))
  },

  addDaily() {
    wx.removeStorageSync('editingDaily')
    wx.navigateTo({ url: '/pages/admin/price-daily/index' })
  },

  editDaily(e) {
    wx.setStorageSync('editingDaily', this.data.cfg.daily[e.currentTarget.dataset.index])
    wx.navigateTo({ url: '/pages/admin/price-daily/index?edit=1' })
  },

  removeDaily(e) {
    const r = this.data.cfg.daily[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除单日价格',
      content: `删除「${r.dateText} ${r.timeText}」？`,
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        api.call('admin', 'deleteDaily', { id: r._id }).then(() => this.load()).catch(err => api.toast(err.message))
      }
    })
  },

  toggleExpired() {
    this.setData({ showExpired: !this.data.showExpired })
  },

  // 價格預覽：與客人訂場頁看到的價格完全一致
  pickPreview(e) {
    const date = e.detail.value
    api
      .call('admin', 'pricePreview', { date })
      .then(p => {
        this.setData({
          previewDate: date,
          preview: p.closed
            ? { closed: true }
            : { courts: p.courts, hours: p.hours, cells: p.cells.map(row => row.map(c => ({ cls: c.sp ? 'special' : 'free', text: formatFen(c.p) }))) }
        })
      })
      .catch(err => api.toast(err.message))
  },

  closePreview() {
    this.setData({ preview: null, previewDate: '' })
  }
})
