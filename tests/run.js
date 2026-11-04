// 自動回歸測試：node tests/run.js
// 用假的雲開發環境（tests/fake-cloud.js）真實執行雲函數代碼，重現 Codex 檢查報告（2026-11-04）裡的 R1–R12 等問題，
// 確認修正後不再發生。全部通過時最後一行顯示「全部通過」，有失敗時退出碼為 1。
process.env.MCH_ID = '1900000000' // 走「真實支付」代碼路徑（支付由假微信支付處理）
process.env.PAY_MODE = ''

const assert = require('assert')
const path = require('path')
const F = require('./fake-cloud')
const { clock, store, wechat, call } = F

if (process.argv.includes('--sync')) require('../scripts/sync-shared')

const booking = F.loadFn('booking')
const admin = F.loadFn('admin')
const payNotify = F.loadFn('payNotify')
const timer = F.loadFn('timer')
const user = F.loadFn('user')

const BASE = Date.UTC(2026, 10, 10, 2, 0, 0) // 2026-11-10 10:00 北京時間
const D = '2026-11-11'
const MIN = 60 * 1000

function seed() {
  store.reset()
  wechat.reset()
  clock.now = BASE
  store.write('users', 'uA', { openid: 'oA', role: 'customer', phone: '13800001111', nickname: 'A', avatar: 'cloud://a', phoneBoundAt: BASE })
  store.write('users', 'uB', { openid: 'oB', role: 'customer', phone: '13800002222', nickname: 'B', phoneBoundAt: BASE })
  store.write('users', 'uO', { openid: 'oO', role: 'owner', phone: '13900000000', nickname: '老板' })
  store.write('products', 'p1', {
    name: '畅打券', price: 5000, stock: 10, soldCount: 0, onShelf: true, images: ['cloud://p1'], desc: '',
    fixedDate: false, activityDate: '', activityStartAt: 0, sort: 0, createdAt: 0
  })
  store.write('products', 'p2', {
    name: '周三活动', price: 8800, stock: 5, soldCount: 0, onShelf: true, images: ['cloud://p2'], desc: '',
    fixedDate: true, activityDate: D, activityStartAt: Date.UTC(2026, 10, 11, 11, 0, 0), sort: 0, createdAt: 0
  })
}

const court = (c, h, date = D) => ({ type: 'court', date, court: c, hour: h })
const product = (id, qty = 1) => ({ type: 'product', productId: id, qty })
const doc = (c, id) => store.read(c, id).doc
const all = c => store.all(c)

function must(res) {
  if (!res || !res.ok) throw new Error(`期望成功，實際：${JSON.stringify(res)}`)
  return res.data
}
function mustFail(res, re) {
  assert(res && !res.ok, `期望失敗，實際成功：${JSON.stringify(res)}`)
  if (re) assert(re.test(res.message), `錯誤訊息不符：${res.message}`)
  return res
}

async function checkout(openid, items) {
  return call(booking, openid, { action: 'checkout', items })
}
async function payAndNotify(orderId) {
  wechat.pay(orderId)
  const r = await call(payNotify, '', { outTradeNo: orderId, returnCode: 'SUCCESS', resultCode: 'SUCCESS' })
  assert.strictEqual(r.errcode, 0)
}
async function buy(openid, items) {
  const o = must(await checkout(openid, items))
  await payAndNotify(o.orderId)
  return o.orderId
}
const itemsOf = orderId => all('order_items').filter(i => i.orderId === orderId)
async function runTimer() {
  return call(timer, '', {})
}

