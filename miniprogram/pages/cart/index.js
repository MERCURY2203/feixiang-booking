// 購物車頁（規格書「購物車」，任務 T7）
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const checkout = require('../../utils/checkout')
const { formatFen } = require('../../utils/money')

Page({
  data: { courts: [], products: [], invalidCount: 0, total: 0, totalText: '¥0.00', loaded: false, empty: true },

  onShow() {
    this.refresh()
  },

  refresh() {
    const items = cart.list()
    if (!items.length) {
      this.setData({ courts: [], products: [], invalidCount: 0, total: 0, totalText: '¥0.00', loaded: true, empty: true })
      return Promise.resolve([])
    }
    return api
      .call('booking', 'quote', { items })
      .then(q => {
        this.quoted = q
        this.render(q)
        return q
      })
      .catch(err => api.toast(err.message))
  },

  render(q) {
    const view = i => ({
      ...i,
      priceText: formatFen(i.price),
      subtotalText: formatFen(i.price * i.qty)
    })
    const valid = q.filter(i => i.valid)
    const total = valid.reduce((s, i) => s + i.price * i.qty, 0)
    this.setData({
      courts: q.filter(i => i.type === 'court').map(view),
      products: q.filter(i => i.type === 'product').map(view),
      invalidCount: q.filter(i => !i.valid).length,
      total,
      totalText: formatFen(total),
      loaded: true,
      empty: !q.length
    })
  },

  removeCourt(e) {
    const it = this.data.courts[e.currentTarget.dataset.index]
    cart.remove(i => cart.sameItem(i, it))
    this.quoted = this.quoted.filter(i => !cart.sameItem(i, it))
    this.render(this.quoted)
  },

  removeProduct(e) {
    const it = this.data.products[e.currentTarget.dataset.index]
    cart.remove(i => cart.sameItem(i, it))
    this.quoted = this.quoted.filter(i => !cart.sameItem(i, it))
    this.render(this.quoted)
  },

  changeQty(e) {
    const index = e.currentTarget.dataset.index
    const delta = +e.currentTarget.dataset.delta
    const it = this.data.products[index]
    const qty = it.qty + delta
    if (qty < 1) return
    if (it.stock !== undefined && qty > it.stock) {
      api.toast(`库存仅剩 ${it.stock}`)
      return
    }
    cart.setProductQty(it.productId, qty)
    const q = this.quoted.find(i => cart.sameItem(i, it))
    q.qty = qty
    this.render(this.quoted)
  },

  clearInvalid() {
    const bad = this.quoted.filter(i => !i.valid)
    cart.remove(i => bad.some(b => cart.sameItem(i, b)))
    this.quoted = this.quoted.filter(i => i.valid)
    this.render(this.quoted)
  },

  clearAll() {
    wx.showModal({
      title: '清空购物车',
      content: '确定清空购物车里的全部项目？',
      success: res => {
        if (!res.confirm) return
        cart.save([])
        this.quoted = []
        this.render([])
      }
    })
  },

  async goCheckout() {
    const before = this.quoted || []
    const after = await this.refresh()
    if (!after || !after.length) return
    // 價格變動先提示（澄清 B4）
    const changed = after.filter(a => {
      const b = before.find(x => cart.sameItem(x, a))
      return a.valid && b && b.valid && b.price !== a.price
    })
    if (changed.length) {
      const lines = changed.map(a => {
        const b = before.find(x => cart.sameItem(x, a))
        return `${a.label}：${formatFen(b.price)} → ${formatFen(a.price)}`
      })
      await checkout.modal({ title: '以下价格已变动', content: `${lines.join('\n')}\n新合计：${this.data.totalText}`, showCancel: false, confirmText: '我知道了' })
    }
    const valid = after.filter(i => i.valid)
    if (!valid.length) {
      api.toast('没有可结算的项目')
      return
    }
    const items = valid.map(i => (i.type === 'court' ? { type: 'court', date: i.date, court: i.court, hour: i.hour } : { type: 'product', productId: i.productId, qty: i.qty }))
    const r = await checkout.start(this, items, { fromCart: true })
    if (r.invalid) this.refresh()
  }
})
