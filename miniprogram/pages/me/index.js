// 我的：個人資料、訂單入口（T11）、協議、註銷（T23）、管理後台入口（只對老闆／員工顯示，G7）
const api = require('../../utils/api')

function maskPhone(p) {
  return p ? `${p.slice(0, 3)}****${p.slice(-4)}` : ''
}

Page({
  data: { user: null, phoneMasked: '', isAdmin: false, editingName: false },

  onShow() {
    const app = getApp()
    app.userReady
      .then(() => app.refreshUser())
      .then(user => this.applyUser(user))
      .catch(err => api.toast(err.message))
  },

  applyUser(user) {
    this.setData({
      user,
      phoneMasked: maskPhone(user && user.phone),
      isAdmin: !!user && (user.role === 'owner' || user.role === 'staff')
    })
  },

  // 一鍵使用微信頭像（微信官方「頭像暱稱填寫能力」）
  onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl
    const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.png`
    wx.cloud
      .uploadFile({ cloudPath, filePath: tempPath })
      .then(res => api.call('user', 'updateProfile', { avatar: res.fileID }))
      .then(user => this.applyUser(user))
      .catch(() => api.toast('头像上传失败，请重试'))
  },

  startEditName() {
    this.setData({ editingName: true })
  },

  onNicknameDone(e) {
    const nickname = (e.detail.value || '').trim()
    this.setData({ editingName: false })
    if (!nickname || nickname === (this.data.user && this.data.user.nickname)) return
    api
      .call('user', 'updateProfile', { nickname })
      .then(user => this.applyUser(user))
      .catch(err => api.toast(err.message))
  },

  onPhone(e) {
    if (!e.detail.code) return
    api
      .call('user', 'bindPhone', { code: e.detail.code })
      .then(user => {
        getApp().globalData.user = user
        this.applyUser(user)
      })
      .catch(err => api.toast(err.message))
  },

  onUserChange(e) {
    this.applyUser(e.detail)
  },

  goOrders() {
    api.toast('我的订单开发中（任务 T11）')
  },

  openDocs() {
    wx.showModal({
      title: '用户协议与隐私政策',
      content: '正式文本待球馆提供并经法律人士审阅后填入。',
      showCancel: false
    })
  },

  cancelAccount() {
    api.toast('注销账号开发中（任务 T23）')
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/home/index' })
  }
})