// 每張訂單：總額 = 卡片金額相加；已退金額 = 微信實際退款
function checkInvariants() {
  for (const o of all('orders')) {
    const sum = itemsOf(o._id).reduce((s, i) => s + i.price * i.qty, 0)
    assert.strictEqual(o.totalFee, sum, `訂單 ${o._id} 總額 ${o.totalFee} ≠ 卡片合計 ${sum}`)
    const settledRefunds = all('refunds').filter(r => r.orderId === o._id && r.status === 'success').reduce((s, r) => s + r.amount, 0)
    assert.strictEqual(o.refundedFee || 0, settledRefunds, `訂單 ${o._id} 已退金額與退款記錄不符`)
    assert(wechat.refundedTotal(o._id) <= o.totalFee, `訂單 ${o._id} 微信退款超過付款`)
    for (const i of itemsOf(o._id)) {
      if (i.kind === 'product') {
        const avail = i.qty - (i.verifiedQty || 0) - (i.refundedQty || 0) - (i.expiredQty || 0) - (i.refundingQty || 0)
        assert(avail >= 0, `卡片 ${i._id} 可用張數為負`)
      }
    }
  }
  for (const p of all('products')) assert(p.stock >= 0, `商品 ${p._id} 庫存為負`)
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ---------------- 報告裡的問題 ----------------

test('R1 同一張待支付訂單同時取消兩次，庫存只退回一次', async () => {
  const o = must(await checkout('oA', [product('p1', 1)]))
  assert.strictEqual(doc('products', 'p1').stock, 9)
  await Promise.all([
    call(booking, 'oA', { action: 'cancel', orderId: o.orderId }),
    call(booking, 'oA', { action: 'cancel', orderId: o.orderId })
  ])
  assert.strictEqual(doc('products', 'p1').stock, 10)
  assert.strictEqual(doc('products', 'p1').soldCount, 0)
  assert.strictEqual(doc('orders', o.orderId).status, 'cancelled')
})

test('R2 已取消的訂單晚到付款，不會復活、不會重複賣出，並全額退款', async () => {
  const a = must(await checkout('oA', [court(1, 10)]))
  must(await call(booking, 'oA', { action: 'cancel', orderId: a.orderId }))
  const bId = await buy('oB', [court(1, 10)])
  await payAndNotify(a.orderId) // A 在微信付款窗口仍開著時付了款
  const A = doc('orders', a.orderId)
  assert.strictEqual(A.status, 'timeout_refunded')
  assert.strictEqual(A.refundState, 'success')
  assert.strictEqual(wechat.refundedTotal(a.orderId), A.totalFee)
  assert.strictEqual(doc('orders', bId).status, 'active')
  const lock = doc('slot_locks', `${D}_1_10`)
  assert.strictEqual(lock.orderId, bId)
  assert.strictEqual(lock.status, 'booked')
})

test('R2b 付款確認與別人下單同時發生，場地只屬於一個人', async () => {
  const a = must(await checkout('oA', [court(2, 10)]))
  must(await call(booking, 'oA', { action: 'cancel', orderId: a.orderId }))
  wechat.pay(a.orderId)
  const [, b] = await Promise.all([
    call(payNotify, '', { outTradeNo: a.orderId }),
    checkout('oB', [court(2, 10)])
  ])
  const A = doc('orders', a.orderId)
  assert.strictEqual(A.status, 'timeout_refunded')
  if (b.ok) assert.strictEqual(doc('slot_locks', `${D}_2_10`).orderId, b.data.orderId)
})

test('R3 退款回覆丟失後重試，用同一個退款單號，只退一次', async () => {
  const id = await buy('oA', [court(3, 10)])
  const it = itemsOf(id)[0]
  wechat.loseNextRefundResponse = true
  const r1 = must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id }))
  assert.strictEqual(r1.processing, true)
  mustFail(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id }))
  mustFail(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: it._id, amount: it.price }] }), /退款中/)
  clock.now += 2 * MIN
  await runTimer()
  assert.strictEqual(new Set(wechat.refundCalls).size, 1, `出現多個退款單號：${wechat.refundCalls}`)
  assert.strictEqual(wechat.refundedTotal(id), it.price)
  assert.strictEqual(doc('order_items', it._id).refundedFee, it.price)
  assert.strictEqual(doc('orders', id).refundedFee, it.price)
  assert.strictEqual(doc('orders', id).status, 'refunded')
  assert.strictEqual(doc('slot_locks', `${D}_3_10`), null)
})

