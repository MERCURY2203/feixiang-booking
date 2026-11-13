// 核銷（管理端首頁，規格書「核銷」，任務 T15）：wx.scanCode 掃碼或手動輸入 6 位碼 → 選張數 → 確認核銷
const api = require('../../../utils/api')

Page({
  data: { code: '', info: null, qty: 1 },

  scan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: res => this.lookup(String(res.result || '').trim()),
      fail: err => {
        if (!/cancel/.test(err.errMsg || '')) api.toast('扫码失败，请重试')
      }
    })
  },

  onInput(e) {
    this.setData({ code: e.detail.value.replace(/\D/g, '').slice(0, 6) })
  },

  submitCode() {
    if (this.data.code.length !== 6) {
      api.toast('请输入 6 位券码')
      return
    }
    this.lookup(this.data.code)
  },

  lookup(code) {
    wx.showLoading({ title: '查询中' })
    api
      .call('admin', 'verifyLookup', { code })
      .then(info => {
        wx.hideLoading()
        // 這次核銷的操作編號：網絡出錯後再按「确认核销」沿用同一個，系統只會扣一次（澄清 I1）
        this.reqId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
        this.setData({ info, qty: info.available })
      })
      .catch(err => {
        wx.hideLoading()
        wx.showModal({ title: '无法核销', content: err.message, showCancel: false })
      })
  },

  change(e) {
    const qty = Math.min(this.data.info.available, Math.max(1, this.data.qty + +e.currentTarget.dataset.delta))
    this.setData({ qty })
  },

  close() {
    this.reqId = ''
    this.setData({ info: null })
  },

  confirm() {
    const { info, qty } = this.data
    if (this.busy) return
    this.busy = true
    api
      .call('admin', 'verifyConfirm', { itemId: info.itemId, qty, reqId: this.reqId })
      .then(r => {
        this.reqId = ''
        this.setData({ info: null, code: '' })
        wx.showModal({ title: '核销成功', content: `已核销 ${r.qty || qty} 张${r.left ? `，剩余可用 ${r.left} 张` : ''}`, showCancel: false })
      })
      .catch(err => api.toast(err.message))
      .then(() => (this.busy = false))
  },

  goLogs() {
    wx.navigateTo({ url: '/pages/admin/verify-logs/index' })
  },

  noop() {}
})
