// 核銷記錄：時間、商品、張數、客人手機號、操作人；當天記錄可撤銷並留痕
const api = require('../../../utils/api')
const { now, beijingParts, pad } = require('../../../utils/time')

function today() {
  const p = beijingParts(now())
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

Page({
  data: { day: '', today: '', list: [], loaded: false },

  onLoad() {
    const d = today()
    this.setData({ day: d, today: d })
    this.load()
  },

  load() {
    api
      .call('admin', 'verifyLogs', { day: this.data.day })
      .then(r => this.setData({ list: r.list, loaded: true }))
      .catch(err => api.toast(err.message))
  },

  pickDay(e) {
    this.setData({ day: e.detail.value })
    this.load()
  },

  undo(e) {
    const index = e.currentTarget.dataset.index
    const log = this.data.list[index]
    wx.showModal({
      title: '撤销核销',
      content: `撤销「${log.name}」${log.qty} 张的核销？张数会退回可用。`,
      confirmText: '撤销',
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        api
          .call('admin', 'verifyUndo', { logId: log._id })
          .then(() => this.load())
          .catch(err => api.toast(err.message))
      }
    })
  }
})
