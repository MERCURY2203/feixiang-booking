// 微信支付雲調用（cloud.cloudPay）封裝
//
// 支付模式（雲函數環境變量）：
//   MCH_ID=商戶號          → 真實微信支付
//   PAY_MODE=mock          → 模擬支付（只用於測試，必須明確開啟）
//   兩者都沒有             → 一律報錯「支付未配置」，不會悄悄進入模擬模式
const u = require('./util')

const MCH_ID = process.env.MCH_ID || ''
const MOCK = process.env.PAY_MODE === 'mock' && !MCH_ID

function assertConfigured() {
  if (!MOCK && !MCH_ID) throw new Error('支付未配置，请联系球馆')
}

function nonce() {
  return Math.random().toString(36).slice(2, 18)
}

// 下單：返回給 wx.requestPayment 用的參數
async function unifiedOrder(cloud, order, body) {
  assertConfigured()
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

// 查單（可信來源）：返回 { paid, payTime, totalFee, state }
async function queryOrder(cloud, order) {
  assertConfigured()
  if (MOCK) {
    return { paid: !!order.mockPaidAt, payTime: order.mockPaidAt || 0, totalFee: order.mockPaidAt ? order.totalFee : 0, state: order.mockPaidAt ? 'SUCCESS' : 'NOTPAY' }
  }
  const res = await cloud.cloudPay.queryOrder({ subMchId: MCH_ID, outTradeNo: order._id, nonceStr: nonce() })
  if (res.returnCode !== 'SUCCESS') throw new Error('queryOrder failed')
  if (res.resultCode !== 'SUCCESS') {
    if (res.errCode === 'ORDERNOTEXIST') return { paid: false, payTime: 0, totalFee: 0, state: 'NOTEXIST' }
    throw new Error(`queryOrder failed: ${res.errCode}`)
  }
  const paid = res.tradeState === 'SUCCESS' || res.tradeState === 'REFUND'
  if (paid && res.outTradeNo && res.outTradeNo !== order._id) throw new Error('queryOrder mismatch')
  return { paid, payTime: paid ? u.parseWxTime(res.timeEnd) : 0, totalFee: Number(res.totalFee || 0), state: res.tradeState }
}

// 關單：微信規定下單 5 分鐘後才能關
async function closeOrder(cloud, order) {
  assertConfigured()
  if (MOCK) return true
  const res = await cloud.cloudPay.closeOrder({ subMchId: MCH_ID, outTradeNo: order._id, nonceStr: nonce() })
  if (res.returnCode !== 'SUCCESS') throw new Error('closeOrder failed')
  return res.resultCode === 'SUCCESS' || res.errCode === 'ORDERCLOSED'
}

// 退款：outRefundNo 由調用方事先固定並保存；網絡異常時用同一個單號重試，微信只會退一次
// 返回 true＝微信已受理；拋出 err.permanent＝微信明確拒絕（可釋放預留）；其他錯誤＝結果未知
async function refund(cloud, order, outRefundNo, refundFee) {
  assertConfigured()
  if (MOCK) return true
  const res = await cloud.cloudPay.refund({
    subMchId: MCH_ID,
    nonceStr: nonce(),
    outTradeNo: order._id,
    outRefundNo,
    totalFee: order.totalFee,
    refundFee
  })
  if (res.returnCode === 'SUCCESS' && res.resultCode === 'SUCCESS') return true
  const err = new Error(`refund failed: ${res.errCodeDes || res.returnMsg || res.errCode || ''}`)
  // 這些錯誤代表微信沒有受理，可以安全地放棄這筆退款
  err.permanent = ['INVALID_REQUEST', 'NOTENOUGH', 'TRADE_OVERDUE', 'USER_ACCOUNT_ABNORMAL', 'INVALID_REQ_TOO_MUCH', 'ORDERNOTEXIST', 'PARAM_ERROR', 'FREQUENCY_LIMITED'].includes(res.errCode)
  throw err
}

module.exports = { MOCK, MCH_ID, assertConfigured, unifiedOrder, queryOrder, closeOrder, refund }
