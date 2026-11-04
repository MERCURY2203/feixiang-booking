// 橫幅管理（規格書「橫幅管理」，任務 T19）：最多 5 張同時顯示；用 ↑ ↓ 調整順序
const api = require('../../../utils/api')

Page({
  data: { list: [], loaded: false },

  onShow() {
    this.load()
  },

  load() {
    api
      .call('admin', 'bannerList')
      .then(list => this.setData({ list, loaded: true }))
      .catch(err => api.toast(err.message))
  },

  edit(e) {
    const index = e.currentTarget.dataset.index
    if (index === undefined) {
      wx.navigateTo({ url: '/pages/admin/banner-edit/index' })
      return
    }
    wx.setStorageSync('editingBanner', this.data.list[index])
    wx.navigateTo({ url: '/pages/admin/banner-edit/index?edit=1' })
  },

  move(e) {
    const index = +e.currentTarget.dataset.index
    const to = index + +e.currentTarget.dataset.delta
    if (to < 0 || to >= this.data.list.length) return
    const list = this.data.list.slice()
    const [it] = list.splice(index, 1)
    list.splice(to, 0, it)
    this.setData({ list })
    api.call('admin', 'bannerReorder', { ids: list.map(b => b._id) }).catch(err => api.toast(err.message))
  },

  toggle(e) {
    const index = e.currentTarget.dataset.index
    const b = this.data.list[index]
    api
      .call('admin', 'bannerToggle', { id: b._id, enabled: !b.enabled })
      .then(() => this.load())
      .catch(err => api.toast(err.message))
  },

  remove(e) {
    const b = this.data.list[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除横幅',
      content: '确定删除这张横幅？',
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        api.call('admin', 'bannerDelete', { id: b._id }).then(() => this.load()).catch(err => api.toast(err.message))
      }
    })
  }
})
