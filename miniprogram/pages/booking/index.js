// 訂場首頁（規格書「訂場首頁」，任務 T5–T6）
// 點可訂格子 = 加入購物車（變藍）；再點移出。操作後只更新那一格，表格不跳（G1）
const api = require('../../utils/api')
const cart = require('../../utils/cart')
const { formatFen } = require('../../utils/money')
const { syncServerTime } = require('../../utils/time')

const REFRESH_MS = 15000

Page({
  data: {
    banners: [],
    days: [],
    date: '',
    courts: [],
    hours: [],
    cells: [],
    gridHeight: 400,
    cartCount: 0,
    loaded: false
  },

  onLoad() {
    this.load(true)
  },

  onShow() {
    this.setData({ cartCount: cart.count() })
    if (this.data.loaded) {
      this.measure()
      this.load(false)
    }
    this.timer = setInterval(() => this.load(false), REFRESH_MS)
  },

  onHide() {
    clearInterval(this.timer)
  },

  onUnload() {
    clearInterval(this.timer)
  },

  onReady() {
    this.measure()
  },

  measure() {
    const win = wx.getWindowInfo()
    wx.createSelectorQuery().select('.grid-anchor').boundingClientRect(rect => {
      if (rect) this.setData({ gridHeight: Math.max(240, Math.floor(win.windowHeight - rect.top)) })
    }).exec()
  },

  // 把伺服器返回的格子狀態轉成顯示用的樣式和文字
  view(raw, date) {
    return raw.map((row, r) =>
      row.map((c, ci) => {
        if (c.s === 'mine') return { cls: 'mine', text: '我的' }
        if (c.s === 'mypending') return { cls: 'mypending', text: '⏳' }
        if (c.s === 'past') return { cls: 'past', text: '' }
        if (c.s === 'taken') return { cls: 'taken', text: '' }
        const sel = cart.hasCourt(date, this.data.courts[ci] || ci + 1, this.data.hours[r] ? this.data.hours[r].hour : 0)
        return { cls: sel ? 'sel' : 'free', text: formatFen(c.p) }
      })
    )
  },

  load(first, date) {
    return api
      .call('booking', 'schedule', { date: date || this.data.date, withBanners: true })
      .then(res => {
        syncServerTime(res.serverNow)
        this.raw = res.cells
        const update = {}
        const sameHours = res.hours.length === this.data.hours.length && (!res.hours.length || res.hours[0].hour === this.data.hours[0].hour)
        const dateChanged = res.date !== this.data.date || !sameHours
        // 橫幅每次輪詢都檢查：限時橫幅到點自動出現／消失，有變化才刷新，避免輪播跳動
        const banners = res.banners || []
        const bannersKey = JSON.stringify(banners)
        if (bannersKey !== this.bannersKey) {
          this.bannersKey = bannersKey
          update.banners = banners
        }
        if (first || dateChanged) {
          update.days = res.days
          update.date = res.date
          update.courts = res.courts
          update.hours = res.hours
          this.setData(update)
          // 畫面（含橫幅）排好之後再量表格該有多高，否則量早了表格會比螢幕長
          this.setData({ cells: this.view(res.cells, res.date), loaded: true }, () => this.measure())
          return
        }
        // 輪詢刷新：只更新有變化的格子
        const next = this.view(res.cells, res.date)
        const diff = {}
        next.forEach((row, r) =>
          row.forEach((c, ci) => {
            const old = this.data.cells[r] && this.data.cells[r][ci]
            if (!old || old.cls !== c.cls || old.text !== c.text) diff[`cells[${r}][${ci}]`] = c
          })
        )
        if (res.days.length !== this.data.days.length || (res.days[0] && res.days[0].date !== this.data.days[0].date)) diff.days = res.days
        if (update.banners) diff.banners = update.banners
        // 橫幅出現或消失會改變表格上方的高度，要重新量
        if (Object.keys(diff).length) this.setData(diff, () => diff.banners && this.measure())
      })
      .catch(err => {
        if (first) api.toast(err.message)
      })
  },

  pickDate(e) {
    const date = e.currentTarget.dataset.date
    if (date === this.data.date) return
    this.load(false, date)
  },

  onCellTap(e) {
    const { r, c } = e.detail
    const cell = this.data.cells[r][c]
    if (cell.cls === 'mypending') return api.toast('这格是你的待支付订单，请尽快支付')
    if (cell.cls === 'past' || cell.cls === 'taken' || cell.cls === 'mine') return
    const court = this.data.courts[c]
    const hour = this.data.hours[r].hour
    const added = cart.toggleCourt(this.data.date, court, hour)
    if (added === null) return api.toast(cart.FULL_TIP)
    this.setData({
      [`cells[${r}][${c}].cls`]: added ? 'sel' : 'free',
      cartCount: cart.count()
    })
  },

  onBannerTap(e) {
    const t = this.data.banners[e.currentTarget.dataset.index].target || {}
    if (t.type === 'product') {
      api
        .call('booking', 'product', { id: t.productId })
        .then(() => wx.navigateTo({ url: `/pages/product/index?id=${t.productId}` }))
        .catch(() => wx.switchTab({ url: '/pages/activity/index' })) // 商品已下架則打開活動頁
    } else if (t.type === 'activity') {
      wx.switchTab({ url: '/pages/activity/index' })
    } else if (t.type === 'booking' && t.date) {
      if (this.data.days.some(d => d.date === t.date)) {
        this.load(false, t.date)
      } else api.toast('该日期暂不可预订')
    }
  }
})
