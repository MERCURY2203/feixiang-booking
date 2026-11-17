// 球局管理列表（規格書「管理端 · 球局管理」，澄清 N 節）：进行中／已结束兩個標籤，底部「发起球局」
// 組局員只看到自己發起的（雲函數判斷）
const api = require('../../../utils/api')

Page({
  data: { tab: 'open', list: [], loaded: false },

  onShow() {
    this.load()
  },

  load() {
    return api
      .call('admin', 'gameList', { tab: this.data.tab })
      .then(list => this.setData({ list, loaded: true }))
      .catch(err => api.toast(err.message))
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab, list: [], loaded: false })
    this.load()
  },

  open(e) {
    wx.navigateTo({ url: `/pages/admin/game-manage/index?id=${e.currentTarget.dataset.id}` })
  },

  create() {
    wx.navigateTo({ url: '/pages/admin/game-edit/index' })
  }
})
