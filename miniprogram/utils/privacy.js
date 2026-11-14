// 協議同意（規格書「首次打開」，澄清 L1）：不同意也能瀏覽；
// 需要帳號的操作（下單、看訂單、設頭像暱稱、授權手機號、掃碼綁定）先呼叫 ensure(page)
const { PRIVACY_VERSION } = require('../config')

const STORAGE_KEY = 'privacyAgreedVersion'

function agreed() {
  return wx.getStorageSync(STORAGE_KEY) === PRIVACY_VERSION
}

// 已同意直接返回 true；否則彈出頁面上的同意畫面（<privacy-modal id="privacy" />），
// 客人同意返回 true，不同意返回 false
function ensure(page) {
  if (agreed()) return Promise.resolve(true)
  const modal = page && page.selectComponent && page.selectComponent('#privacy')
  if (!modal) {
    wx.showToast({ title: '请先在首页同意用户协议与隐私政策', icon: 'none' })
    return Promise.resolve(false)
  }
  return modal.ask()
}

module.exports = { STORAGE_KEY, agreed, ensure }
