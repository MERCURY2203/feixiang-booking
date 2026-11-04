// 呼叫雲函數的統一入口：所有規則判斷都在雲函數裡做
function call(name, action, data = {}) {
  return wx.cloud
    .callFunction({ name, data: { action, ...data } })
    .then(res => {
      const r = res.result || {}
      if (r.ok) return r.data
      const err = new Error(r.message || '操作失败，请稍后再试')
      Object.assign(err, r) // code、orderId、invalid 等額外信息
      throw err
    })
}

function toast(msg) {
  wx.showToast({ title: msg, icon: 'none', duration: 2500 })
}

module.exports = { call, toast }
