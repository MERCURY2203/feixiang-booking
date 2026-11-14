// 我的：個人資料、訂單入口（T11）、協議、註銷（T23）、管理後台入口（只對老闆／員工顯示，G7）
const api = require('../../utils/api')
const privacy = require('../../utils/privacy')

function maskPhone(p) {
  return p ? `${p.slice(0, 3)}****${p.slice(-4)}` : ''
}

Page({
  // agreed：已同意協議。未同意時頭像、暱稱、手機號、訂單要先彈出同意畫面（澄清 L1）
  data: { user: null, phoneMasked: '', isAdmin: false, editingName: false, agreed: false },

  onShow() {
    this.setData({ agreed: privacy.agreed() })
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
    if (!e.detail.code) {
      const msg = e.detail.errMsg || ''
      if (msg && !/deny|cancel/i.test(msg)) api.toast(`授权失败：${msg}`)
      return
    }
    api
      .call('user', 'bindPhone', { code: e.detail.code })
      .then(user => {
        getApp().globalData.user = user
        this.applyUser(user)
      })
      .catch(err => api.toast(err.message))
  },

  onUserChange(e) {
    this.setData({ agreed: privacy.agreed() })
    this.applyUser(e.detail)
  },

  // 還沒同意協議時點頭像、暱稱、手機號：先彈出同意畫面
  askAgree() {
    return privacy.ensure(this).then(ok => {
      if (ok) this.setData({ agreed: true })
      return ok
    })
  },

  goOrders() {
    this.askAgree().then(ok => ok && wx.navigateTo({ url: '/pages/order/list/index' }))
  },

  openDocs() {
    wx.showActionSheet({
      itemList: ['用户协议', '隐私政策'],
      success: res => wx.navigateTo({ url: `/pages/legal/index?type=${res.tapIndex === 0 ? 'agreement' : 'privacy'}` })
    })
  },

  // 註銷帳號：二次確認；有未使用的場地或券時提示先處理（任務 T23）
  cancelAccount() {
    if (!this.data.agreed || !this.data.user || !this.data.user._id) {
      wx.showModal({ title: '提示', content: '你还没有同意协议，我们没有保存你的任何资料，无需注销。', showCancel: false })
      return
    }
    wx.showModal({
      title: '注销账号',
      content: '注销后将删除你的手机号、头像和昵称，且无法恢复。确定注销？',
      confirmText: '继续',
      confirmColor: '#E54545',
      success: res => {
        if (!res.confirm) return
        wx.showModal({
          title: '再次确认',
          content: '真的要注销账号吗？',
          confirmText: '确认注销',
          confirmColor: '#E54545',
          success: r2 => {
            if (!r2.confirm) return
            api
              .call('user', 'deleteAccount')
              .then(() => {
                wx.clearStorageSync()
                wx.showModal({ title: '已注销', content: '账号已注销，感谢你的使用。', showCancel: false, success: () => wx.exitMiniProgram() })
              })
              .catch(err => wx.showModal({ title: '无法注销', content: err.message, showCancel: false }))
          }
        })
      }
    })
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/home/index' })
  }
})
