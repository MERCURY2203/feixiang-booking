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
  const base = { _id: 'p1', name: '畅打券（新）', images: form.images, price: form.price, desc: '', fixedDate: false, onShelf: true, opId: 'op1' }
  must(await call(admin, 'oO', { action: 'productSave', product: { ...base, stock: 10, stockFrom: form.stock } }))
  assert.strictEqual(doc('products', 'p1').stock, 9)
  assert.strictEqual(doc('products', 'p1').name, '畅打券（新）')
  must(await call(admin, 'oO', { action: 'productSave', product: { ...base, opId: 'op2', stock: 15, stockFrom: 10 } }))
  assert.strictEqual(doc('products', 'p1').stock, 14)
  mustFail(await call(admin, 'oO', { action: 'productSave', product: { ...base, opId: 'op3', stock: 0, stockFrom: 20 } }), /库存/)
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

// ---------------- 複查報告（2026-11-04-recheck）N1–N7 ----------------

test('N1 同一筆退款兩個處理者交錯：晚到的網絡錯誤不會覆蓋成功狀態，也不會重複記帳', async () => {
  const id = await buy('oA', [court(3, 14)])
  const it = itemsOf(id)[0]
  let release
  const gate = new Promise(r => (release = r))
  let first = true
  wechat.refundHook = async () => {
    if (!first) return
    first = false
    await gate // 第一個處理者：微信已受理，但回覆卡住
    throw new Error('delayed network failure')
  }
  const a = call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id })
  for (let i = 0; i < 50 && !wechat.refundCalls.length; i++) await F.tick()
  clock.now += 2 * MIN
  await runTimer() // 第二個處理者用同一單號重試並結算
  assert.strictEqual(doc('refunds', `${id}R01`).status, 'success')
  release()
  await a
  assert.strictEqual(doc('refunds', `${id}R01`).status, 'success', '晚到的錯誤把成功改回了不明')
  clock.now += 2 * MIN
  await runTimer()
  assert.strictEqual(doc('orders', id).refundedFee, it.price)
  assert.strictEqual(doc('order_items', it._id).refundedFee, it.price)
  assert.strictEqual(wechat.refundedTotal(id), it.price)
})

test('N2（預期設計）協商部分退款：只退部分金額後該券結案，不能再退差額', async () => {
  const id = await buy('oA', [product('p1', 1)])
  const it = itemsOf(id)[0]
  must(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: it._id, qty: 1, amount: 1000 }] }))
  assert.strictEqual(doc('orders', id).status, 'refunded')
  mustFail(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: it._id, qty: 0, amount: 4000 }] }))
  assert.strictEqual(wechat.refundedTotal(id), 1000)
})

test('N3 同一個商品表單重複提交（連按或網絡重送），庫存只調整一次', async () => {
  const p = { _id: 'p1', name: '畅打券', images: ['cloud://p1'], price: 5000, desc: '', fixedDate: false, onShelf: true, stock: 15, stockFrom: 10, opId: 'formA' }
  const [r1, r2] = await Promise.all([
    call(admin, 'oO', { action: 'productSave', product: p }),
    call(admin, 'oO', { action: 'productSave', product: p })
  ])
  assert(r1.ok && r2.ok)
  must(await call(admin, 'oO', { action: 'productSave', product: p }))
  assert.strictEqual(doc('products', 'p1').stock, 15)
  mustFail(await call(admin, 'oO', { action: 'productSave', product: { ...p, stock: 18 } }), /重新打开/)
  mustFail(await call(admin, 'oO', { action: 'productSave', product: { ...p, stock: 18, opId: '' } }), /重新打开/)
})

const stripField = (coll, id, field) => {
  const d = doc(coll, id)
  delete d[field]
  delete d._id
  store.write(coll, id, d)
}

test('N4 舊結構待支付訂單（沒有 itemIds）取消時，照樣放出場地、退回庫存', async () => {
  const o = must(await checkout('oA', [court(4, 14), product('p1', 1)]))
  stripField('orders', o.orderId, 'itemIds')
  must(await call(booking, 'oA', { action: 'cancel', orderId: o.orderId }))
  assert.strictEqual(doc('orders', o.orderId).status, 'cancelled')
  assert.strictEqual(doc('slot_locks', `${D}_4_14`), null)
  assert.strictEqual(doc('products', 'p1').stock, 10)
})

test('N5 舊結構已付款訂單（沒有 itemIds）不會被誤判為已全額退款', async () => {
  const id = await buy('oA', [court(5, 14)])
  stripField('orders', id, 'itemIds')
  must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  await runTimer()
  assert.strictEqual(doc('orders', id).status, 'active')
  // 卡片完全找不到時，阻止轉換而不是當成全退
  const saved = itemsOf(id)[0]
  store.write('order_items', saved._id, null)
  stripField('orders', id, 'itemIds')
  await call(booking, 'oA', { action: 'orderDetail', orderId: id })
  assert.strictEqual(doc('orders', id).status, 'active')
  const { _id, ...rest } = saved
  store.write('order_items', _id, rest)
})

test('N6 舊核銷記錄（沒有 userId）：註銷和一年自動刪除都能刪掉手機號', async () => {
  const idA = await buy('oA', [product('p1', 1)])
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: itemsOf(idA)[0]._id, qty: 1 }))
  const idB = await buy('oB', [product('p1', 2)])
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: itemsOf(idB)[0]._id, qty: 1 }))
  for (const l of all('verify_logs')) stripField('verify_logs', l._id, 'userId')
  must(await call(user, 'oA', { action: 'deleteAccount' }))
  assert(all('verify_logs').filter(l => l.orderId === idA).every(l => l.phone === ''))
  assert(all('verify_logs').filter(l => l.orderId === idB).every(l => l.phone === '13800002222'))
  clock.now = Date.UTC(2027, 10, 12, 19, 0, 0)
  await runTimer()
  assert(all('verify_logs').every(l => l.phone === ''))
})

test('N7 新券碼不會與未登記的舊有效券碼重複', async () => {
  store.write('order_items', 'OLD_ITEM', { orderId: 'OLD', kind: 'product', code: '111111', codeActive: true, qty: 1, price: 100 })
  const real = Math.random
  let n = 0
  Math.random = () => (n++ < 12 ? 0.15 : real())
  try {
    const id = await buy('oA', [product('p1', 1)])
    assert.notStrictEqual(itemsOf(id)[0].code, '111111')
  } finally {
    Math.random = real
  }
})

test('數據遷移 initdb：補 itemIds、補 userId、登記舊券碼並處理重碼；重複執行不再改動', async () => {
  const initdb = F.loadFn('initdb')
  const idA = await buy('oA', [product('p1', 1), court(6, 14)])
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: itemsOf(idA).find(i => i.kind === 'product')._id, qty: 1 }))
  stripField('orders', idA, 'itemIds')
  for (const l of all('verify_logs')) stripField('verify_logs', l._id, 'userId')
  store.write('order_items', 'OLD1', { orderId: 'OLDO', kind: 'product', code: '222222', codeActive: true, qty: 1, price: 100 })
  store.write('order_items', 'OLD2', { orderId: 'OLDO', kind: 'product', code: '222222', codeActive: true, qty: 1, price: 100 })
  const r1 = await call(initdb, '', {})
  assert(r1.ok && r1.migration.done)
  assert.deepStrictEqual(doc('orders', idA).itemIds, itemsOf(idA).map(i => i._id).sort())
  assert(all('verify_logs').every(l => l.userId === 'uA'))
  assert.strictEqual(r1.migration.codesChanged.length, 1)
  assert.notStrictEqual(doc('order_items', 'OLD1').code, doc('order_items', 'OLD2').code)
  for (const it of all('order_items').filter(i => i.kind === 'product')) assert.strictEqual(doc('coupon_codes', it.code).itemId, it._id)
  const r2 = await call(initdb, '', {})
  assert.strictEqual(r2.migration.ordersFixed + r2.migration.logsFixed + r2.migration.codesRegistered + r2.migration.codesChanged.length, 0)
})

