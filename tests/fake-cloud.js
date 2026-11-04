// 測試用的「假微信雲開發」：內存數據庫（含會檢測衝突的事務）、假微信支付、可控時鐘
// 只用於 tests/，不會上傳。每次數據庫操作都會讓出一次執行權，用 Promise.all 就能模擬兩個請求同時到達。
const Module = require('module')
const path = require('path')

const tick = () => new Promise(r => setImmediate(r))
const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))

// ---------- 時鐘 ----------
const clock = { now: Date.UTC(2026, 10, 10, 2, 0, 0) } // 2026-11-10 10:00 北京時間（周二）
Date.now = () => clock.now

// ---------- 查詢指令 ----------
class Cmd {
  constructor(op, val) {
    this.op = op
    this.val = val
  }
  and(other) {
    return new Cmd('and', [this, other])
  }
  or(other) {
    return new Cmd('or', [this, other])
  }
}
const command = {
  in: v => new Cmd('in', v),
  lt: v => new Cmd('lt', v),
  lte: v => new Cmd('lte', v),
  gt: v => new Cmd('gt', v),
  gte: v => new Cmd('gte', v),
  neq: v => new Cmd('neq', v),
  eq: v => new Cmd('eq', v),
  exists: v => new Cmd('exists', v),
  inc: v => new Cmd('inc', v),
  and: list => new Cmd('qand', list),
  or: list => new Cmd('qor', list)
}

function evalField(dv, c) {
  if (c instanceof Cmd) {
    switch (c.op) {
      case 'in': return c.val.includes(dv)
      case 'lt': return dv !== undefined && dv < c.val
      case 'lte': return dv !== undefined && dv <= c.val
      case 'gt': return dv !== undefined && dv > c.val
      case 'gte': return dv !== undefined && dv >= c.val
      case 'neq': return dv !== c.val
      case 'eq': return dv === c.val
      case 'exists': return (dv !== undefined) === c.val
      case 'and': return c.val.every(x => evalField(dv, x))
      case 'or': return c.val.some(x => evalField(dv, x))
      default: throw new Error(`unsupported cmd ${c.op}`)
    }
  }
  if (c && c.$regex) return typeof dv === 'string' && new RegExp(c.$regex).test(dv)
  return dv === c
}

function matches(doc, cond) {
  if (!cond) return true
  if (cond instanceof Cmd) {
    if (cond.op === 'qand') return cond.val.every(x => matches(doc, x))
    if (cond.op === 'qor') return cond.val.some(x => matches(doc, x))
    throw new Error('bad top-level cmd')
  }
  return Object.keys(cond).every(k => evalField(doc[k], cond[k]))
}

function applyUpdate(doc, data) {
  const out = { ...doc }
  for (const [k, v] of Object.entries(data)) {
    if (k === '_id') throw new Error('不能更新 _id')
    if (v instanceof Cmd) {
      if (v.op !== 'inc') throw new Error(`unsupported update cmd ${v.op}`)
      out[k] = (out[k] || 0) + v.val
    } else out[k] = clone(v)
  }
  return out
}

function notExist(coll, id) {
  const e = new Error(`document.get:fail document with _id ${id} does not exist (${coll})`)
  e.errCode = -502005
  return e
}

// ---------- 內存數據庫 ----------
class Store {
  constructor() {
    this.reset()
  }
  reset() {
    this.colls = new Map()
    this.ver = 0
    this.idSeq = 0
  }
  coll(name) {
    if (!this.colls.has(name)) this.colls.set(name, new Map())
    return this.colls.get(name)
  }
  read(name, id) {
    const r = this.coll(name).get(id)
    return r ? { doc: clone(r.doc), ver: r.ver } : { doc: null, ver: 0 }
  }
  write(name, id, doc) {
    if (doc === null) this.coll(name).delete(id)
    else this.coll(name).set(id, { doc: clone({ ...doc, _id: id }), ver: ++this.ver })
  }
  verOf(name, id) {
    const r = this.coll(name).get(id)
    return r ? r.ver : 0
  }
  all(name) {
    return [...this.coll(name).values()].map(r => clone(r.doc))
  }
}