test('R4 未付款訂單的券碼不能核銷', async () => {
  const o = must(await checkout('oA', [product('p1', 2)]))
  const it = itemsOf(o.orderId)[0]
  mustFail(await call(admin, 'oO', { action: 'verifyLookup', code: it.code }))
  mustFail(await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1 }))
  assert.strictEqual(doc('order_items', it._id).verifiedQty, 0)
})

test('R5 退款與核銷同時進行，最多只有一個成功，張數不會變負', async () => {
  const id = await buy('oA', [product('p1', 1)])
  const it = itemsOf(id)[0]
  const [r, v] = await Promise.all([
    call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }),
    call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1 })
  ])
  assert.strictEqual([r.ok, v.ok].filter(Boolean).length, 1, `退款 ${r.ok}／核銷 ${v.ok}`)
  const x = doc('order_items', it._id)
  assert.strictEqual((x.verifiedQty || 0) + (x.refundedQty || 0), 1)
})

test('R6 不存在的場地、非整點時段不能報價或下單', async () => {
  const q = must(await call(booking, 'oA', { action: 'quote', items: [court(999, 10), court(1, 10.5), court(1, 10, '2026/11/11')] }))
  assert(q.every(i => !i.valid))
  mustFail(await checkout('oA', [court(999, 10)]))
  mustFail(await checkout('oA', [court(1, 10.5)]))
  mustFail(await checkout('oA', [product('p1', 1.5)]))
  mustFail(await checkout('oA', [product('p1', -1)]))
  assert.strictEqual(all('orders').length, 0)
})

test('R7 偽造的付款通知不能把未付款訂單變成已付款', async () => {
  const o = must(await checkout('oA', [court(4, 10)]))
  const total = doc('orders', o.orderId).totalFee
  await call(payNotify, 'oA', { outTradeNo: o.orderId, returnCode: 'SUCCESS', resultCode: 'SUCCESS', totalFee: total, timeEnd: '20261110100100' })
  await call(payNotify, '', { outTradeNo: o.orderId, returnCode: 'SUCCESS', resultCode: 'SUCCESS', totalFee: total, timeEnd: '20261110100100' })
  assert.strictEqual(doc('orders', o.orderId).status, 'pending')
  assert.strictEqual(doc('slot_locks', `${D}_4_10`).status, 'pending')
})

test('R8 一年未訂場自動刪除：用戶、訂單、核銷記錄裡的手機號都刪除，頭像暱稱也刪除', async () => {
  const id = await buy('oA', [product('p1', 2)])
  const it = itemsOf(id)[0]
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1 }))
  clock.now = Date.UTC(2027, 10, 12, 19, 0, 0) // 2027-11-13 03:00 北京時間
  store.write('users', 'uB', { ...doc('users', 'uB'), phoneBoundAt: clock.now - 10 * 24 * 3600e3 }) // B 10 天前才綁定
  await runTimer()
  const A = doc('users', 'uA')
  assert.strictEqual(A.phone, '')
  assert.strictEqual(A.nickname, '')
  assert.strictEqual(A.avatar, '')
  assert.strictEqual(doc('orders', id).phone, '')
  assert(all('verify_logs').every(l => l.phone === ''))
  assert.strictEqual(doc('users', 'uB').phone, '13800002222', '綁定未滿一年的不能刪')
  const list = must(await call(admin, 'oO', { action: 'orders' }))
  assert.strictEqual(list.list.find(o => o._id === id).phone, '已注销用户')
})

test('R9 固定日期活動過期後不能查到或核銷，未使用張數自動退款並記為已過期', async () => {
  const id = await buy('oA', [product('p2', 2)])
  const it = itemsOf(id)[0]
  clock.now = Date.UTC(2026, 10, 12, 2, 0, 0) // 活動日的第二天
  mustFail(await call(admin, 'oO', { action: 'verifyLookup', code: it.code }), /过期/)
  mustFail(await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1 }), /过期/)
  await runTimer()
  const x = doc('order_items', it._id)
  assert.strictEqual(x.expiredQty, 2)
  assert.strictEqual(x.refundedQty || 0, 0)
  assert.strictEqual(x.codeActive, false)
  assert.strictEqual(wechat.refundedTotal(id), 2 * 8800)
})

