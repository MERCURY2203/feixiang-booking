// 微信支付雲調用（cloud.cloudPay）封裝
// 雲函數環境變量 MCH_ID 未設定時進入「模擬支付」，方便商戶號綁定前先測流程；設定後自動用真實微信支付
const u = require('./util')

const MCH_ID = process.env.MCH_ID || ''
const MOCK = !MCH_ID

function nonce() {
  return Math.random().toString(36).slice(2, 18)
}

// 下單：返回給 wx.requestPayment 用的參數
async function unifiedOrder(cloud, order, body) {
  if (MOCK) return { mock: true }
  const res = await cloud.cloudPay.unifiedOrder({
    body,
    outTradeNo: order._id,
    spbillCreateIp: '127.0.0.1',
    subMchId: MCH_ID,
    totalFee: order.totalFee,
    envId: cloud.getWXContext().ENV,
    functionName: 'payNotify',
    nonceStr: nonce(),
    tradeType: 'JSAPI',
    timeStart: u.toWxTime(order.createdAt),
    timeExpire: u.toWxTime(order.expiresAt)
  })
  if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
    throw new Error(`unifiedOrder failed: ${res.returnMsg || res.errCodeDes || ''}`)
  }
  return res.payment
}

// 查單：返回 { paid: bool, payTime: 時間戳, state }
async function queryOrder(cloud, order) {
  if (MOCK) return { paid: !!order.mockPaidAt, payTime: order.mockPaidAt || 0, state: order.mockPaidAt ? 'SUCCESS' : 'NOTPAY' }
  const res = await cloud.cloudPay.queryOrder({ subMchId: MCH_ID, outTradeNo: order._id, nonceStr: nonce() })
  if (res.returnCode !== 'SUCCESS') throw new Error('queryOrder failed')
  if (res.resultCode !== 'SUCCESS') {
    if (res.errCode === 'ORDERNOTEXIST') return { paid: false, payTime: 0, state: 'NOTEXIST' }
    throw new Error(`queryOrder failed: ${res.errCode}`)
  }
  const paid = res.tradeState === 'SUCCESS' || res.tradeState === 'REFUND'
  return { paid, payTime: paid ? u.parseWxTime(res.timeEnd) : 0, state: res.tradeState }
}

// 關單：微信規定下單 5 分鐘後才能關
async function closeOrder(cloud, order) {
  if (MOCK) return true
  const res = await cloud.cloudPay.closeOrder({ subMchId: MCH_ID, outTradeNo: order._id, nonceStr: nonce() })
  if (res.returnCode !== 'SUCCESS') throw new Error('closeOrder failed')
  // 已關閉、已支付等情況也算「不能再付款」，交給查單判斷
  return res.resultCode === 'SUCCESS' || res.errCode === 'ORDERCLOSED'
}

// 退款：同一個 outRefundNo 重試，微信只退一次
async function refund(cloud, order, outRefundNo, refundFee) {
  if (MOCK) return true
  const res = await cloud.cloudPay.refund({
    subMchId: MCH_ID,
    nonceStr: nonce(),
    outTradeNo: order._id,
    outRefundNo,
    totalFee: order.totalFee,
    refundFee
  })
  if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
    throw new Error(`refund failed: ${res.errCodeDes || res.returnMsg || res.errCode || ''}`)
  }
  return true
}

module.exports = { MOCK, unifiedOrder, queryOrder, closeOrder, refund }
