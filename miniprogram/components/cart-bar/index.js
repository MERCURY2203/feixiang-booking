// 底部結算欄（規格書「購物車 · 底部結算欄」，澄清 M3）：訂場頁和活動頁共用，取代原來的右下角浮窗。
// 左：購物車圖標＋總件數；中：整個購物車合計（不含失效項，和購物車頁同一算法：伺服器 quote）；右：去结算。
// 頁面在購物車有變動後呼叫 refresh()
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const { formatFen } = require('../../utils/money')

Component({
  properties: {
    mode: { type: String, value: 'booking' } // booking：顯示「已选 N 场」；activity：只顯示件數
  },

  data: { count: 0, courtCount: 0, totalText: '¥0.00', empty: true },

  lifetimes: {
    attached() {
      this.refresh()
    }
  },

  pageLifetimes: {
    show() {
      this.refresh()
    }
  },

  methods: {
    refresh() {
      const items = cart.list()
      this.setData({ count: cart.count(), courtCount: items.filter(i => i.type === 'court').length, empty: !items.length })
      const seq = (this.seq = (this.seq || 0) + 1)
      if (!items.length) {
        this.setData({ totalText: '¥0.00' })
        return Promise.resolve(0)
      }
      // 連續點格子時只採用最後一次的結果
      return api
        .call('booking', 'quote', { items })
        .then(q => {
          if (seq !== this.seq) return
          const total = q.filter(i => i.valid).reduce((s, i) => s + i.price * i.qty, 0)
          this.setData({ totalText: formatFen(total) })
          return total
        })
        .catch(() => {
          if (seq === this.seq) this.setData({ totalText: '—' })
        })
    },

    goCart() {
      wx.navigateTo({ url: '/pages/cart/index' })
    },

    goCheckout() {
      if (this.data.empty) return
      wx.navigateTo({ url: '/pages/cart/index' })
    }
  }
})