test('退款受理後用退款查詢確認到帳；異常時通知管理端', async () => {
  const id = await buy('oA', [court(7, 14), court(7, 15)])
  const [c1, c2] = itemsOf(id)
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: c1._id }))
  wechat.refundStatus[`${id}R02`] = 'CHANGE'
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: c2._id }))
  assert.strictEqual(doc('refunds', `${id}R01`).wxState, 'ACCEPTED')
  clock.now += 3 * MIN
  await runTimer()
  assert.strictEqual(doc('refunds', `${id}R01`).wxState, 'SUCCESS')
  assert.strictEqual(doc('refunds', `${id}R02`).wxState, 'ABNORMAL')
  assert(all('notices').some(n => /退款异常/.test(n.text)))
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

test('訂場表格：自己訂的格子標為 mine，自己待支付的標為 mypending，別人看到的是 taken', async () => {
  const paid = await buy('oA', [court(1, 10)])
  const pend = must(await checkout('oB', [court(2, 11)]))
  const cell = (data, c, h) => data.cells[h - data.hours[0].hour][c - 1].s
  const forA = must(await call(booking, 'oA', { action: 'schedule', date: D }))
  const forB = must(await call(booking, 'oB', { action: 'schedule', date: D }))
  assert.strictEqual(cell(forA, 1, 10), 'mine')
  assert.strictEqual(cell(forA, 2, 11), 'taken')
  assert.strictEqual(cell(forB, 1, 10), 'taken')
  assert.strictEqual(cell(forB, 2, 11), 'mypending')
  assert(paid && pend)
  // 5 分鐘沒付款後，待支付的格子不再算「我的」
  clock.now += 6 * MIN
  const later = must(await call(booking, 'oB', { action: 'schedule', date: D }))
  assert.strictEqual(cell(later, 2, 11), 'free')
})

test('訂單明細：場地按日期分組、每個時段一行（時段＋場號），商品合併帶件數', async () => {
  const o = must(await checkout('oA', [court(2, 18), court(1, 20), court(1, 18), product('p1', 3)]))
  const lines = doc('orders', o.orderId).lines
  assert.strictEqual(lines.length, 2)
  const o2 = doc('orders', o.orderId)
  assert.strictEqual(lines[0].fee + lines[1].fee, o2.totalFee) // 各項金額加起來等於訂單總額（前端拆卡片用）
  delete lines[0].fee
  delete lines[1].fee
  assert.deepStrictEqual(lines[0], {
    kind: 'court', date: '11月11日',
    rows: [{ time: '18:00–19:00', court: '1号场' }, { time: '18:00–19:00', court: '2号场' }, { time: '20:00–21:00', court: '1号场' }]
  })
  assert.deepStrictEqual(lines[1], { kind: 'product', title: '畅打券', n: 3 })
  const list = must(await call(booking, 'oA', { action: 'myOrders', tab: 'all', skip: 0 }))
  assert.strictEqual(list.list[0].lines.length, 2)
  // 舊訂單沒有明細：拆摘要，不報錯
  const legacy = { ...doc('orders', o.orderId), summary: 'A；B' }
  delete legacy.lines
  store.write('orders', o.orderId, legacy)
  const old = must(await call(booking, 'oA', { action: 'myOrders', tab: 'all', skip: 0 }))
  assert(old.list[0].lines.length === 2 && old.list[0].lines[0].n === 0)
})

// ---------------- Codex 檢查報告（2026-11-11）C1–C6 ----------------

test('C1 客人確認的合計與現價不一致：不下單，要求重新確認', async () => {
  mustFail(await call(booking, 'oA', { action: 'checkout', items: [product('p1', 1)], expectTotal: 3000 }), /价格已变动/)
  assert.strictEqual(all('orders').length, 0)
  assert.strictEqual(doc('products', 'p1').stock, 10)
  const ok = must(await call(booking, 'oA', { action: 'checkout', items: [product('p1', 2)], expectTotal: 10000 }))
  assert.strictEqual(doc('orders', ok.orderId).totalFee, 10000)
})

test('C2 本地已建單但微信沒有這張單：逾時後釋放場地，客人可再下單', async () => {
  const o = must(await checkout('oA', [court(4, 10)]))
  delete wechat.orders[o.orderId] // 模擬向微信下單前中斷
  clock.now += 6 * MIN
  await runTimer()
  assert.strictEqual(doc('orders', o.orderId).status, 'closed')
  assert.strictEqual(doc('slot_locks', `${D}_4_10`), null)
  must(await checkout('oA', [court(4, 10)]))
})

test('C3 前 20 筆退款還在處理中，第 21 筆異常退款照樣會被查到', async () => {
  const ids = []
  for (let n = 0; n < 21; n++) {
    const id = await buy('oA', [court(1 + (n % 10), 9 + Math.floor(n / 10))])
    ids.push(id)
    clock.now += 1000
    must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: itemsOf(id)[0]._id }))
    wechat.refundStatus[`${id}R01`] = n === 20 ? 'CHANGE' : 'PROCESSING'
  }
  clock.now += 3 * MIN
  await runTimer() // 第一輪：最舊的 20 筆（處理中）
  await runTimer() // 第二輪：剛查過的不再佔名額，輪到第 21 筆
  assert.strictEqual(doc('refunds', `${ids[20]}R01`).wxState, 'ABNORMAL')
  assert(all('notices').some(n => /退款异常/.test(n.text)))
})

test('C4 微信拒絕自動退款（餘額不足）不耗用退款次數，恢復後仍能退成功', async () => {
  const id = await buy('oA', [product('p2', 2)])
  const it = itemsOf(id)[0]
  clock.now = Date.UTC(2026, 10, 12, 2, 0, 0)
  wechat.rejectRefunds = true
  await runTimer()
  assert.strictEqual(doc('orders', id).refundCount || 0, 0)
  assert.strictEqual(doc('order_items', it._id).refunding || '', '')
  // 剛失敗過：1 小時內不重複嘗試、不重複通知
  const n1 = all('notices').length
  clock.now += 5 * MIN
  await runTimer()
  assert.strictEqual(all('notices').length, n1)
  // 餘額恢復、1 小時後重試成功
  wechat.rejectRefunds = false
  clock.now += 61 * MIN
  await runTimer()
  assert.strictEqual(wechat.refundedTotal(id), 2 * 8800)
  assert.strictEqual(doc('order_items', it._id).expiredQty, 2)
})

test('C6 登入不建立用戶資料；同意協議後才建立並記下版本', async () => {
  const r = must(await call(user, 'oNew', { action: 'login' }))
  assert.strictEqual(r.user._id, '')
  assert.strictEqual(all('users').filter(x => x.openid === 'oNew').length, 0)
  must(await call(user, 'oNew', { action: 'agreePrivacy', version: '2026-11-06' }))
  const u = all('users').find(x => x.openid === 'oNew')
  assert(u && u.agreedPrivacyVersion === '2026-11-06')
})

test('C5 資料到期：滿 3 年的訂單匿名化、1 年前的日誌刪除，較新的不動', async () => {
  const id = await buy('oA', [court(2, 10)])
  const it = itemsOf(id)[0]
  store.write('orders', id, { ...doc('orders', id), status: 'completed' })
  store.write('audit_logs', 'old', { actorId: 'x', action: 'a', at: BASE })
  store.write('audit_logs', 'new', { actorId: 'x', action: 'a', at: Date.UTC(2029, 9, 1) })
  clock.now = Date.UTC(2029, 10, 12, 19, 0, 0) // 約 3 年後的凌晨 3 點
  await runTimer()
  const o = doc('orders', id)
  assert(o.phone === '' && o.openid === '' && o.userId === '' && o.anonymizedAt)
  assert.strictEqual(o.totalFee, it.price) // 金額保留
  assert.strictEqual(doc('order_items', it._id).userId, '')
  assert.strictEqual(doc('audit_logs', 'old'), null)
  assert(doc('audit_logs', 'new'))
})

