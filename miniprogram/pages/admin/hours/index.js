// 營業時間（僅老闆，規格書「營業時間頁」，任務 T18）：日常营业时间、特殊日期（含全天休息）
const api = require('../../../utils/api')
const { now, beijingParts, pad } = require('../../../utils/time')

const HOURS = Array.from({ length: 25 }, (_, h) => `${pad(h)}:00`)

function today() {
  const p = beijingParts(now())
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function showOrders(err) {
  const lines = (err.orders || []).join('\n')
  wx.showModal({ title: err.message, content: lines || err.message, showCancel: false })
}

Page({
  data: {
    tab: 'daily', today: '', cfg: null, range: [HOURS, HOURS],
    daily: { idx: [9, 23], mode: 'now', from: '' },
    sp: { date: '', closed: false, idx: [9, 23] }
  },

  onShow() {
    this.setData({ today: today() })
    this.load()
  },

  load() {
    api
      .call('admin', 'hoursConfig')
      .then(cfg => this.setData({ cfg, 'daily.idx': [cfg.daily.open, cfg.daily.close] }))
      .catch(err => api.toast(err.message))
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  pickDaily(e) {
    this.setData({ 'daily.idx': e.detail.value.map(Number) })
  },

  setMode(e) {
    this.setData({ 'daily.mode': e.currentTarget.dataset.mode })
  },

  pickFrom(e) {
    this.setData({ 'daily.from': e.detail.value })
  },

  saveDaily() {
    const d = this.data.daily
    if (d.idx[1] <= d.idx[0]) return api.toast('打烊时间要晚于开门时间')
    if (d.mode === 'date' && !d.from) return api.toast('请选择生效日期')
    api
      .call('admin', 'saveDailyHours', { open: d.idx[0], close: d.idx[1], effectiveFrom: d.mode === 'date' ? d.from : '' })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'none' })
        this.load()
      })
      .catch(showOrders)
  },

  pickSpDate(e) {
    this.setData({ 'sp.date': e.detail.value })
  },

  toggleClosed(e) {
    this.setData({ 'sp.closed': e.detail.value })
  },

  pickSp(e) {
    this.setData({ 'sp.idx': e.detail.value.map(Number) })
  },

  saveSpecial() {
    const s = this.data.sp
    if (!s.date) return api.toast('请选择日期')
    if (!s.closed && s.idx[1] <= s.idx[0]) return api.toast('打烊时间要晚于开门时间')
    api
      .call('admin', 'saveSpecial', { date: s.date, closed: s.closed, open: s.idx[0], close: s.idx[1] })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'none' })
        this.setData({ 'sp.date': '', 'sp.closed': false })
        this.load()
      })
      .catch(showOrders)
  },

  removeSpecial(e) {
    const s = this.data.cfg.special[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除特殊日期',
      content: `删除 ${s.dateText} 的特殊设置，恢复日常营业时间？`,
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        api.call('admin', 'deleteSpecial', { id: s._id }).then(() => this.load()).catch(showOrders)
      }
    })
  }
})
