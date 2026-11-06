// 選圖並手動裁剪：先從相冊選圖，再逐張進入微信的裁剪畫面，按指定比例手動調整範圍
// scale 可選：'16:9' '9:16' '4:3' '3:4' '5:4' '4:5' '1:1'（微信裁剪功能支援的比例）
// 返回裁剪後的本地圖片路徑清單；按「取消」的圖片會被略過
const api = require('./api')

const isCancel = e => /cancel/i.test((e && e.errMsg) || '')

function chooseMedia(count) {
  return new Promise(resolve => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => resolve(res.tempFiles.map(f => f.tempFilePath)),
      fail: e => {
        if (!isCancel(e)) api.toast(`无法选择图片：${(e && e.errMsg) || '未知原因'}`)
        resolve([])
      }
    })
  })
}

function cropOne(src, scale) {
  return new Promise(resolve => {
    // 太舊的微信版本沒有裁剪功能：直接用原圖
    if (!wx.canIUse('cropImage')) return resolve(src)
    wx.cropImage({
      src,
      cropScale: scale,
      success: r => resolve(r.tempFilePath),
      fail: e => {
        if (!isCancel(e)) api.toast(`裁剪失败：${(e && e.errMsg) || '未知原因'}`)
        resolve('')
      }
    })
  })
}

async function pickImages({ count, scale }) {
  const picked = await chooseMedia(count)
  const out = []
  for (const src of picked) {
    const p = await cropOne(src, scale)
    if (p) out.push(p)
  }
  return out
}

module.exports = { pickImages }