// ---------------- Codex 複查報告（2026-11-11，B1–B7）回歸測試 ----------------

const fs = require('fs')
const vm = require('vm')
const cloudPay = require('wx-server-sdk').cloudPay
const ROOT = path.join(__dirname, '..')

// 在沙盒裡執行小程序頁面代碼，取出 Page({...}) 的物件；setData 只做最簡單的路徑賦值
function loadPage(file, mods, extra = {}) {
  let page
  const req = name => {
    for (const [k, v] of Object.entries(mods)) if (name.endsWith(k)) return v
    return {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { Page: o => (page = o), require: req, console, ...extra })
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = (patch, cb) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.replace(/\[(\d+)\]/g, '.$1').split('.')
      let o = page.data
      for (const x of parts.slice(0, -1)) o = o[x]
      o[parts[parts.length - 1]] = v
    }
    if (cb) cb()
  }
  return page
}

test('B1 較早的退款失敗後，不會重用別人的退款單號；帳上已退金額 = 微信實退', async () => {
  store.write('products', 'p3', { ...doc('products', 'p1'), name: '体验券' })
  store.write('products', 'p4', { ...doc('products', 'p1'), name: '月卡' })
  const id = await buy('oA', [product('p1'), product('p3'), product('p4')])
  const [P, Q, S] = ['p1', 'p3', 'p4'].map(pid => itemsOf(id).find(i => i.productId === pid))
  const real = cloudPay.refund
  let entered, release
  const enteredP = new Promise(r => (entered = r))
  const releaseP = new Promise(r => (release = r))
  try {
    cloudPay.refund = async p => {
      if (p.outRefundNo === `${id}R01`) {
        entered()
        await releaseP
        return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'NOTENOUGH', errCodeDes: '商户余额不足' }
      }
      return real(p)
    }
    const refund = it => call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 })
    const first = refund(P)
    await enteredP
    must(await refund(Q)) // R02
    release()
    assert.strictEqual((await first).ok, false)
    must(await refund(S)) // 必須是全新的 R03，不能重用 R02
  } finally {
    cloudPay.refund = real
  }
  assert.strictEqual(doc('refunds', `${id}R01`).status, 'failed')
  assert.strictEqual(doc('refunds', `${id}R02`).parts[0].itemId, Q._id)
  assert.strictEqual(doc('refunds', `${id}R03`).parts[0].itemId, S._id)
  assert.strictEqual(doc('orders', id).refundedFee, 10000)
  assert.strictEqual(wechat.refundedTotal(id), 10000)
  assert.strictEqual(doc('orders', id).refundCount, 2) // 失敗的那次不算次數
  assert.strictEqual(doc('order_items', P._id).refundedQty || 0, 0) // 沒退成功的券不能結案
})

test('B1b 舊訂單沒有退款流水號：從已有退款記錄的最大編號接著編，不覆蓋', async () => {
  store.write('products', 'p3', { ...doc('products', 'p1'), name: '体验券' })
  const id = await buy('oA', [product('p1', 2), product('p3')])
  const it = itemsOf(id).find(i => i.productId === 'p1')
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  // 模擬舊版程式留下的資料：沒有 refundSeq，refundCount 被錯誤地減回 1
  const o = doc('orders', id)
  delete o.refundSeq
  store.write('orders', id, { ...o, refundCount: 1 })
  const q = itemsOf(id).find(i => i.productId === 'p3')
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: q._id, qty: 1 }))
  assert.strictEqual(doc('refunds', `${id}R03`).parts[0].itemId, q._id)
  assert.strictEqual(doc('refunds', `${id}R02`).parts[0].itemId, it._id)
})

test('B2 前 20 筆退款一直結果不明，第 21 筆仍會被補做', async () => {
  for (let i = 0; i < 21; i++) {
    const oid = `O${i}`, rid = `${oid}R01`, iid = `I${i}`
    store.write('orders', oid, { userId: 'uA', status: 'active', itemIds: [iid], totalFee: 100, refundCount: 1, refundSeq: 1, createdAt: BASE })
    store.write('order_items', iid, { orderId: oid, kind: 'product', productId: 'p1', price: 100, qty: 1, refunding: rid, refundingFee: 100, refundingQty: 1, codeActive: true })
    store.write('refunds', rid, { orderId: oid, kind: 'items', amount: 100, parts: [{ itemId: iid, qty: 1, amount: 100 }], status: i < 20 ? 'unknown' : 'pending', at: BASE - 10 * MIN + i })
    wechat.orders[oid] = { totalFee: 100, state: 'SUCCESS' }
  }
  const real = cloudPay.refund
  try {
    cloudPay.refund = async p => {
      if (p.outTradeNo !== 'O20') throw new Error('persistent network error')
      return real(p)
    }
    for (let i = 0; i < 4; i++) {
      await runTimer()
      clock.now += MIN
    }
  } finally {
    cloudPay.refund = real
  }
  assert.strictEqual(doc('refunds', 'O20R01').status, 'success')
  assert.strictEqual(wechat.refundedTotal('O20'), 100)
  assert.strictEqual(doc('refunds', 'O0R01').status, 'unknown') // 舊的仍保留預留，沒有被隨便宣告失敗
  assert(doc('refunds', 'O0R01').nextRetryAt > 0)
})

test('B3 前 50 張過期券退款一直被拒，第 51 張仍會自動退款', async () => {
  for (let i = 0; i < 51; i++) {
    const oid = `O${i}`, iid = `I${i}`
    store.write('orders', oid, { userId: 'uA', status: 'active', itemIds: [iid], totalFee: 100, refundCount: 0, createdAt: BASE })
    store.write('order_items', iid, { orderId: oid, userId: 'uA', kind: 'product', productId: 'p1', price: 100, qty: 1, status: 'active', codeActive: true, fixedDate: true, activityDate: '2026-11-09' })
    wechat.orders[oid] = { totalFee: 100, state: 'SUCCESS' }
  }
  const real = cloudPay.refund
  try {
    cloudPay.refund = async p => {
      if (p.outTradeNo !== 'O50') return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'TRADE_OVERDUE' }
      return real(p)
    }
    for (let i = 0; i < 4; i++) {
      await runTimer()
      clock.now += 61 * MIN
    }
  } finally {
    cloudPay.refund = real
  }
  assert.strictEqual(doc('order_items', 'I50').expiredQty, 1)
  assert.strictEqual(doc('order_items', 'I50').codeActive, false)
  assert.strictEqual(wechat.refundedTotal('O50'), 100)
})

test('B4 商品頁「立即购买」遇到改價：頁面更新成新價，再按一次按新價下單', async () => {
  const attempts = []
  const api = {
    toast() {},
    async call(service, action, params) {
      const r = await call(booking, 'oA', { action, ...params })
      if (action === 'checkout') attempts.push({ expect: params.expectTotal, code: r.code || 'OK' })
      if (!r.ok) throw Object.assign(new Error(r.message), r)
      return r.data
    }
  }
  const wx = { showModal: o => o.success({ confirm: true }), showLoading() {}, hideLoading() {}, setStorageSync() {}, redirectTo() {}, navigateTo() {}, requestPayment: o => o.fail && o.fail({ errMsg: 'cancel' }) }
  const app = { userReady: Promise.resolve(), globalData: { user: { phone: '13800001111' } } }
  const ctxC = { module: { exports: {} }, console, wx, getApp: () => app, require: n => (n === './api' ? api : n === './cart' ? {} : n === './privacy' ? { ensure: async () => true } : { TPL_TIMEOUT_REFUND: '' }) }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'miniprogram/utils/checkout.js'), 'utf8'), ctxC)
  const page = loadPage('miniprogram/pages/product/index.js', { '/api': api, '/checkout': ctxC.module.exports, '/money': { formatFen: String }, '/cart': {} }, { wx, setTimeout })
  page.id = 'p1'
  await page.loadProduct()
  assert.strictEqual(page.data.p.price, 5000)
  store.write('products', 'p1', { ...doc('products', 'p1'), price: 9000 })
  await page.buyNow()
  assert.strictEqual(page.data.p.price, 9000) // 被擋下後頁面已顯示新價
  await page.buyNow()
  assert.deepStrictEqual(attempts.map(a => a.code), ['PRICE_CHANGED', 'OK'])
  assert.strictEqual(attempts[1].expect, 9000)
  const pending = all('orders').find(o => o.status === 'pending')
  assert(pending && pending.totalFee === 9000)
})

