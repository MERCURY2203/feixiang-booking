// 隱私政策與用戶協議彈窗（規格書「首次打開」，澄清 L1、L2）
// - 首次打開自動彈出；點「不同意」只關閉，客人可以照常瀏覽，本次打開期間不再自動彈出
// - 需要帳號的操作透過 utils/privacy.ensure(page) 呼叫 ask() 再次彈出
// - 同意後不立即索取手機號（只在下單或客人主動點「授权手机号」時才請求）
const api = require('../../utils/api')
const { PRIVACY_VERSION } = require('../../config')
const { STORAGE_KEY } = require('../../utils/privacy')

Component({
  data: { show: false, checked: false },

  lifetimes: {
    attached() {
      if (require('../../utils/share').isSinglePage()) return // 朋友圈單頁模式只能看，不彈同意畫面
      const declined = getApp().globalData.privacyDeclined
      if (wx.getStorageSync(STORAGE_KEY) !== PRIVACY_VERSION && !declined) this.setData({ show: true })
    }
  },

  methods: {
    noop() {},
    // 由 utils/privacy.ensure 呼叫：彈出並等客人選擇
    ask() {
      this.setData({ show: true })
      return new Promise(resolve => (this.resolve = resolve))
    },
    finish(ok) {
      this.setData({ show: false })
      if (this.resolve) this.resolve(ok)
      this.resolve = null
    },
    toggle() {
      this.setData({ checked: !this.data.checked })
    },
    openDoc(e) {
      wx.navigateTo({ url: `/pages/legal/index?type=${e.currentTarget.dataset.type}` })
    },
    // 按鈕使用微信官方隱私授權（open-type="agreePrivacyAuthorization"）
    onAgree() {
      if (!this.data.checked) {
        api.toast('请先勾选同意用户协议与隐私政策')
        return
      }
      // 先讓伺服器記下同意，成功了才算同意；寫入失敗要讓客人重試
      if (this.agreeing) return
      this.agreeing = true
      api
        .call('user', 'agreePrivacy', { version: PRIVACY_VERSION })
        .then(() => {
          wx.setStorageSync(STORAGE_KEY, PRIVACY_VERSION)
          const app = getApp()
          app.globalData.privacyDeclined = false
          return app.refreshUser().catch(() => null)
        })
        .then(user => {
          if (user) this.triggerEvent('userchange', user)
          this.triggerEvent('agreed') // 綁定頁等這個事件再自動綁定（澄清 K7）
          this.finish(true)
        })
        .catch(() => api.toast('网络不太好，请再点一次“同意并继续”'))
        .then(() => (this.agreeing = false))
    },
    // 不同意：只關閉彈窗，照常瀏覽（澄清 L1）
    onDisagree() {
      getApp().globalData.privacyDeclined = true
      api.toast('你可以先随便看看，订场和购买前需同意协议')
      this.finish(false)
    }
  }
})
