// 管理端頂欄 + 左上角選單按鈕 + 側邊欄；按權限只顯示自己能用的功能，選擇後自動收起
// 「订单管理」有新訂單或退款時顯示紅點數字
const MENU = require('../../utils/admin-menu')
const api = require('../../utils/api')

Component({
  properties: {
    current: { type: String, value: '' },
    title: { type: String, value: '' }
  },
  data: { open: false, items: [], badge: 0 },

  lifetimes: {
    attached() {
      const app = getApp()
      app.userReady.then(() => {
        const user = app.globalData.user
        const role = user && user.role
        if (role !== 'owner' && role !== 'staff') {
          wx.switchTab({ url: '/pages/me/index' })
          return
        }
        this.setData({ items: MENU.filter(m => m.roles.includes(role)) })
        this.refreshBadge()
      })
    }
  },

  pageLifetimes: {
    show() {
      if (this.data.items.length) this.refreshBadge()
    }
  },

  methods: {
    noop() {},
    refreshBadge() {
      if (this.data.current === 'orders') {
        api.call('admin', 'markSeen').catch(() => {})
        this.setData({ badge: 0 })
        return
      }
      api.call('admin', 'badges').then(b => this.setData({ badge: b.orders })).catch(() => {})
    },
    toggle() {
      this.setData({ open: !this.data.open })
    },
    go(e) {
      const item = this.data.items[e.currentTarget.dataset.index]
      this.setData({ open: false })
      if (item.key === this.data.current) return
      wx.redirectTo({ url: item.url })
    },
    backToCustomer() {
      this.setData({ open: false })
      wx.switchTab({ url: '/pages/me/index' })
    }
  }
})