test('B5 訂場頁：點新日期後才發出的自動刷新，也查客人點的新日期', async () => {
  const pending = []
  const api = { call: (_s, _a, input) => new Promise(resolve => pending.push({ date: input.date, resolve })), toast() {} }
  const page = loadPage('miniprogram/pages/booking/index.js', { '/api': api, '/cart': { hasCourt: () => false }, '/money': { formatFen: String }, '/time': { syncServerTime() {} } })
  page.measure = () => {}
  page.data.date = '2026-11-11'
  const res = date => ({ date, days: [{ date }], serverNow: BASE, hours: [], courts: [], cells: [], banners: [] })
  // 順序一：先點日期，切換還沒回來時自動刷新
  const picked = page.load(false, '2026-11-12')
  const auto = page.load(false)
  assert.strictEqual(pending[1].date, '2026-11-12')
  pending[0].resolve(res(pending[0].date))
  pending[1].resolve(res(pending[1].date))
  await picked
  await auto
  assert.strictEqual(page.data.date, '2026-11-12')
  // 順序二：自動刷新先發，再點日期，回應倒序到達
  const auto2 = page.load(false)
  const picked2 = page.load(false, '2026-11-13')
  pending[3].resolve(res(pending[3].date))
  pending[2].resolve(res(pending[2].date))
  await picked2
  await auto2
  assert.strictEqual(page.data.date, '2026-11-13')
})

test('B6 待支付頁離開後：舊查單不再重試、不再跳轉；回來後可正常查單', async () => {
  const timers = new Map()
  const redirects = []
  let n = 0
  let calls = 0
  const api = { call: async () => { calls++; return { _id: 'O', status: calls === 1 ? 'pending' : 'active' } }, toast() {} }
  const page = loadPage('miniprogram/pages/order/pay/index.js',
    { '/api': api, '/checkout': {}, '/money': { formatFen: String }, '/time': { now: () => BASE, syncServerTime() {} } },
    { setTimeout: fn => (timers.set(++n, fn), n), clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}, wx: { redirectTo: r => redirects.push(r.url) } })
  page.orderId = 'O'
  page.load = () => {}
  page.onShow()
  page.check()
  await F.tick()
  assert.strictEqual(timers.size, 1) // 安排了 3 秒後重試
  page.onUnload()
  assert.strictEqual(timers.size, 0) // 離開時重試被取消
  assert.strictEqual(calls, 1)
  assert.strictEqual(redirects.length, 0)
  // 回到頁面重新查單，能正常跳轉
  page.onShow()
  page.check()
  await F.tick()
  assert.strictEqual(redirects.length, 1)
})

test('B6b 待支付頁：查單已發出、還沒回來時離開，回來的結果不跳轉', async () => {
  let resolveCall
  const redirects = []
  const api = { call: () => new Promise(r => (resolveCall = r)), toast() {} }
  const page = loadPage('miniprogram/pages/order/pay/index.js',
    { '/api': api, '/checkout': {}, '/money': { formatFen: String }, '/time': { now: () => BASE, syncServerTime() {} } },
    { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, wx: { redirectTo: r => redirects.push(r.url) } })
  page.orderId = 'O'
  page.load = () => {}
  page.onShow()
  page.check()
  page.onHide()
  resolveCall({ _id: 'O', status: 'active' })
  await F.tick()
  await F.tick()
  assert.strictEqual(redirects.length, 0)
})

test('B7 跨日才補做成功的退款，報表記在受理那天', async () => {
  clock.now = Date.UTC(2026, 10, 10, 15, 59) // 北京時間 11/10 23:59
  const id = await buy('oA', [product('p1')])
  const it = itemsOf(id)[0]
  const real = cloudPay.refund
  try {
    cloudPay.refund = async () => { throw new Error('offline before send') }
    must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  } finally {
    cloudPay.refund = real
  }
  clock.now += 3 * MIN // 11/11 00:02 定時補做，微信才受理
  await runTimer()
  assert.strictEqual(doc('refunds', `${id}R01`).status, 'success')
  const d10 = must(await call(admin, 'oO', { action: 'report', mode: 'day', from: '2026-11-10', to: '2026-11-10' }))
  const d11 = must(await call(admin, 'oO', { action: 'report', mode: 'day', from: '2026-11-11', to: '2026-11-11' }))
  assert.strictEqual(d10.total.refund, 0)
  assert.strictEqual(d11.total.refund, 5000)
})

test('H8 下單滿 3 年但券最近才核銷：交易完成未滿 3 年，暫不匿名化；到期後才匿名化', async () => {
  const id = await buy('oA', [product('p1')])
  store.write('orders', id, { ...doc('orders', id), status: 'completed' })
  store.write('verify_logs', 'v1', { type: 'verify', orderId: id, userId: 'uA', phone: '13800001111', at: Date.UTC(2028, 0, 1), day: '2028-01-01' })
  clock.now = Date.UTC(2029, 10, 12, 19, 0, 0) // 下單約 3 年後的凌晨 3 點
  await runTimer()
  let o = doc('orders', id)
  assert(!o.anonymizedAt && o.openid) // 手機號另由「一年未訂場刪除手機號」規則處理，這裡看匿名化本身
  assert.strictEqual(o.retainUntil, Date.UTC(2028, 0, 1) + 3 * 365 * 24 * 3600e3)
  clock.now = Date.UTC(2031, 0, 2, 19, 0, 0) // 核銷 3 年後的凌晨 3 點
  await runTimer()
  o = doc('orders', id)
  assert(o.anonymizedAt && o.openid === '' && o.userId === '')
})

// ---------------- Codex 複查報告（2026-11-12，J1–J3）回歸測試 ----------------

const adminOrd = require(path.join(ROOT, 'cloudfunctions/admin/lib/orders.js'))
// 讓「某個事務」在提交時失敗：pred(事務返回值) 為真時拋錯
async function withTxFailure(pred, fn) {
  const db = F.db
  const real = db.runTransaction
  db.runTransaction = async (body, ...args) => real.call(db, async t => {
    const v = await body(t)
    if (pred(v)) throw new Error('database commit failed')
    return v
  }, ...args)
  try {
    return await fn()
  } finally {
    db.runTransaction = real
  }
}

test('J1 核銷記錄寫不進去時，券也不扣；同一操作編號重試只扣一次、只有一筆記錄', async () => {
  const id = await buy('oA', [product('p1', 2)])
  const it = itemsOf(id)[0]
  const ev = { action: 'verifyConfirm', itemId: it._id, qty: 1, reqId: 'req-abc-001' }
  const first = await withTxFailure(v => v && v.log, () => call(admin, 'oO', ev))
  assert.strictEqual(first.ok, false)
  assert.strictEqual(doc('order_items', it._id).verifiedQty || 0, 0) // 一起失敗
  assert.strictEqual(all('verify_logs').length, 0)
  const second = must(await call(admin, 'oO', ev)) // 恢復後重按
  assert.strictEqual(second.left, 1)
  const third = must(await call(admin, 'oO', ev)) // 回覆丟失後再按一次：認出已做過
  assert.strictEqual(third.repeat, true)
  assert.strictEqual(doc('order_items', it._id).verifiedQty, 1)
  const logs = all('verify_logs').filter(l => l.type === 'verify')
  assert.strictEqual(logs.length, 1)
  // 這一筆可以當天撤銷；撤銷重按也只撤銷一次
  must(await call(admin, 'oO', { action: 'verifyUndo', logId: logs[0]._id }))
  must(await call(admin, 'oO', { action: 'verifyUndo', logId: logs[0]._id }))
  assert.strictEqual(doc('order_items', it._id).verifiedQty, 0)
  assert.strictEqual(all('verify_logs').filter(l => l.type === 'undo').length, 1)
  // 正常的下一次核銷（新編號）照常扣
  must(await call(admin, 'oO', { ...ev, reqId: 'req-abc-002' }))
  assert.strictEqual(doc('order_items', it._id).verifiedQty, 1)
})

