// 新增／編輯橫幅：圖片、跳轉目標（從清單點選）、顯示方式（長期／限時）
const api = require('../../../utils/api')

const TARGETS = [
  { type: 'none', name: '不跳转' },
  { type: 'product', name: '某个活动商品' },
  { type: 'activity', name: '活动页' },
  { type: 'booking', name: '订场页的某一天' }
]

Page({
  data: {
    targets: TARGETS, targetIndex: 0, products: [], productIndex: -1,
    b: { _id: '', image: '', enabled: true, mode: 'long', target: { type: 'none' }, startDate: '', startTime: '00:00', endDate: '', endTime: '23:59' }
  },

  onLoad(options) {
    let b = this.data.b
    if (options.edit) {
      const saved = wx.getStorageSync('editingBanner')
      if (saved) b = { ...b, ...saved, startTime: saved.startTime || '00:00', endTime: saved.endTime || '23:59' }
    }
    this.setData({ b, targetIndex: Math.max(0, TARGETS.findIndex(t => t.type === (b.target || {}).type)) })
    api.call('admin', 'productList').then(list => {
      const products = list.filter(p => p.onShelf)
      this.setData({ products, productIndex: products.findIndex(p => p._id === (b.target || {}).productId) })
    })
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => {
        wx.showLoading({ title: '上传中', mask: true })
        wx.cloud
          .uploadFile({ cloudPath: `banners/${Date.now()}.jpg`, filePath: res.tempFiles[0].tempFilePath })
          .then(r => this.setData({ 'b.image': r.fileID }))
          .catch(() => api.toast('上传失败，请重试'))
          .finally(() => wx.hideLoading())
      }
    })
  },

  pickTarget(e) {
    const targetIndex = +e.detail.value
    this.setData({ targetIndex, 'b.target': { type: TARGETS[targetIndex].type } })
  },

  pickProduct(e) {
    const productIndex = +e.detail.value
    this.setData({ productIndex, 'b.target.productId': this.data.products[productIndex]._id })
  },

  pickBookingDate(e) {
    this.setData({ 'b.target.date': e.detail.value })
  },

  setMode(e) {
    this.setData({ 'b.mode': e.currentTarget.dataset.mode })
  },

  input(e) {
    this.setData({ [`b.${e.currentTarget.dataset.field}`]: e.detail.value })
  },

  toggleEnabled(e) {
    this.setData({ 'b.enabled': e.detail.value })
  },

  save() {
    api
      .call('admin', 'bannerSave', { banner: this.data.b })
      .then(() => {
        wx.removeStorageSync('editingBanner')
        wx.showToast({ title: '已保存', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch(err => api.toast(err.message))
  }
})