function makeDb(store) {
  function query(name, cond, sort = [], skipN = 0, limitN = 100) {
    const q = {
      where: c => query(name, c, sort, skipN, limitN),
      orderBy: (f, dir) => query(name, cond, sort.concat([[f, dir]]), skipN, limitN),
      skip: n => query(name, cond, sort, n, limitN),
      limit: n => query(name, cond, sort, skipN, Math.min(n, 1000)),
      field: () => q,
      async get() {
        await tick()
        let list = store.all(name).filter(d => matches(d, cond))
        for (const [f, dir] of sort.slice().reverse()) {
          list.sort((a, b) => ((a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1)))
        }
        return { data: list.slice(skipN, skipN + limitN) }
      },
      async count() {
        await tick()
        return { total: store.all(name).filter(d => matches(d, cond)).length }
      },
      async update({ data }) {
        await tick()
        const list = store.all(name).filter(d => matches(d, cond))
        for (const d of list) store.write(name, d._id, applyUpdate(d, data))
        return { stats: { updated: list.length } }
      },
      async remove() {
        await tick()
        const list = store.all(name).filter(d => matches(d, cond))
        for (const d of list) store.write(name, d._id, null)
        return { stats: { removed: list.length } }
      },
      doc: id => ({
        async get() {
          await tick()
          const r = store.read(name, id)
          if (!r.doc) throw notExist(name, id)
          return { data: r.doc }
        },
        async set({ data }) {
          await tick()
          if ('_id' in data) throw new Error('set 的 data 不能包含 _id')
          store.write(name, id, data)
          return { stats: { updated: 1 } }
        },
        async update({ data }) {
          await tick()
          const r = store.read(name, id)
          if (!r.doc) return { stats: { updated: 0 } }
          store.write(name, id, applyUpdate(r.doc, data))
          return { stats: { updated: 1 } }
        },
        async remove() {
          await tick()
          store.write(name, id, null)
          return { stats: { removed: 1 } }
        }
      }),
      async add({ data }) {
        await tick()
        const id = data._id || `auto${++store.idSeq}`
        if (store.read(name, id).doc) throw new Error('duplicate _id')
        const { _id, ...rest } = data
        store.write(name, id, rest)
        return { _id: id }
      }
    }
    return q
  }

  async function runTransaction(fn, times = 3) {
    for (let attempt = 0; attempt < times; attempt++) {
      const seen = new Map() // key → ver 第一次接觸時
      const buf = new Map() // key → doc | null
      let rolled = null
      const key = (c, id) => `${c}\u0000${id}`
      const touch = (c, id) => {
        const k = key(c, id)
        if (!seen.has(k)) seen.set(k, store.verOf(c, id))
      }
      const current = (c, id) => {
        const k = key(c, id)
        if (buf.has(k)) return clone(buf.get(k))
        return store.read(c, id).doc
      }
      const t = {
        collection: c => ({
          doc: id => ({
            async get() {
              await tick()
              touch(c, id)
              const d = current(c, id)
              if (!d) throw notExist(c, id)
              return { data: d }
            },
            async set({ data }) {
              await tick()
              if ('_id' in data) throw new Error('set 的 data 不能包含 _id')
              touch(c, id)
              buf.set(key(c, id), { ...clone(data), _id: id })
            },
            async update({ data }) {
              await tick()
              touch(c, id)
              const d = current(c, id)
              if (!d) throw new Error(`transaction update: ${c}/${id} does not exist`)
              buf.set(key(c, id), applyUpdate(d, data))
            },
            async remove() {
              await tick()
              touch(c, id)
              buf.set(key(c, id), null)
            }
          }),
          where() {
            throw new Error('事務裡不能用 where 查詢')
          }
        }),
        rollback(val) {
          rolled = { val }
          return Promise.resolve()
        }
      }
      const result = await fn(t)
      if (rolled) throw rolled.val
      await tick()
      // 提交：所有接觸過的文檔版本必須沒變
      let conflict = false
      for (const [k, ver] of seen) {
        const [c, id] = k.split('\u0000')
        if (store.verOf(c, id) !== ver) conflict = true
      }
      if (conflict) {
        stats.txConflicts++
        continue
      }
      for (const [k, d] of buf) {
        const [c, id] = k.split('\u0000')
        if (d === null) store.write(c, id, null)
        else {
          const { _id, ...rest } = d
          store.write(c, id, rest)
        }
      }
      return result
    }
    const e = new Error('transaction conflict, retries exhausted')
    e.errCode = -502001
    throw e
  }

  return {
    command,
    collection: name => query(name),
    RegExp: ({ regexp }) => ({ $regex: regexp }),
    runTransaction,
    createCollection: async () => {}
  }
}

const stats = { txConflicts: 0 }
const store = new Store()
const db = makeDb(store)

