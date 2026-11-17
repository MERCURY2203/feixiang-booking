// 管理球局（規格書「管理端 · 球局管理」，澄清 N7、N11、N12）：名單、移出並退款、改性別、編輯說明、取消球局
const api = require('../../../utils/api')
const { formatFen } = require('../../../utils/money')

function modal(opts) {
  return new Promise(resolve => wx.showModal({ ...opts, success: r => resolve(r.confirm), fail: () => resolve(false) }))
}

Page({
  data: { g: null },

  onLoad(options) {
    this.id = options.id
  },

  onShow() {
    this.load()
  },

  load() {
    return api
      .call('admin', 'gameGet', { id: this.id })
      .then(g => this.setData({
        g: { ...g, incomeText: formatFen(g.income), priceMText: formatFen(g.priceM), priceFText: formatFen(g.priceF), list: g.list.map(p => ({ ...p, priceText: formatFen(p.price) })) }
      }))
      .catch(err => api.toast(err.message))
  },

  async kick(e) {
    const p = this.data.g.list[e.currentTarget.dataset.index]
    if (!p.paid) return api.toast('该客人还没付款，5 分钟内未付款会自动放出名额')
    const ok = await modal({ title: '移出并退款', content: `把「${p.nick}」移出球局，${p.priceText} 全额原路退回？空出的名额会按顺序补给候补。`, confirmColor: '#E54545' })
    if (!ok) return
    wx.showLoading({ title: '处理中', mask: true })
    api
      .call('admin', 'gameKick', { id: this.id, itemId: p.itemId })
      .then(r => {
        wx.hideLoading()
        wx.showToast({ title: r.processing ? '已移出，退款处理中' : `已移出，退款 ${formatFen(r.amount)}`, icon: 'none' })
        this.load()
      })
      .catch(err => {
        wx.hideLoading()
        api.toast(err.message)
        this.load()
      })
  },

  // 只改客人帳號上的性別，影響之後的報名，不改這場（澄清 N7）
  setGender(e) {
    const p = this.data.g.list[e.currentTarget.dataset.index]
    wx.showActionSheet({
      itemList: ['男', '女'],
      success: async res => {
        const gender = res.tapIndex === 1 ? 'F' : 'M'
        const ok = await modal({ title: '修改性别', content: `把「${p.nick}」的性别改为${gender === 'F' ? '女' : '男'}？只影响他之后的报名，这一场不变。` })
        if (!ok) return
        api
          .call('admin', 'setGender', { userId: p.userId, gender })
          .then(() => {
            wx.showToast({ title: '已修改', icon: 'none' })
            this.load()
          })
          .catch(err => api.toast(err.message))
      }
    })
  },

  edit() {
    wx.navigateTo({ url: `/pages/admin/game-edit/index?id=${this.id}` })
  },

  async cancel() {
    const ok = await modal({ title: '取消球局', content: '取消后所有已付款的人（含候补）全额退款，锁住的场地放回去给客人订。确定取消？', confirmColor: '#E54545', confirmText: '取消球局', cancelText: '再想想' })
    if (!ok) return
    wx.showLoading({ title: '处理中', mask: true })
    api
      .call('admin', 'gameCancel', { id: this.id })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已取消，正在退款', icon: 'none' })
        this.load()
      })
      .catch(err => {
        wx.hideLoading()
        api.toast(err.message)
      })
  }
})
