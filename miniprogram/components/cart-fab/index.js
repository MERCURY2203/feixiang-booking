// 右下角購物車浮窗，顯示件數（規格書「購物車 · 浮窗」）
// 可以收到右邊：往右滑浮窗，或點浮窗左上角的小箭頭，它會縮成貼著右邊緣的小標籤（仍顯示件數）；
// 點小標籤或往左滑，展開回圓形。收起狀態會記住（活動頁和訂場頁共用）
const KEY = 'cartFabCollapsed'

function readCollapsed() {
  try {
    return !!wx.getStorageSync(KEY)
  } catch (e) {
    return false
  }
}

function saveCollapsed(v) {
  try {
    wx.setStorageSync(KEY, v ? 1 : 0)
  } catch (e) {
    // 存不了也不影響使用
  }
}

Component({
  properties: { count: { type: Number, value: 0 } },
  data: { collapsed: false },

  lifetimes: {
    attached() {
      this.setData({ collapsed: readCollapsed() })
    }
  },

  pageLifetimes: {
    show() {
      this.setData({ collapsed: readCollapsed() })
    }
  },

  methods: {
    go() {
      wx.navigateTo({ url: '/pages/cart/index' })
    },
    setCollapsed(v) {
      this.setData({ collapsed: v })
      saveCollapsed(v)
    },
    collapse() {
      this.setCollapsed(true)
    },
    expand() {
      this.setCollapsed(false)
    },
    onTouchStart(e) {
      this.startX = e.touches[0].clientX
    },
    // 往右滑 = 收起；收起後往左滑 = 展開
    onTouchEnd(e) {
      const dx = e.changedTouches[0].clientX - this.startX
      if (!this.data.collapsed && dx > 30) this.setCollapsed(true)
      else if (this.data.collapsed && dx < -20) this.setCollapsed(false)
    }
  }
})
