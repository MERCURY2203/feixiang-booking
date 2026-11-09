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
