// 把 cloudfunctions/_shared/ 的公共代碼複製到各雲函數的 lib/ 目錄
// 修改 _shared 後執行：node scripts/sync-shared.js，再重新上傳相關雲函數
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'cloudfunctions')
const shared = path.join(root, '_shared')
const targets = ['booking', 'admin', 'timer', 'payNotify']

for (const fn of targets) {
  const lib = path.join(root, fn, 'lib')
  fs.mkdirSync(lib, { recursive: true })
  for (const file of fs.readdirSync(shared)) {
    fs.copyFileSync(path.join(shared, file), path.join(lib, file))
  }
  console.log(`synced → ${fn}/lib`)
}