test('J1b 扣券和記錄已完成，只是更新訂單狀態失敗：回覆成功，不引導重複核銷', async () => {
  const id = await buy('oA', [product('p1', 1)])
  const it = itemsOf(id)[0]
  const real = adminOrd.refreshStatus
  adminOrd.refreshStatus = async () => { throw new Error('status update failed') }
  let r
  try {
    r = await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1, reqId: 'req-xyz-001' })
  } finally {
    adminOrd.refreshStatus = real
  }
  assert.strictEqual(r.ok, true)
  assert.strictEqual(doc('order_items', it._id).verifiedQty, 1)
  assert.strictEqual(all('verify_logs').length, 1)
  // 客人打開訂單時重新計算狀態
  const d = must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  assert.strictEqual(d.order.status, 'completed')
})

test('J2 退款處理中：卡片按張數顯示退款中，其餘券照常可用；訂單顯示退款处理中', async () => {
  const id = await buy('oA', [product('p1', 3)])
  const it = itemsOf(id)[0]
  wechat.loseNextRefundResponse = true // 微信已受理、回覆丟失
  const r = must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  assert.strictEqual(r.processing, true)
  let d = must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  let v = d.items[0]
  assert.strictEqual(v.state, '未使用 2 · 退款中 1')
  assert.strictEqual(v.refundHint, '退款处理中，请稍候')
  assert.strictEqual(v.hasCode, true)
  assert.strictEqual(v.canRefund, false)
  assert.strictEqual(d.order.statusText, '待使用 · 退款处理中')
  const list = must(await call(booking, 'oA', { action: 'myOrders', tab: 'all' }))
  assert.strictEqual(list.list.find(o => o._id === id).statusText, '待使用 · 退款处理中')
  const ad = must(await call(admin, 'oO', { action: 'orderDetail', orderId: id }))
  assert.strictEqual(ad.items[0].state, '未使用 2 · 退款中 1')
  assert.strictEqual(ad.order.statusText, '待使用 · 退款处理中')
  // 定時任務確認退款成功後
  clock.now += 3 * MIN
  await runTimer()
  d = must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  v = d.items[0]
  assert.strictEqual(v.state, '未使用 2 · 已退款 1')
  assert.strictEqual(d.order.statusText, '待使用 · 部分退款')
  assert.strictEqual(v.canRefund, true)
})

test('J2b 退款處理中後被微信拒絕：卡片恢復可用、可退，不顯示已退款', async () => {
  const id = await buy('oA', [product('p1', 2)])
  const it = itemsOf(id)[0]
  const real = cloudPay.refund
  try {
    cloudPay.refund = async () => { throw new Error('timeout') }
    must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  } finally {
    cloudPay.refund = real
  }
  wechat.rejectRefunds = true
  clock.now += 3 * MIN
  await runTimer()
  const d = must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  assert.strictEqual(d.items[0].state, '未使用 2')
  assert.strictEqual(d.items[0].canRefund, true)
  assert.strictEqual(d.order.statusText, '待使用')
})

test('J3 微信已受理但本地記帳一直失敗：第 21 筆仍輪得到；恢復後每筆只退一次、帳目一致', async () => {
  for (let n = 0; n < 21; n++) {
    const oid = `O${n}`, iid = `I${n}`, rid = `${oid}R01`
    store.write('orders', oid, { userId: 'uA', status: 'active', itemIds: [iid], totalFee: 100, refundCount: 1, refundSeq: 1, createdAt: BASE })
    store.write('order_items', iid, { orderId: oid, kind: 'product', productId: 'p1', qty: 1, price: 100, refunding: rid, refundingFee: 100, refundingQty: 1, codeActive: true })
    store.write('refunds', rid, { orderId: oid, kind: 'items', status: 'pending', amount: 100, parts: [{ itemId: iid, qty: 1, amount: 100 }], at: BASE - 10 * MIN + n })
    wechat.orders[oid] = { state: 'SUCCESS', totalFee: 100 }
  }
  const failing = v => v && v.refund && v.refund.orderId !== 'O20'
  await withTxFailure(failing, async () => {
    for (let n = 0; n < 4; n++) {
      await runTimer()
      clock.now += MIN
    }
  })
  assert.strictEqual(wechat.refundedTotal('O20'), 100)
  assert.strictEqual(doc('refunds', 'O20R01').status, 'success')
  assert.strictEqual(doc('refunds', 'O0R01').status, 'unknown') // 保留預留，不當失敗
  assert(doc('refunds', 'O0R01').nextRetryAt > 0)
  assert.strictEqual(doc('order_items', 'I0').refunding, 'O0R01')
  // 記帳恢復後
  for (let n = 0; n < 15; n++) {
    await runTimer()
    clock.now += MIN
  }
  for (let n = 0; n < 21; n++) {
    assert.strictEqual(doc('refunds', `O${n}R01`).status, 'success')
    assert.strictEqual(wechat.refundedTotal(`O${n}`), 100)
    assert.strictEqual(doc('orders', `O${n}`).refundedFee, 100)
    assert.strictEqual(doc('order_items', `I${n}`).refundedQty, 1)
  }
})

// ---------------- Codex 全項目審查（2026-11-12，F1–F10）回歸測試 ----------------

const staff = F.loadFn('staff')
const initdb = F.loadFn('initdb')
const bookingUtil = require(path.join(ROOT, 'cloudfunctions/booking/lib/util.js'))
// 讓「下一次事務開始前」先做 fn（用來模擬兩件事交錯）
function beforeNextTx(fn) {
  const db = F.db
  const real = db.runTransaction
  let done = false
  db.runTransaction = async (body, ...args) => {
    if (!done) {
      done = true
      db.runTransaction = real
      await fn()
    }
    return real.call(db, body, ...args)
  }
  return () => (db.runTransaction = real)
}

test('F1 訂單號撞號：第二位客人自動換新號，第一位的訂單、卡片、場地都完整', async () => {
  const a = must(await checkout('oA', [court(1, 19)]))
  const real = bookingUtil.newId
  let first = true
  bookingUtil.newId = (prefix, n) => {
    if (prefix === 'FX' && first) {
      first = false
      return a.orderId // 強制撞上第一位客人的訂單號
    }
    return real(prefix, n)
  }
  let b
  try {
    b = must(await checkout('oB', [court(2, 19)]))
  } finally {
    bookingUtil.newId = real
  }
  assert.notStrictEqual(b.orderId, a.orderId)
  assert.strictEqual(doc('orders', a.orderId).userId, 'uA')
  assert.strictEqual(doc('orders', b.orderId).userId, 'uB')
  assert.strictEqual(itemsOf(a.orderId).length, 1)
  assert.strictEqual(itemsOf(a.orderId)[0].court, 1)
  assert.strictEqual(doc('slot_locks', `${D}_1_19`).orderId, a.orderId)
  assert.strictEqual(doc('slot_locks', `${D}_2_19`).orderId, b.orderId)
})

test('F3 設休息日與下單交錯（休息日先存好）：下單被擋，沒有已付款場次落在休息日', async () => {
  const restore = beforeNextTx(async () => {
    must(await call(admin, 'oO', { action: 'saveSpecial', date: D, closed: true }))
  })
  let r
  try {
    r = await checkout('oA', [court(3, 19)])
  } finally {
    restore()
  }
  assert.strictEqual(r.ok, false)
  assert.strictEqual(doc('slot_locks', `${D}_3_19`), null)
  assert(all('business_hours').some(h => h.type === 'special' && h.date === D && h.closed))
})

