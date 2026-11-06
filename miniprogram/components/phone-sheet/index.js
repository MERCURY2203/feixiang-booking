// 下單前授權手機號：微信規定必須由客人點按鈕觸發（open-type="getPhoneNumber"）
// 用法：const ok = await this.selectComponent('#phoneSheet').ask()
const api = require('../../utils/api')

Component({
  data: { show: false },
  methods: {
    noop() {},
    ask() {
      this.setData({ show: true })
      return new Promise(resolve => (this.resolve = resolve))
    },
    finish(ok) {
      this.setData({ show: false })
      if (this.resolve) this.resolve(ok)
      this.resolve = null
    },
    onPhone(e) {
      if (!e.detail.code) {
        const msg = e.detail.errMsg || ''
        // 不是客人自己拒絕，而是微信擋住（例如隱私指引未聲明）：把原因顯示出來
        api.toast(msg && !/deny|cancel/i.test(msg) ? `授权失败：${msg}` : '必须授权手机号才可下单购买哦')
        this.finish(false)
        return
      }
      api
        .call('user', 'bindPhone', { code: e.detail.code })
        .then(user => {
          getApp().globalData.user = user
          this.finish(true)
        })
        .catch(err => {
          api.toast(err.message)
          this.finish(false)
        })
    },
    cancel() {
      api.toast('必须授权手机号才可下单购买哦')
      this.finish(false)
    }
  }
})
