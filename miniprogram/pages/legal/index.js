// 協議全文頁：?type=agreement（用戶協議）或 privacy（隱私政策）
const { getDoc } = require('../../utils/legal')

Page({
  data: { title: '', sections: [] },

  onLoad(options) {
    const doc = getDoc(options.type)
    wx.setNavigationBarTitle({ title: doc.title })
    this.setData({ title: doc.title, sections: doc.sections })
  }
})
