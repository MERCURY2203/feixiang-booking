// 掃描老闆碼或員工邀請碼後打開此頁，自動完成綁定（規格書「老闆綁定」「員工管理」）
const api = require('../../utils/api')

Page({
  data: { status: 'loading', message: '正在绑定…' },

  onLoad(options) {
    const code = decodeURIComponent(options.scene || options.code || '')
    if (!code) {
      this.setData({ status: 'fail', message: '邀请码已失效，请联系老板重新生成' })
      return
    }
    getApp()
      .userReady.then(() => api.call('staff', 'redeemInvite', { code }))
      .then(user => {
        getApp().globalData.user = user
        const role = user.role === 'owner' ? '老板' : '员工'
        this.setData({ status: 'ok', message: `绑定成功，你已成为${role}` })
      })
      .catch(err => this.setData({ status: 'fail', message: err.message }))
  },

  goMe() {
    wx.switchTab({ url: '/pages/me/index' })
  }
})
