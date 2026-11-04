// 首次打開：隱私政策與用戶協議彈窗，必須勾選同意才能使用（規格書「首次打開」）
// 同意後接著請求授權手機號；拒絕手機號也可以瀏覽（規格書「手機號」）
const api = require('../../utils/api')
const STORAGE_KEY = 'privacyAgreedV1'

Component({
  data: { show: false, step: 'agree', checked: false },

  lifetimes: {
    attached() {
      if (!wx.getStorageSync(STORAGE_KEY)) this.setData({ show: true, step: 'agree' })
    }
  },

  methods: {
    noop() {},
    toggle() {
      this.setData({ checked: !this.data.checked })
    },
    openDoc(e) {
      const type = e.currentTarget.dataset.type
      wx.showModal({
        title: type === 'privacy' ? '隐私政策' : '用户协议',
        content: '正式文本待球馆提供并经法律人士审阅后填入。',
        showCancel: false
      })
    },
    // 按鈕使用微信官方隱私授權（open-type="agreePrivacyAuthorization"）
    onAgree() {
      if (!this.data.checked) {
        api.toast('请先勾选同意用户协议与隐私政策')
        return
      }
      wx.setStorageSync(STORAGE_KEY, Date.now())
      api.call('user', 'agreePrivacy').catch(() => {})
      this.setData({ step: 'phone' })
    },
    onDisagree() {
      wx.showModal({
        title: '提示',
        content: '需要同意用户协议与隐私政策才能使用飞翔球馆',
        confirmText: '我再想想',
        cancelText: '退出',
        success: res => {
          if (res.cancel) wx.exitMiniProgram()
        }
      })
    },
    onPhone(e) {
      const code = e.detail.code
      if (!code) {
        this.close()
        return
      }
      api
        .call('user', 'bindPhone', { code })
        .then(user => {
          getApp().globalData.user = user
          this.triggerEvent('userchange', user)
        })
        .catch(err => api.toast(err.message))
        .finally(() => this.close())
    },
    close() {
      this.setData({ show: false })
    }
  }
})
