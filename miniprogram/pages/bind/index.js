// 掃描老闆碼或員工邀請碼後打開此頁，自動完成綁定（規格書「老闆綁定」「員工管理」）
// 第一次使用的新微信要先同意協議（同意後才建立帳號），所以先記住邀請碼，同意完成後再自動綁定；
// 不同意就不會用掉邀請碼（澄清 K7）
const api = require('../../utils/api')
const privacy = require('../../utils/privacy')

Page({
  data: { status: 'loading', message: '正在绑定…' },

  onLoad(options) {
    this.code = decodeURIComponent(options.scene || options.code || '')
    if (!this.code) {
      this.setData({ status: 'fail', message: '邀请码已失效，请联系老板重新生成' })
      return
    }
    getApp()
      .userReady.then(user => {
        if (user && user._id) return this.redeem()
        this.setData({ status: 'wait', message: '请先阅读并同意用户协议与隐私政策，同意后将自动完成绑定' })
      })
      .catch(err => this.setData({ status: 'fail', message: err.message }))
  },

  // 隱私彈窗「同意」成功後觸發：重新取得帳號，再綁定
  onAgreed() {
    if (!this.code || this.data.status === 'ok' || this.redeeming) return
    this.setData({ status: 'loading', message: '正在绑定…' })
    getApp()
      .refreshUser()
      .then(() => this.redeem())
      .catch(err => this.setData({ status: 'fail', message: err.message }))
  },

  redeem() {
    if (this.redeeming) return
    this.redeeming = true
    return api
      .call('staff', 'redeemInvite', { code: this.code })
      .then(user => {
        getApp().globalData.user = user
        const role = user.role === 'owner' ? '老板' : user.role === 'host' ? '组局员' : '员工'
        this.setData({ status: 'ok', message: `绑定成功，你已成为${role}` })
      })
      .catch(err => this.setData({ status: 'fail', message: err.message }))
      .then(() => (this.redeeming = false))
  },

  // 不同意後又想綁定：再彈出同意畫面（澄清 L1）
  askAgree() {
    privacy.ensure(this)
  },

  goMe() {
    wx.switchTab({ url: '/pages/me/index' })
  }
})
