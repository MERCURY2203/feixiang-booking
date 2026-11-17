// 球局詳情（規格書「球局」，澄清 N 節）：資料、報名名單、底部報名欄；報名框裡第一次要選性別
const api = require('../../utils/api')
const checkout = require('../../utils/checkout')
const { formatFen } = require('../../utils/money')
const share = require('../../utils/share')
const { LEGAL } = require('../../config')

Page({
  data: { g: null, single: null, sheet: false, gender: '', address: (LEGAL && LEGAL.address) || '' },

  onLoad(options) {
    this.id = options.id
    // 分享帶過來的標題和價格：朋友圈單頁模式讀不到資料時用來顯示
    this.shared = { title: options.n ? decodeURIComponent(options.n) : '', pm: Number(options.pm) || 0, pf: Number(options.pf) || 0 }
  },

  onShow() {
    this.load()
  },

  load() {
    return api
      .call('booking', 'game', { id: this.id })
      .then(g => {
        const view = { ...g, priceMText: formatFen(g.priceM), priceFText: formatFen(g.priceF) }
        view.button = this.buttonOf(view)
        this.setData({ g: view, gender: this.data.gender || g.myGender })
        this.loadShareImage(g.cover)
      })
      .catch(err => {
        if (share.isSinglePage()) {
          const s = this.shared
          this.setData({ single: { title: s.title || '飞翔球馆球局', price: s.pm ? `男${formatFen(s.pm)} 女${formatFen(s.pf)}` : '' } })
          return
        }
        // 球局已取消或不存在：提示後帶到球局列表
        api.toast(err.code === 'GAME_GONE' ? '球局已取消' : err.message)
        getApp().globalData.activityTab = 'game'
        setTimeout(() => wx.switchTab({ url: '/pages/activity/index' }), 1200)
      })
  },

  // 底部按鈕文字和能不能按
  buttonOf(g) {
    if (g.mine) return { text: g.mine.state === 'w' ? `候补第 ${g.mine.rank} 位 · 查看订单` : g.mine.state === 'j' ? '已报名 · 查看订单' : '待支付 · 查看订单', go: true }
    if (g.status === 'cancelled') return { text: '已取消', off: true }
    if (g.status === 'started') return { text: '已开始', off: true }
    const seat = g.myGender ? (g.myGender === 'F' ? g.seatF : g.seatM) : g.seatM || g.seatF
    return { text: seat ? '立即报名' : '候补报名' }
  },

  loadShareImage(fileId) {
    if (!fileId || this.shareImageFor === fileId || !wx.cloud || !wx.cloud.getTempFileURL) return
    this.shareImageFor = fileId
    wx.cloud
      .getTempFileURL({ fileList: [fileId] })
      .then(r => (this.shareImage = (r.fileList[0] || {}).tempFileURL || ''))
      .catch(() => (this.shareImage = ''))
  },

  onShareAppMessage() {
    return share.gameShare(this.data.g, this.shareImage).app
  },

  onShareTimeline() {
    return share.gameShare(this.data.g, this.shareImage).timeline
  },

  tapMain() {
    const g = this.data.g
    if (!g || g.button.off) return
    if (g.button.go) {
      wx.navigateTo({ url: `/pages/order/detail/index?id=${g.mine.orderId}` })
      return
    }
    this.setData({ sheet: true })
  },

  pick(e) {
    if (this.data.g.myGender) return // 已選過性別不能自行修改
    this.setData({ gender: e.currentTarget.dataset.g })
  },

  closeSheet() {
    this.setData({ sheet: false })
  },

  async confirm() {
    const g = this.data.g
    const gender = g.myGender || this.data.gender
    if (!gender) return api.toast('请选择性别')
    if (this.busy) return
    this.busy = true
    this.setData({ sheet: false })
    try {
      const r = await checkout.start(this, [], { action: 'gameJoin', params: { gameId: g._id, gender } })
      if (!r.ok) await this.load()
    } finally {
      this.busy = false
    }
  },

  noop() {}
})