test('F3b 設休息日存好後、查訂單前有人下單：下單失敗，休息日照常生效', async () => {
  // 讓 saveSpecial 的第一個事務（存新設定）完成後，馬上有客人嘗試下單
  const db = F.db
  const real = db.runTransaction
  let attempt = null
  db.runTransaction = async (body, ...args) => {
    const v = await real.call(db, body, ...args)
    if (!attempt) {
      db.runTransaction = real
      attempt = await checkout('oA', [court(3, 19)])
    }
    return v
  }
  let r
  try {
    r = await call(admin, 'oO', { action: 'saveSpecial', date: D, closed: true })
  } finally {
    db.runTransaction = real
  }
  assert.strictEqual(attempt.ok, false)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(all('orders').filter(o => o.status === 'active' || o.status === 'pending').length, 0)
})

test('F3c 已有訂單時設休息日：還原設定並提示，場次照常', async () => {
  const id = await buy('oA', [court(4, 19)])
  const r = await call(admin, 'oO', { action: 'saveSpecial', date: D, closed: true })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'HAS_ORDERS')
  assert(!all('business_hours').some(h => h.type === 'special' && h.date === D))
  assert.strictEqual(doc('orders', id).status, 'active')
  // 還原後客人照常能訂這天的其他場
  must(await checkout('oB', [court(5, 19)]))
})

test('F3d 改常用營業時間與下單：改完後下單看到新時間；有訂單在外就還原', async () => {
  const id = await buy('oA', [court(1, 21)])
  const r = await call(admin, 'oO', { action: 'saveDailyHours', open: 9, close: 21 })
  assert.strictEqual(r.code, 'HAS_ORDERS')
  assert.strictEqual(doc('orders', id).status, 'active')
  must(await checkout('oB', [court(2, 21)])) // 還原後 21 點仍可訂
})

test('F2 兩人同時用老闆預設手機號綁定：只有一位老闆，設定與角色一致', async () => {
  store.write('settings', 'owner', { ownerId: 'uO', presetPhone: '13800000000' })
  store.write('users', 'uP', { openid: 'oP', role: 'customer', phone: '' })
  store.write('users', 'uQ', { openid: 'oQ', role: 'customer', phone: '' })
  const rs = await Promise.all([call(user, 'oP', { action: 'bindPhone', code: 'a' }), call(user, 'oQ', { action: 'bindPhone', code: 'b' })])
  rs.forEach(must)
  const owners = all('users').filter(x => x.role === 'owner')
  assert.strictEqual(owners.length, 1)
  assert.strictEqual(doc('settings', 'owner').ownerId, owners[0]._id)
  assert.strictEqual(doc('settings', 'owner').presetPhone, '')
  assert(['uP', 'uQ'].includes(owners[0]._id))
})

test('F10 新客人同時點兩次「同意」：只有一個帳號', async () => {
  const rs = await Promise.all([
    call(user, 'oNew', { action: 'agreePrivacy', version: 'v' }),
    call(user, 'oNew', { action: 'agreePrivacy', version: 'v' }),
    call(user, 'oNew', { action: 'agreePrivacy', version: 'v' })
  ])
  rs.forEach(must)
  const list = all('users').filter(x => x.openid === 'oNew')
  assert.strictEqual(list.length, 1)
  assert(/^U[0-9a-f]{24}$/.test(list[0]._id))
  assert.strictEqual(list[0].agreedPrivacyVersion, 'v')
})

test('F10b initdb 合併重複帳號：訂單和角色接到保留帳號，重複帳號標記不刪除；進度完成後清除', async () => {
  store.write('users', 'uD1', { openid: 'oDup', role: 'customer', phone: '', createdAt: 1 })
  store.write('users', 'uD2', { openid: 'oDup', role: 'staff', phone: '13700000000', createdAt: 2 })
  store.write('orders', 'OD1', { userId: 'uD1', status: 'completed', itemIds: ['OD1_1'], totalFee: 100, createdAt: BASE })
  store.write('order_items', 'OD1_1', { orderId: 'OD1', userId: 'uD1', kind: 'product', productId: 'p1', price: 100, qty: 1, code: '', codeActive: false })
  const r = await call(initdb, '', {})
  assert.strictEqual(r.migration.done, true)
  assert.deepStrictEqual(r.migration.usersMerged, [{ from: 'uD1', into: 'uD2' }])
  assert.strictEqual(doc('orders', 'OD1').userId, 'uD2')
  assert.strictEqual(doc('order_items', 'OD1_1').userId, 'uD2')
  assert.strictEqual(doc('users', 'uD1').mergedInto, 'uD2')
  assert.strictEqual(all('users').filter(x => x.openid === 'oDup').length, 1)
  assert.strictEqual(doc('settings', 'initdb_progress'), null)
  const again = await call(initdb, '', {}) // 再執行一次不會重複修改
  assert.deepStrictEqual(again.migration.usersMerged, [])
})

test('F4 刪除商品時剛好有人買了（L4：買過也可刪）：刪除成功，剛賣出的訂單和券照常可用', async () => {
  store.write('products', 'p3', { ...doc('products', 'p1'), name: '新品' })
  // 刪除事務讀到商品、還沒提交時，客人完成購買：刪除要重來，重來時照常刪除
  const db = F.db
  const real = db.runTransaction
  let bought = null
  let started = false
  db.runTransaction = (body, ...args) => real.call(db, async t => {
    const v = await body(t)
    if (!started) {
      started = true
      db.runTransaction = real // 客人的下單用正常事務
      bought = await buy('oA', [product('p3', 2)])
    }
    return v
  }, ...args)
  let del
  try {
    del = await call(admin, 'oO', { action: 'productDelete', id: 'p3' })
  } finally {
    db.runTransaction = real
  }
  assert.strictEqual(del.ok, true)
  assert.strictEqual(doc('products', 'p3'), null)
  assert(bought && doc('orders', bought).status === 'active')
  const it = itemsOf(bought)[0]
  assert.strictEqual(it.codeActive, true)
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1, reqId: 'req-del-0001' }))
})

test('F4a 刪除先完成，同時進行的下單整單失敗', async () => {
  store.write('products', 'p3', { ...doc('products', 'p1'), name: '新品' })
  const restore = beforeNextTx(async () => must(await call(admin, 'oO', { action: 'productDelete', id: 'p3' })))
  let r
  try {
    r = await checkout('oA', [product('p3'), court(1, 19)])
  } finally {
    restore()
  }
  assert.strictEqual(r.ok, false)
  assert.strictEqual(doc('slot_locks', `${D}_1_19`), null)
})

test('L4 刪除有人買過的商品：核銷、客人退款、管理端退款都照常，金額正確', async () => {
  const id = await buy('oA', [product('p1', 4)])
  const it = itemsOf(id)[0]
  must(await call(admin, 'oO', { action: 'productDelete', id: 'p1' }))
  assert.strictEqual(doc('products', 'p1'), null)
  mustFail(await checkout('oB', [product('p1')]))
  mustFail(await call(booking, 'oB', { action: 'product', id: 'p1' }))
  // 已買的券
  const look = must(await call(admin, 'oO', { action: 'verifyLookup', code: it.code }))
  assert.strictEqual(look.available, 4)
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1, reqId: 'req-l4-0001' }))
  const d = must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  assert.strictEqual(d.items[0].canRefund, true)
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  must(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: it._id, qty: 1, amount: it.price }] }))
  const after = doc('order_items', it._id)
  assert.strictEqual(after.verifiedQty, 1)
  assert.strictEqual(after.refundedQty, 2)
  assert.strictEqual(wechat.refundedTotal(id), 2 * it.price)
  assert.strictEqual(doc('orders', id).refundedFee, 2 * it.price)
  assert.strictEqual(doc('products', 'p1'), null) // 退款不會把已刪除的商品「加回」
})

test('L4b 刪除有人買過的固定日期活動：過期照常自動退款', async () => {
  const id = await buy('oA', [product('p2', 2)])
  must(await call(admin, 'oO', { action: 'productDelete', id: 'p2' }))
  clock.now = Date.UTC(2026, 10, 12, 2, 0, 0)
  await runTimer()
  assert.strictEqual(itemsOf(id)[0].expiredQty, 2)
  assert.strictEqual(wechat.refundedTotal(id), 2 * 8800)
})

