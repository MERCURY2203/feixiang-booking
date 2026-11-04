// 右下角圓形購物車浮窗，顯示件數（規格書「購物車 · 浮窗」）
Component({
  properties: { count: { type: Number, value: 0 } },
  methods: {
    go() {
      wx.navigateTo({ url: '/pages/cart/index' })
    }
  }
})
