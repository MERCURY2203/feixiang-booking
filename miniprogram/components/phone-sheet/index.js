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
        api.toast('必须授权手机号才可下单购买哦')
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