test('F4b 買過的商品下架後：客人看不到、不能買；已買的券照常可核銷、可退款', async () => {
  const id = await buy('oA', [product('p1', 3)])
  const it = itemsOf(id)[0]
  must(await call(admin, 'oO', { action: 'productToggle', id: 'p1', onShelf: false }))
  mustFail(await checkout('oB', [product('p1')]))
  const shelf = must(await call(booking, 'oB', { action: 'products' }))
  assert(!shelf.some(p => p._id === 'p1'))
  // 核銷
  must(await call(admin, 'oO', { action: 'verifyLookup', code: it.code }))
  must(await call(admin, 'oO', { action: 'verifyConfirm', itemId: it._id, qty: 1, reqId: 'req-off-0001' }))
  // 客人自己退一張
  const d = must(await call(booking, 'oA', { action: 'orderDetail', orderId: id }))
  assert.strictEqual(d.items[0].canRefund, true)
  must(await call(booking, 'oA', { action: 'refund', orderId: id, itemId: it._id, qty: 1 }))
  // 管理端退一張
  must(await call(admin, 'oO', { action: 'refund', orderId: id, parts: [{ itemId: it._id, qty: 1, amount: it.price }] }))
  const after = doc('order_items', it._id)
  assert.strictEqual(after.verifiedQty, 1)
  assert.strictEqual(after.refundedQty, 2)
  assert.strictEqual(wechat.refundedTotal(id), 2 * it.price)
})

test('F4c 固定日期活動下架後過期：已買未用的券照常自動退款', async () => {
  const id = await buy('oA', [product('p2', 2)])
  must(await call(admin, 'oO', { action: 'productToggle', id: 'p2', onShelf: false }))
  clock.now = Date.UTC(2026, 10, 12, 2, 0, 0)
  await runTimer()
  assert.strictEqual(itemsOf(id)[0].expiredQty, 2)
  assert.strictEqual(wechat.refundedTotal(id), 2 * 8800)
})

test('F5 同時保存兩筆重疊的單日價格：只有一筆成功，另一筆提示衝突', async () => {
  const rule = { dates: [D], startHour: 19, endHour: 20, courts: [1], price: 7000 }
  const rs = await Promise.all([call(admin, 'oO', { action: 'saveDaily', rule }), call(admin, 'oO', { action: 'saveDaily', rule: { ...rule, price: 9000 } })])
  assert.strictEqual(rs.filter(r => r.ok).length, 1)
  assert.strictEqual(rs.find(r => !r.ok).code, 'CONFLICT')
  assert.strictEqual(all('prices').filter(p => p.type === 'daily').length, 1)
})

test('F6 新員工第一次掃邀請碼：同意協議後自動綁定；不同意不會用掉邀請碼', async () => {
  store.write('invites', 'CODE1', { type: 'staff', used: false, expiresAt: BASE + 10 * MIN })
  const api = {
    toast() {},
    async call(svc, action, params) {
      const r = await call(svc === 'staff' ? staff : user, 'oStaff', { action, ...params })
      if (!r.ok) throw new Error(r.message)
      return r.data
    }
  }
  const app = {
    globalData: {},
    userReady: api.call('user', 'login'),
    refreshUser: () => api.call('user', 'login').then(u => (app.globalData.user = u))
  }
  const page = loadPage('miniprogram/pages/bind/index.js', { '/api': api }, { getApp: () => app, wx: {} })
  page.onLoad({ scene: 'CODE1' })
  await app.userReady
  await F.tick()
  assert.strictEqual(page.data.status, 'wait')
  assert.strictEqual(doc('invites', 'CODE1').used, false) // 還沒同意：邀請碼沒被用掉
  must(await call(user, 'oStaff', { action: 'agreePrivacy', version: 'v' }))
  await page.onAgreed()
  for (let i = 0; i < 10; i++) await F.tick()
  assert.strictEqual(page.data.status, 'ok')
  assert.strictEqual(doc('invites', 'CODE1').used, true)
  assert.strictEqual(all('users').find(x => x.openid === 'oStaff').role, 'staff')
})

test('F7 我的订单：舊分頁的結果晚到，不會蓋掉新分頁', async () => {
  const qs = []
  const api = { toast() {}, call: (_s, _a, p) => new Promise(r => qs.push({ tab: p.tab, r })) }
  const page = loadPage('miniprogram/pages/order/list/index.js', {
    '/api': api, '/cards': { split: () => [], linesOf: () => [] }, '/money': { formatFen: String },
    '/time': { syncServerTime() {}, formatBeijing: String, now: () => BASE }
  })
  page.tick = () => {}
  const old = page.load(true)
  page.switchTab({ currentTarget: { dataset: { key: 'refund' } } })
  qs[1].r({ list: [{ _id: 'refund', status: 'refunded' }], more: false })
  await F.tick()
  qs[0].r({ list: [{ _id: 'unpaid', status: 'pending' }], more: false })
  await old
  await F.tick()
  assert.strictEqual(page.data.tab, 'refund')
  assert.deepStrictEqual(page.data.list.map(o => o._id), ['refund'])
})

test('F8 付了舊訂單（×1）後，購物車只扣 1，後來加的 2 張保留', async () => {
  let data = [{ type: 'product', productId: 'p1', qty: 3 }, { type: 'court', date: D, court: 1, hour: 19 }]
  const ctx = { module: { exports: {} }, wx: { getStorageSync: () => data, setStorageSync: (_k, v) => (data = v) }, require: () => ({}) }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'miniprogram/utils/cart.js'), 'utf8'), ctx)
  ctx.module.exports.removeBought([{ type: 'product', productId: 'p1', qty: 1 }, { type: 'court', date: D, court: 1, hour: 19 }])
  assert.strictEqual(JSON.stringify(data), JSON.stringify([{ type: 'product', productId: 'p1', qty: 2 }]))
})

test('F9 橫幅按「同一時刻」計算上限：不同日子的限時橫幅可超過 5 張；同時段第 6 張被拒；同時上架不能突破', async () => {
  const banner = (day, extra = {}) => ({ image: 'cloud://b', mode: 'timed', enabled: true, startDate: `2026-11-${day}`, startTime: '10:00', endDate: `2026-11-${day}`, endTime: '11:00', ...extra })
  for (let i = 0; i < 6; i++) must(await call(admin, 'oO', { action: 'bannerSave', banner: banner(11 + i) }))
  // 11 日同一時段再加 4 張（共 5 張），第 6 張被拒
  for (let i = 0; i < 4; i++) must(await call(admin, 'oO', { action: 'bannerSave', banner: banner(11) }))
  mustFail(await call(admin, 'oO', { action: 'bannerSave', banner: banner(11) }), /5 张/)
  // 長期橫幅會和 11 日那 5 張重疊，也被拒
  mustFail(await call(admin, 'oO', { action: 'bannerSave', banner: { image: 'cloud://b', mode: 'long', enabled: true } }), /5 张/)
  // 12 日只有 1 張：同時上架 5 張，最多只能再成功 4 張
  const rs = await Promise.all([0, 1, 2, 3, 4].map(() => call(admin, 'oO', { action: 'bannerSave', banner: banner(12) })))
  assert.strictEqual(rs.filter(r => r.ok).length, 4)
})

