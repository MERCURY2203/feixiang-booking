// 員工管理（僅老闆）：列表、改備註名、邀請員工或組局員（邀請二維碼，10 分鐘一次性，澄清 N1）、移除
const api = require('../../../utils/api')
const { formatBeijing, now } = require('../../../utils/time')

Page({
  data: { list: [], loaded: false, invite: null, leftText: '' },

  onShow() {
    this.load()
  },

  onUnload() {
    clearInterval(this.timer)
  },

  load() {
    api
      .call('staff', 'listStaff')
      .then(list => {
        this.setData({
          loaded: true,
          list: list.map(s => ({ ...s, joinedText: formatBeijing(s.staffSince), roleText: s.role === 'host' ? '组局员' : '员工' }))
        })
      })
      .catch(err => api.toast(err.message))
  },

  editRemark(e) {
    const item = this.data.list[e.currentTarget.dataset.index]
    wx.showModal({
      title: '修改备注名',
      editable: true,
      placeholderText: '例如：小王-前台',
      content: item.remark || '',
      success: res => {
        if (!res.confirm) return
        api
          .call('staff', 'setRemark', { userId: item._id, remark: (res.content || '').trim() })
          .then(() => {
            // 只更新這一張卡片，頁面不跳動（G1）
            this.setData({ [`list[${e.currentTarget.dataset.index}].remark`]: (res.content || '').trim() })
          })
          .catch(err => api.toast(err.message))
      }
    })
  },

  remove(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.list[index]
    wx.showModal({
      title: `移除${item.roleText}`,
      content: item.role === 'host'
        ? `确定移除「${item.remark || item.nickname || '该组局员'}」？移除后立即失去发起球局的权限，他发起的球局保留，由员工和老板继续管理。`
        : `确定移除「${item.remark || item.nickname || '该员工'}」？移除后立即失去管理权限。别忘了同时把他移出企业微信群。`,
      confirmText: '移除',
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        api
          .call('staff', 'removeStaff', { userId: item._id })
          .then(() => {
            const list = this.data.list.slice()
            list.splice(index, 1)
            this.setData({ list })
          })
          .catch(err => api.toast(err.message))
      }
    })
  },

  createInvite(e) {
    const type = e.currentTarget.dataset.type === 'host' ? 'host' : 'staff'
    wx.showLoading({ title: '生成中' })
    api
      .call('staff', 'createInvite', { type })
      .then(invite => {
        wx.hideLoading()
        this.setData({ invite: { ...invite, typeText: type === 'host' ? '组局员' : '员工' } })
        this.tick()
        clearInterval(this.timer)
        this.timer = setInterval(() => this.tick(), 1000)
      })
      .catch(err => {
        wx.hideLoading()
        api.toast(err.message)
      })
  },

  tick() {
    const left = Math.max(0, Math.floor((this.data.invite.expiresAt - now()) / 1000))
    const m = Math.floor(left / 60)
    const s = String(left % 60).padStart(2, '0')
    this.setData({ leftText: left > 0 ? `${m}:${s} 后失效，只能使用一次` : '已失效，请重新生成' })
    if (left === 0) clearInterval(this.timer)
  },

  closeInvite() {
    clearInterval(this.timer)
    this.setData({ invite: null })
    this.load()
  },

  noop() {}
})
