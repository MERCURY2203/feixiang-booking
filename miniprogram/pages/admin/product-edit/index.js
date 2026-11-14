// 新增／編輯商品：名稱、圖片（最多 6 張）、價格、庫存、說明、類型（固定日期／長期）、上下架
const api = require('../../../utils/api')
const { pickImages } = require('../../../utils/image')
const { yuanToFen } = require('../../../utils/money')
const { now, beijingParts, pad } = require('../../../utils/time')

Page({
  data: {
    id: '', name: '', images: [], price: '', stock: '', stockFrom: null, desc: '', fixedDate: false,
    activityDate: '', activityStartTime: '', onShelf: true, soldCount: 0, today: ''
  },

  onLoad(options) {
    // 本次編輯的操作編號：重複提交同一表單時，庫存只調整一次
    this.opId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const p = beijingParts(now())
    this.setData({ today: `${p.year}-${pad(p.month)}-${pad(p.day)}` })
    if (!options.id) return
    api
      .call('admin', 'productGet', { id: options.id })
      .then(p2 => {
        this.setData({
          id: p2._id, name: p2.name, images: p2.images || [], price: (p2.price / 100).toFixed(2), stock: String(p2.stock), stockFrom: p2.stock,
          desc: p2.desc || '', fixedDate: !!p2.fixedDate, activityDate: p2.activityDate || '',
          activityStartTime: p2.activityStartTime || '', onShelf: !!p2.onShelf, soldCount: p2.soldCount || 0
        })
      })
      .catch(err => api.toast(err.message))
  },

  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  setType(e) {
    this.setData({ fixedDate: e.currentTarget.dataset.fixed === '1' })
  },

  toggleShelf(e) {
    this.setData({ onShelf: e.detail.value })
  },

  addImage() {
    const left = 6 - this.data.images.length
    if (left <= 0) return
    // 每張圖選好後依序進入裁剪畫面，手動調整 4:3 的範圍（商品詳情頁大圖就是 4:3）
    pickImages({ count: left, scale: '4:3' }).then(paths => {
      if (!paths.length) return
      wx.showLoading({ title: '上传中', mask: true })
      return Promise.all(
        paths.map(p =>
          wx.cloud.uploadFile({ cloudPath: `products/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`, filePath: p }).then(r => r.fileID)
        )
      )
        .then(ids => this.setData({ images: this.data.images.concat(ids) }))
        .catch(() => api.toast('上传失败，请重试'))
        .finally(() => wx.hideLoading())
    })
  },

  removeImage(e) {
    const images = this.data.images.slice()
    images.splice(e.currentTarget.dataset.index, 1)
    this.setData({ images })
  },

  save() {
    if (this.saving) return
    const d = this.data
    const price = yuanToFen(d.price)
    if (!price) return api.toast('请填写正确的价格（最多两位小数）')
    if (!/^\d+$/.test(d.stock)) return api.toast('请填写正确的库存')
    this.saving = true
    api
      .call('admin', 'productSave', {
        product: {
          _id: d.id || undefined, name: d.name, images: d.images, price, stock: Number(d.stock), stockFrom: d.id ? d.stockFrom : undefined, opId: this.opId, desc: d.desc,
          fixedDate: d.fixedDate, activityDate: d.activityDate, activityStartTime: d.activityStartTime, onShelf: d.onShelf
        }
      })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch(err => {
        this.saving = false
        api.toast(err.message)
      })
  },

  // 有人買過也可以刪除（澄清 L4）：已買的券照常可用、可退款；刪除不能恢復
  remove() {
    const sold = this.data.soldCount || 0
    wx.showModal({
      title: '删除商品',
      content: sold > 0
        ? `该商品已售出 ${sold} 件。删除后客人已买的券照常可以使用和退款，但商品无法恢复。确定删除？`
        : '删除后无法恢复。确定删除这个商品？',
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        api
          .call('admin', 'productDelete', { id: this.data.id })
          .then(() => wx.navigateBack())
          .catch(err => api.toast(err.message))
      }
    })
  }
})