test('initdb 在沒有資料要整理時也能順利完成（不存空記錄）；中途超時後可接著做', async () => {
  store.reset() // 全新、空的資料庫
  let r = await call(initdb, '', {})
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.migration.done, true)
  assert.strictEqual(doc('settings', 'initdb_progress'), null)
  // 有一點舊資料、且這次執行時間不夠：返回 done:false，進度存下，再執行一次就完成
  seed()
  store.write('orders', 'OLD1', { userId: 'uA', status: 'completed', totalFee: 100, createdAt: BASE })
  store.write('order_items', 'OLD1_1', { orderId: 'OLD1', userId: 'uA', kind: 'product', productId: 'p1', price: 100, qty: 1, code: '' })
  // 模擬執行到一半時間用完：處理第一張訂單時把時鐘往後撥 2 分鐘（超過 50 秒的執行預算）
  const db = F.db
  const realColl = db.collection
  db.collection = name => {
    const c = realColl.call(db, name)
    if (name === 'order_items') {
      const where = c.where.bind(c)
      c.where = cond => {
        if (cond && cond.orderId === 'OLD1') clock.now += 2 * MIN
        return where(cond)
      }
    }
    return c
  }
  try {
    r = await call(initdb, '', {})
  } finally {
    db.collection = realColl
  }
  assert.strictEqual(r.migration.done, false)
  assert(doc('settings', 'initdb_progress'))
  r = await call(initdb, '', {})
  assert.strictEqual(r.migration.done, true)
  assert.deepStrictEqual(doc('orders', 'OLD1').itemIds, ['OLD1_1'])
  assert.strictEqual(doc('settings', 'initdb_progress'), null)
})

// ---------------- 送審前合規（2026-11-14，L1、L2）回歸測試 ----------------

// 在沙盒裡載入小程序的協議彈窗元件和 utils/privacy，共用同一個假的 wx 和 app
function loadPrivacy({ apiCall } = {}) {
  const storage = {}
  const toasts = []
  const app = { globalData: { user: null, privacyDeclined: false }, refreshUser: async () => ({ _id: 'u1', phone: '' }) }
  const wx = {
    getStorageSync: k => storage[k],
    setStorageSync: (k, v) => (storage[k] = v),
    showToast: o => toasts.push(o.title),
    navigateTo() {}
  }
  const api = { call: apiCall || (async () => true), toast: m => toasts.push(m) }
  const config = { PRIVACY_VERSION: 'V1' }
  const pctx = { module: { exports: {} }, wx, require: n => (n.endsWith('/config') ? config : {}) }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'miniprogram/utils/privacy.js'), 'utf8'), pctx)
  const privacy = pctx.module.exports
  let def
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'miniprogram/components/privacy-modal/index.js'), 'utf8'), {
    Component: d => (def = d), wx, getApp: () => app, console,
    require: n => (n.endsWith('/api') ? api : n.endsWith('/config') ? config : privacy)
  })
  const events = []
  const comp = { data: JSON.parse(JSON.stringify(def.data)), ...def.methods }
  comp.setData = patch => Object.assign(comp.data, patch)
  comp.triggerEvent = name => events.push(name)
  const attach = () => def.lifetimes.attached.call(comp)
  return { comp, attach, privacy, storage, toasts, app, events, page: { selectComponent: id => (id === '#privacy' ? comp : null) } }
}

test('L1 首次打開自動彈出；點「不同意」只關閉，照常瀏覽，本次不再自動彈出', async () => {
  const t = loadPrivacy()
  t.attach()
  assert.strictEqual(t.comp.data.show, true)
  t.comp.onDisagree()
  assert.strictEqual(t.comp.data.show, false)
  assert.strictEqual(t.app.globalData.privacyDeclined, true)
  // 換到別的頁面：不再自動彈出
  const again = loadPrivacy()
  again.app.globalData.privacyDeclined = true
  again.attach()
  assert.strictEqual(again.comp.data.show, false)
})

test('L1b 需要帳號的操作才再彈出：不同意返回 false；同意後返回 true，且記下版本', async () => {
  const t = loadPrivacy()
  t.app.globalData.privacyDeclined = true
  let p = t.privacy.ensure(t.page)
  assert.strictEqual(t.comp.data.show, true)
  t.comp.onDisagree()
  assert.strictEqual(await p, false)
  p = t.privacy.ensure(t.page)
  t.comp.toggle()
  t.comp.onAgree()
  assert.strictEqual(await p, true)
  assert.strictEqual(t.storage.privacyAgreedVersion, 'V1')
  assert.strictEqual(t.privacy.agreed(), true)
  assert.strictEqual(await t.privacy.ensure(t.page), true) // 已同意：不再彈出
  assert(t.events.includes('agreed'))
})

test('L1c 沒勾選就按同意：不放行；伺服器記錄失敗：不算同意', async () => {
  let fail = true
  const t = loadPrivacy({ apiCall: async () => { if (fail) throw new Error('net'); return true } })
  const p = t.privacy.ensure(t.page)
  t.comp.onAgree() // 沒勾選
  assert.strictEqual(t.comp.data.show, true)
  t.comp.toggle()
  t.comp.onAgree() // 伺服器失敗
  for (let i = 0; i < 5; i++) await F.tick()
  assert.strictEqual(t.comp.data.show, true)
  assert.strictEqual(t.privacy.agreed(), false)
  fail = false
  t.comp.onAgree()
  assert.strictEqual(await p, true)
})

test('L2 同意後不自動索取手機號（彈窗直接關閉，沒有手機號步驟）', async () => {
  const t = loadPrivacy()
  t.attach()
  t.comp.toggle()
  t.comp.onAgree()
  for (let i = 0; i < 5; i++) await F.tick()
  assert.strictEqual(t.comp.data.show, false)
  assert(!('step' in t.comp.data))
  assert(!fs.readFileSync(path.join(ROOT, 'miniprogram/components/privacy-modal/index.wxml'), 'utf8').includes('getPhoneNumber'))
})

test('L1d 未同意協議時下單：先彈同意畫面，不同意就不建立訂單', async () => {
  const t = loadPrivacy()
  let calls = 0
  const api = { toast() {}, call: async () => { calls++; return {} } }
  const ctx = {
    module: { exports: {} }, console, wx: { showModal: o => o.success({ confirm: true }), showLoading() {}, hideLoading() {} },
    getApp: () => ({ userReady: Promise.resolve(), globalData: { user: { phone: '1' } } }),
    require: n => (n === './api' ? api : n === './privacy' ? t.privacy : n === './cart' ? {} : { TPL_TIMEOUT_REFUND: '' })
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'miniprogram/utils/checkout.js'), 'utf8'), ctx)
  const p = ctx.module.exports.start(t.page, [product('p1')], {})
  t.comp.onDisagree()
  const r = await p
  assert.strictEqual(r.ok, false)
  assert.strictEqual(calls, 0)
})

test('L5 時間選擇 24 小時制：兩列 00–23、00–59；選 13:30 輸出 13:30；不再使用 mode="time"', async () => {
  let def
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'miniprogram/components/time-picker/index.js'), 'utf8'), { Component: d => (def = d) })
  const comp = { data: JSON.parse(JSON.stringify(def.data)), ...def.methods }
  comp.setData = patch => Object.assign(comp.data, patch)
  const events = []
  comp.triggerEvent = (name, detail) => events.push({ name, detail })
  const [hours, minutes] = comp.data.range
  assert.strictEqual(hours.length, 24)
  assert.strictEqual(hours[0], '00')
  assert.strictEqual(hours[23], '23')
  assert.strictEqual(minutes.length, 60)
  assert.strictEqual(minutes[59], '59')
  def.observers.value.call(comp, '21:05')
  assert.deepStrictEqual([...comp.data.index], [21, 5])
  def.observers.value.call(comp, '') // 沒有值時停在 00:00
  assert.deepStrictEqual([...comp.data.index], [0, 0])
  comp.onChange({ detail: { value: [13, 30] } })
  assert.strictEqual(events[0].name, 'change')
  assert.strictEqual(events[0].detail.value, '13:30')
  comp.onChange({ detail: { value: [0, 0] } })
  assert.strictEqual(events[1].detail.value, '00:00')
  // 全項目不再使用跟隨手機設置的 picker mode="time"
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]))
  const offenders = walk(path.join(ROOT, 'miniprogram')).filter(f => f.endsWith('.wxml') && fs.readFileSync(f, 'utf8').includes('mode="time"'))
  assert.deepStrictEqual(offenders, [])
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
