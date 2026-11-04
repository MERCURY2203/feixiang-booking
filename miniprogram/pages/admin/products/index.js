// 商品管理（規格書「商品管理」，任務 T13）
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')

Page({
  data: { list: [], loaded: false },

  onShow() {
    api
      .call('admin', 'productList')
      .then(list => this.setData({ list: list.map(p => ({ ...p, priceText: formatFen(p.price) })), loaded: true }))
      .catch(err => api.toast(err.message))
  },

  edit(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/admin/product-edit/index${id ? `?id=${id}` : ''}` })
  },

  toggle(e) {
    const index = e.currentTarget.dataset.index
    const p = this.data.list[index]
    api
      .call('admin', 'productToggle', { id: p._id, onShelf: !p.onShelf })
      .then(() => this.setData({ [`list[${index}].onShelf`]: !p.onShelf }))
      .catch(err => api.toast(err.message))
  }
})