// ---------- 假微信支付 ----------
const wechat = {
  orders: {}, refunds: {}, refundCalls: [], loseNextRefundResponse: false,
  reset() {
    this.orders = {}
    this.refunds = {}
    this.refundCalls = []
    this.loseNextRefundResponse = false
  },
  // 客人在微信裡付款成功
  pay(orderId) {
    const o = this.orders[orderId]
    if (!o) throw new Error('wechat order not found')
    if (o.state !== 'NOTPAY') throw new Error(`cannot pay: ${o.state}`)
    if (clock.now > o.expireAt) throw new Error('wechat order expired')
    o.state = 'SUCCESS'
    o.paidAt = clock.now
  },
  refundedTotal(orderId) {
    return Object.entries(this.refunds).filter(([, r]) => r.orderId === orderId).reduce((s, [, r]) => s + r.fee, 0)
  }
}
function wxTime(ts) {
  const d = new Date(ts + 8 * 3600e3)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}
function parseWx(s) {
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - 8 * 3600e3
}

const ctx = { openid: '' }
const cloudPay = {
  async unifiedOrder(p) {
    await tick()
    wechat.orders[p.outTradeNo] = { totalFee: p.totalFee, state: 'NOTPAY', expireAt: parseWx(p.timeExpire) + 999 }
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', payment: { timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' } }
  },
  async queryOrder({ outTradeNo }) {
    await tick()
    const o = wechat.orders[outTradeNo]
    if (!o) return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'ORDERNOTEXIST' }
    return {
      returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo, tradeState: o.state, totalFee: o.totalFee,
      timeEnd: o.paidAt ? wxTime(o.paidAt) : ''
    }
  },
  async closeOrder({ outTradeNo }) {
    await tick()
    const o = wechat.orders[outTradeNo]
    if (!o) return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'ORDERNOTEXIST' }
    if (o.state === 'SUCCESS') return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'ORDERPAID' }
    o.state = 'CLOSED'
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS' }
  },
  async refund({ outTradeNo, outRefundNo, refundFee, totalFee }) {
    await tick()
    wechat.refundCalls.push(outRefundNo)
    const o = wechat.orders[outTradeNo]
    if (!o || o.state !== 'SUCCESS') return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'TRADE_STATE_ERROR' }
    if (totalFee !== o.totalFee) return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'PARAM_ERROR' }
    if (!wechat.refunds[outRefundNo]) {
      if (wechat.refundedTotal(outTradeNo) + refundFee > o.totalFee) return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'NOTENOUGH' }
      wechat.refunds[outRefundNo] = { orderId: outTradeNo, fee: refundFee }
    } else if (wechat.refunds[outRefundNo].fee !== refundFee) {
      return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'INVALID_REQUEST' }
    }
    if (wechat.loseNextRefundResponse) {
      wechat.loseNextRefundResponse = false
      throw new Error('socket hang up') // 微信已受理，但回覆在網絡上丟失
    }
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS' }
  }
}

const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: ctx.openid, ENV: 'test-env' }),
  cloudPay,
  openapi: {
    subscribeMessage: { send: async () => ({}) },
    phonenumber: { getPhoneNumber: async () => ({ phoneInfo: { purePhoneNumber: '13800000000' } }) },
    wxacode: { getUnlimited: async () => ({ buffer: Buffer.from('') }) }
  },
  uploadFile: async () => ({ fileID: 'cloud://x' }),
  getTempFileURL: async () => ({ fileList: [] })
}

// 攔截雲函數裡的 require
const origLoad = Module._load
Module._load = function (req, parent, isMain) {
  if (req === 'wx-server-sdk') return cloudMock
  if (req === 'qrcode') return { toDataURL: async () => 'data:image/png;base64,' }
  if (req === 'xlsx') return { utils: { book_new: () => ({}), aoa_to_sheet: () => ({}), book_append_sheet: () => {} }, write: () => Buffer.from('') }
  return origLoad.apply(this, arguments)
}

const root = path.join(__dirname, '..', 'cloudfunctions')
function loadFn(name) {
  return require(path.join(root, name, 'index.js'))
}

// 以某個客人的身份調用雲函數；openid 為空代表系統（定時器、支付回調）
async function call(fn, openid, event) {
  ctx.openid = openid || ''
  return fn.main(event || {})
}

module.exports = { clock, store, db, wechat, ctx, stats, call, loadFn, tick, command }
