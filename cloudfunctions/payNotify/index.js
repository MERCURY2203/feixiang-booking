// 微信支付結果通知（雲開發支付回調）：付款成功時由微信調用
// 規則：付款時間在到期前 → 訂單成立；訂單已關閉／取消或逾期付款 → 一律全額退款（立項書「三道防線」第 2 道）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const u = require('./lib/util')
const ord = require('./lib/orders')

exports.main = async event => {
  try {
    if (event.returnCode !== 'SUCCESS' || event.resultCode !== 'SUCCESS') return { errcode: 0, errmsg: 'ignored' }
    const order = (await db.collection('orders').doc(event.outTradeNo).get().catch(() => ({ data: null }))).data
    if (!order) return { errcode: 0, errmsg: 'order not found' }
    if (event.totalFee && Number(event.totalFee) !== order.totalFee) {
      console.error('amount mismatch', event.outTradeNo, event.totalFee, order.totalFee)
    }
    await ord.markPaid(cloud, db, order, u.parseWxTime(event.timeEnd))
    return { errcode: 0, errmsg: '' }
  } catch (e) {
    console.error(e)
    // 返回錯誤讓微信稍後重試通知
    return { errcode: 1, errmsg: 'retry' }
  }
}
