// 結算流程（規格書「下單、待支付與支付結果」）：
// 退款規則彈窗 → 授權手機號 → 訂單通知授權 → 建立訂單 → 微信付款 → 結果頁／待支付頁
const api = require('./api')
const cart = require('./cart')
const privacy = require('./privacy')
const { TPL_TIMEOUT_REFUND } = require('../config')

function modal(opts) {
  return new Promise(resolve => wx.showModal({ ...opts, success: res => resolve(res), fail: () => resolve({}) }))
}

function requestSubscribe() {
  if (!TPL_TIMEOUT_REFUND) return Promise.resolve()
  return new Promise(resolve => wx.requestSubscribeMessage({ tmplIds: [TPL_TIMEOUT_REFUND], complete: resolve }))
}

// 調起微信付款；模擬支付時用彈窗代替
function payOrder(orderId, payment, mock) {
  if (mock) {
    return modal({ title: '模拟支付', content: '商户号尚未配置，这是测试用的模拟支付。', confirmText: '确认支付', cancelText: '暂不支付' }).then(res => {
      if (!res.confirm) return false
      return api.call('booking', 'mockPay', { orderId }).then(() => true)
    })
  }
  return new Promise(resolve => {
    wx.requestPayment({
      ...payment,
      success: () => resolve(true),
      fail: () => resolve(false)
    })
  })
}

function afterPay(orderId, paid) {
  if (paid) wx.redirectTo({ url: `/pages/order/result/index?id=${orderId}` })
  else wx.redirectTo({ url: `/pages/order/pay/index?id=${orderId}` })
}

// items：[{ type:'court', date, court, hour } | { type:'product', productId, qty }]
// 球局報名：items 傳空，action 'gameJoin'、params { gameId, gender }（澄清 N15，與購買同一流程）
// 返回 { ok, invalid }
async function start(page, items, { fromCart, expectTotal, action = 'checkout', params } = {}) {
  // 還沒同意協議：先彈出同意畫面，不同意就不下單（澄清 L1）
  if (!(await privacy.ensure(page))) return { ok: false }
  const hasCourt = items.some(i => i.type === 'court')
  if (hasCourt) {
    await modal({
      title: '退款规则',
      content: '羽毛球场地可在开场前 15 分钟之前取消并全额退款，之后不能自行退款。',
      showCancel: false,
      confirmText: '我知道了'
    })
  }
  await requestSubscribe()

  const app = getApp()
  await app.userReady
  if (!app.globalData.user.phone) {
    const ok = await page.selectComponent('#phoneSheet').ask()
    if (!ok) return { ok: false }
  }

  wx.showLoading({ title: '提交中', mask: true })
  let res
  try {
    res = await api.call('booking', action, params || { items, expectTotal })
  } catch (err) {
    wx.hideLoading()
    if (err.code === 'HAS_PENDING') {
      const r = await modal({ title: '提示', content: '你有一笔待支付订单', confirmText: '去支付', cancelText: '取消旧订单' })
      if (r.confirm) {
        wx.navigateTo({ url: `/pages/order/pay/index?id=${err.orderId || ''}` })
      } else if (r.cancel) {
        await api.call('booking', 'cancel', { orderId: err.orderId }).catch(() => {})
        api.toast('旧订单已取消，请重新结算')
      }
      return { ok: false }
    }
    if (err.code === 'PRICE_CHANGED') {
      await modal({ title: '价格已变动', content: err.message, showCancel: false, confirmText: '我知道了' })
      return { ok: false, invalid: true }
    }
    api.toast(err.message)
    return { ok: false, invalid: err.code === 'INVALID_ITEMS' }
  }
  wx.hideLoading()
  // 付款成功後才從購物車移除（結果頁確認付款成功時處理）
  if (fromCart) wx.setStorageSync('lastCheckout', { orderId: res.orderId, items })
  const paid = await payOrder(res.orderId, res.payment, res.mock)
  afterPay(res.orderId, paid)
  return { ok: true }
}

module.exports = { start, payOrder, afterPay, modal }
