// 商品詳情（規格書「活動 · 商品詳情頁」）：底部懸浮欄 = 價格小計 + 立即购买 + 加入购物车
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const checkout = require('../../utils/checkout')
const { formatFen } = require('../../utils/money')
const share = require('../../utils/share')

Page({
  data: { p: null, qty: 1, subtotalText: '', single: null },

  onLoad(options) {
    this.id = options.id
    // 分享帶過來的名稱和價格：朋友圈單頁模式讀不到資料時用來顯示（澄清 M5）
    this.shared = { name: options.n ? decodeURIComponent(options.n) : '', price: Number(options.pr) || 0 }
  },

  onShow() {
    this.loadProduct()
  },

  loadProduct() {
    return api
      .call('booking', 'product', { id: this.id })
      .then(p => {
        const qty = Math.min(this.data.qty, Math.max(1, p.stock))
        this.setData({ p: { ...p, priceText: formatFen(p.price) }, qty, subtotalText: formatFen(p.price * qty) })
        this.loadShareImage(p.images[0])
      })
      .catch(err => {
        if (share.isSinglePage()) {
          this.setData({ single: { name: this.shared.name || '飞翔球馆活动', priceText: this.shared.price ? formatFen(this.shared.price) : '' } })
          return
        }
        // 分享出去的活動已下架或刪除：提示後帶到活動列表（澄清 M4）
        api.toast(err.code === 'OFF_SHELF' ? '活动已下架' : err.message)
        setTimeout(() => wx.switchTab({ url: '/pages/activity/index' }), 1200)
      })
  },

  // 分享卡片的圖片要用網址：把封面圖的雲存儲編號換成臨時網址
  loadShareImage(fileId) {
    if (!fileId || this.shareImageFor === fileId || !wx.cloud || !wx.cloud.getTempFileURL) return
    this.shareImageFor = fileId
    wx.cloud
      .getTempFileURL({ fileList: [fileId] })
      .then(r => (this.shareImage = (r.fileList[0] || {}).tempFileURL || ''))
      .catch(() => (this.shareImage = ''))
  },

  onShareAppMessage() {
    const p = this.data.p
    return share.productShare(p, this.shareImage, p ? p.priceText : '').app
  },

  onShareTimeline() {
    const p = this.data.p
    return share.productShare(p, this.shareImage, p ? p.priceText : '').timeline
  },

  change(e) {
    const p = this.data.p
    const qty = this.data.qty + +e.currentTarget.dataset.delta
    if (qty < 1) return
    if (qty > 99) return api.toast('每种商品一次最多买 99 张')
    if (qty > p.stock) {
      api.toast(`库存仅剩 ${p.stock}`)
      return
    }
    this.setData({ qty, subtotalText: formatFen(p.price * qty) })
  },

  addCart() {
    const p = this.data.p
    if (p.stock <= 0) return
    const inCart = cart.list().find(i => i.type === 'product' && i.productId === p._id)
    if ((inCart ? inCart.qty : 0) + this.data.qty > p.stock) {
      api.toast(`库存仅剩 ${p.stock}`)
      return
    }
    if (!cart.addProduct(p._id, this.data.qty)) return api.toast(cart.FULL_TIP)
    wx.showToast({ title: '已加入购物车', icon: 'none' })
  },

  async buyNow() {
    if (this.data.p.stock <= 0) return
    const r = await checkout.start(this, [{ type: 'product', productId: this.data.p._id, qty: this.data.qty }], { expectTotal: this.data.p.price * this.data.qty })
    // 價格已變動或商品失效：重新讀取商品，顯示新價格和庫存，客人看過後再按一次（澄清 H4）
    if (r && r.invalid) await this.loadProduct()
  }
})