test('R10 同一客人同時結算兩次，只產生一張待支付訂單', async () => {
  const [a, b] = await Promise.all([checkout('oA', [court(5, 10)]), checkout('oA', [court(6, 10)])])
  assert.strictEqual([a.ok, b.ok].filter(Boolean).length, 1)
  assert.strictEqual(all('orders').filter(o => o.userId === 'uA' && o.status === 'pending').length, 1)
  const loser = a.ok ? b : a
  assert.strictEqual(loser.code, 'HAS_PENDING')
  // 被拒的那次不能留下任何佔用
  assert.strictEqual(all('slot_locks').length, 1)
})

test('R11 編輯商品時不會把編輯期間賣出的庫存加回來', async () => {
  const form = must(await call(admin, 'oO', { action: 'productGet', id: 'p1' }))
  await buy('oB', [product('p1', 1)])
  const base = { _id: 'p1', name: '畅打券（新）', images: form.images, price: form.price, desc: '', fixedDate: false, onShelf: true }
  must(await call(admin, 'oO', { action: 'productSave', product: { ...base, stock: 10, stockFrom: form.stock } }))
  assert.strictEqual(doc('products', 'p1').stock, 9)
  assert.strictEqual(doc('products', 'p1').name, '畅打券（新）')
  must(await call(admin, 'oO', { action: 'productSave', product: { ...base, stock: 15, stockFrom: 10 } }))
  assert.strictEqual(doc('products', 'p1').stock, 14)
  mustFail(await call(admin, 'oO', { action: 'productSave', product: { ...base, stock: 0, stockFrom: 20 } }), /库存/)
})

test('R12 結算時老闆改價：訂單總額永遠等於卡片金額相加', async () => {
  for (let n = 0; n < 6; n++) {
    seed()
    const price = 6000 + n
    const [c] = await Promise.all([
      checkout('oA', [product('p1', 2), court(7, 10)]),
      call(admin, 'oO', { action: 'productSave', product: { _id: 'p1', name: '畅打券', images: ['cloud://p1'], price, stock: 10, stockFrom: 10, desc: '', fixedDate: false, onShelf: true } })
    ])
    checkInvariants()
    if (c.ok) {
      const it = itemsOf(c.data.orderId).find(i => i.kind === 'product')
      assert([5000, price].includes(it.price))
    }
  }
})

// ---------------- 其他關鍵流程 ----------------

test('兩人同時訂同一格，只有一人成功', async () => {
  const [a, b] = await Promise.all([checkout('oA', [court(8, 10)]), checkout('oB', [court(8, 10)])])
  assert.strictEqual([a.ok, b.ok].filter(Boolean).length, 1)
})

test('到期前已付款但沒收到通知：定時任務查單後訂單成立', async () => {
  const o = must(await checkout('oA', [court(9, 10)]))
  clock.now += 4 * MIN
  wechat.pay(o.orderId)
  clock.now += 2 * MIN
  await runTimer()
  assert.strictEqual(doc('orders', o.orderId).status, 'active')
  assert.strictEqual(doc('slot_locks', `${D}_9_10`).status, 'booked')
})

test('5 分鐘不付款：定時任務關單並放出場地，別人可以訂', async () => {
  const o = must(await checkout('oA', [court(10, 10), product('p1', 3)]))
  clock.now += 6 * MIN
  await runTimer()
  assert.strictEqual(doc('orders', o.orderId).status, 'closed')
  assert.strictEqual(doc('slot_locks', `${D}_10_10`), null)
  assert.strictEqual(doc('products', 'p1').stock, 10)
  must(await checkout('oB', [court(10, 10)]))
})

test('已過期但未關單的佔用：別人下單時先查單再放出', async () => {
  const o = must(await checkout('oA', [court(1, 11)]))
  clock.now += 6 * MIN
  must(await checkout('oB', [court(1, 11)]))
  assert.strictEqual(doc('orders', o.orderId).status, 'closed')
})

