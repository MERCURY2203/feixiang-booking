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
    tab: 'regular', today: '', cfg: null, form: { weekday: '', weekend: '', mode: 'now', from: '', slots: [] },
    hourOptions: Array.from({ length: 25 }, (_, h) => `${pad(h)}:00`),
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
        const slotView = s => ({ ...s, text: `${pad(s.startHour)}:00–${pad(s.endHour)}:00`, weekdayText: formatFen(s.weekday), weekendText: formatFen(s.weekend) })
        this.setData({
          cfg: {
            regular: { ...cfg.regular, weekdayText: formatFen(cfg.regular.weekday), weekendText: formatFen(cfg.regular.weekend), slots: cfg.regular.slots.map(slotView) },
            scheduled: cfg.scheduled.map(s => ({ ...s, weekdayText: formatFen(s.weekday), weekendText: formatFen(s.weekend), slots: s.slots.map(slotView) })),
            daily: cfg.daily.map(view),
            expired: cfg.expired.map(view)
          },
          'form.weekday': (cfg.regular.weekday / 100).toFixed(2),
          'form.weekend': (cfg.regular.weekend / 100).toFixed(2),
          'form.slots': cfg.regular.slots.map(s => ({ start: s.startHour, end: s.endHour, weekday: (s.weekday / 100).toFixed(2), weekend: (s.weekend / 100).toFixed(2) }))
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

  // 新時段接在最後一段後面；最後一段已到 24:00 就不能再加（澄清 M7）
  addSlot() {
    const slots = this.data.form.slots.slice()
    const last = slots.reduce((m, s) => (!m || s.end > m.end ? s : m), null)
    if (last && last.end >= 24) return api.toast('已排到 24:00，无法再添加')
    const start = last ? last.end : 9
    slots.push({ start, end: start + 1, weekday: this.data.form.weekday, weekend: this.data.form.weekend })
    this.setData({ 'form.slots': slots })
  },

  removeSlot(e) {
    const slots = this.data.form.slots.slice()
    slots.splice(e.currentTarget.dataset.index, 1)
    this.setData({ 'form.slots': slots })
  },

  slotInput(e) {
    const { index, field } = e.currentTarget.dataset
    this.setData({ [`form.slots[${index}].${field}`]: e.detail.value })
  },

  slotPick(e) {
    const { index, field } = e.currentTarget.dataset
    this.setData({ [`form.slots[${index}].${field}`]: Number(e.detail.value) })
  },

  saveRegular() {
    const f = this.data.form
    const weekday = yuanToFen(f.weekday)
    const weekend = yuanToFen(f.weekend)
    if (!weekday || !weekend) return api.toast('请填写正确的价格（最多两位小数）')
    if (f.mode === 'date' && !f.from) return api.toast('请选择生效日期')
    const slots = []
    for (const s of f.slots) {
      const wd = yuanToFen(s.weekday)
      const we = yuanToFen(s.weekend)
      if (!(s.start < s.end)) return api.toast('时段的开始时间要早于结束时间')
      if (!wd || !we) return api.toast('请填写每个时段的平日价和周末价')
      slots.push({ startHour: s.start, endHour: s.end, weekday: wd, weekend: we })
    }
    api
      .call('admin', 'saveRegular', { weekday, weekend, slots, effectiveFrom: f.mode === 'date' ? f.from : '' })
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
