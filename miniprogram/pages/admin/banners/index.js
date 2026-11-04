// 橫幅管理（規格書「橫幅管理」，任務 T19）：最多 5 張同時顯示；按住右邊「≡」上下拖動調整順序
const api = require('../../../utils/api')

Page({
  data: { list: [], loaded: false, dragging: -1 },

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

  // 拖動排序：按住「≡」上下移動，經過一張卡片的高度就換一個位置，放手後保存
  dragStart(e) {
    const index = +e.currentTarget.dataset.index
    this.drag = { index, startY: e.touches[0].clientY, moved: false }
    wx.createSelectorQuery().selectAll('.banner-card').boundingClientRect(rects => {
      if (this.drag && rects.length) this.drag.step = rects[0].height + 12
    }).exec()
    this.setData({ dragging: index })
    wx.vibrateShort({ type: 'light' })
  },

  dragMove(e) {
    const d = this.drag
    if (!d || !d.step) return
    const offset = Math.round((e.touches[0].clientY - d.startY) / d.step)
    const to = Math.min(this.data.list.length - 1, Math.max(0, d.index + offset))
    if (to === this.data.dragging) return
    const list = this.data.list.slice()
    const [it] = list.splice(this.data.dragging, 1)
    list.splice(to, 0, it)
    d.moved = true
    d.startY += (to - this.data.dragging) * d.step
    d.index = to
    this.setData({ list, dragging: to })
  },

  dragEnd() {
    const d = this.drag
    this.drag = null
    this.setData({ dragging: -1 })
    if (!d || !d.moved) return
    api.call('admin', 'bannerReorder', { ids: this.data.list.map(b => b._id) }).catch(err => api.toast(err.message))
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
