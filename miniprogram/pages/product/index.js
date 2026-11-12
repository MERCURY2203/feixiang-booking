// 商品詳情（規格書「活動 · 商品詳情頁」）：底部懸浮欄 = 價格小計 + 立即购买 + 加入购物车
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const checkout = require('../../utils/checkout')
const { formatFen } = require('../../utils/money')

Page({
  data: { p: null, qty: 1, subtotalText: '' },

  onLoad(options) {
    this.id = options.id
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
      })
      .catch(err => {
        api.toast(err.message)
        setTimeout(() => wx.switchTab({ url: '/pages/activity/index' }), 1200)
      })
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