test('券碼不重複：撞號時自動換號', async () => {
  store.write('coupon_codes', '111111', { itemId: 'x', orderId: 'y' })
  const real = Math.random
  let n = 0
  Math.random = () => (n++ < 12 ? 0.15 : real())
  try {
    const id = await buy('oA', [product('p1', 1)])
    const it = itemsOf(id)[0]
    assert.notStrictEqual(it.code, '111111')
    assert.strictEqual(doc('coupon_codes', it.code).itemId, it._id)
    const v = must(await call(admin, 'oO', { action: 'verifyLookup', code: it.code }))
    assert.strictEqual(v.itemId, it._id)
  } finally {
    Math.random = real
  }
})

test('管理端部分退款、合併退款後金額一致', async () => {
  const id = await buy('oA', [court(2, 12), court(2, 13), product('p1', 3)])
  const items = itemsOf(id)
  const c1 = items.find(i => i.kind === 'court')
  const p = items.find(i => i.kind === 'product')
  must(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: c1._id, amount: 1000 }] }))
  must(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: c1._id, amount: c1.price - 1000 }, { itemId: p._id, qty: 1, amount: 5000 }] }))
  mustFail(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: c1._id, amount: 1 }] }))
  const o = doc('orders', id)
  assert.strictEqual(o.refundedFee, c1.price + 5000)
  assert.strictEqual(wechat.refundedTotal(id), c1.price + 5000)
  assert.strictEqual(doc('order_items', p._id).refundedQty, 1)
  assert.strictEqual(doc('products', 'p1').stock, 8)
  assert.strictEqual(doc('slot_locks', `${D}_2_12`), null)
  assert.strictEqual(o.status, 'active')
})

test('註銷帳號：核銷記錄的手機號一併刪除', async () => {
  const id = await buy('oA', [product('p1', 1)])
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: itemsOf(id)[0]._id, qty: 1 }))
  must(await call(user, 'oA', { action: 'deleteAccount' }))
  assert.strictEqual(doc('orders', id).phone, '')
  assert(all('verify_logs').every(l => l.phone === ''))
})

test('支付未配置時不會悄悄進入模擬支付', async () => {
  const libs = ['booking', 'admin', 'timer', 'payNotify'].map(f => path.join(__dirname, '..', 'cloudfunctions', f, 'lib', 'pay.js'))
  const shared = path.join(__dirname, '..', 'cloudfunctions', '_shared', 'pay.js')
  const fresh = env => {
    const saved = { MCH_ID: process.env.MCH_ID, PAY_MODE: process.env.PAY_MODE }
    Object.assign(process.env, env)
    delete require.cache[shared]
    const m = require(shared)
    Object.assign(process.env, saved)
    delete require.cache[shared]
    return m
  }
  const none = fresh({ MCH_ID: '', PAY_MODE: '' })
  assert.strictEqual(none.MOCK, false)
  await assert.rejects(none.unifiedOrder({}, { _id: 'x' }, 'b'), /未配置/)
  assert.strictEqual(fresh({ MCH_ID: '', PAY_MODE: 'mock' }).MOCK, true)
  assert.strictEqual(fresh({ MCH_ID: '123', PAY_MODE: 'mock' }).MOCK, false)
  // 各雲函數 lib 裡的副本必須與 _shared 一致（忘了 sync 會在這裡發現）
  const fs = require('fs')
  for (const f of fs.readdirSync(path.dirname(shared))) {
    for (const lib of libs) {
      const copy = path.join(path.dirname(lib), f)
      assert(fs.existsSync(copy) && fs.readFileSync(copy, 'utf8') === fs.readFileSync(path.join(path.dirname(shared), f), 'utf8'),
        `${path.relative(process.cwd(), copy)} 與 _shared 不一致，請執行 node scripts/sync-shared.js`)
    }
  }
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    seed()
    try {
      await t.fn()
      checkInvariants()
      console.log(`✓ ${t.name}`)
    } catch (e) {
      failed++
      console.log(`✗ ${t.name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 通過（事務衝突自動重試 ${F.stats.txConflicts} 次）`)
  if (failed) {
    console.log('有測試失敗')
    process.exit(1)
  }
  console.log('全部通過')
})()
