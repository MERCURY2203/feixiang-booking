// 微信支付結果通知（雲開發支付回調）：付款成功時由微信調用
// 安全規則：通知內容只用來知道「哪張訂單」，是否付款、付了多少一律以主動向微信查單（queryOrder）的結果為準，
// 所以就算有人偽造通知，也不能把沒付款的訂單變成已付款。
// 付款在到期前且場地仍屬於該訂單 → 訂單成立；否則一律全額退款（立項書「三道防線」第 2 道）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const ord = require('./lib/orders')

exports.main = async event => {
  try {
    const orderId = event && typeof event.outTradeNo === 'string' ? event.outTradeNo : ''
    if (!orderId) return { errcode: 0, errmsg: 'ignored' }
    const order = await ord.dget(db, 'orders', orderId)
    if (!order) return { errcode: 0, errmsg: 'order not found' }
    await ord.confirmIfPaid(cloud, db, order)
    return { errcode: 0, errmsg: '' }
  } catch (e) {
    console.error(e)
    // 返回錯誤讓微信稍後重試通知
    return { errcode: 1, errmsg: 'retry' }
  }
}
