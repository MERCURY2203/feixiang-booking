const { CLOUD_ENV } = require('./config')
const { syncServerTime } = require('./utils/time')
const api = require('./utils/api')
const { isSinglePage } = require('./utils/share')

App({
  globalData: {
    user: null, // { role: 'customer' | 'staff' | 'owner', ... }
    privacyDeclined: false // 本次打開時客人點了「不同意」：不再自動彈出同意畫面（澄清 L1）
  },

  onLaunch() {
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true })
    // 朋友圈單頁模式不能登入（澄清 M5）：不登入，頁面只做展示
    if (isSinglePage()) {
      this.userReady = Promise.resolve(null)
      return
    }
    this.userReady = this.refreshUser()
  },

  // 向雲函數登入：記錄微信身份、取得角色和伺服器時間
  refreshUser() {
    return api.call('user', 'login').then(data => {
      syncServerTime(data.serverNow)
      this.globalData.user = data.user
      return data.user
    })
  }
})
