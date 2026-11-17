// 員工與老闆綁定雲函數（規格書「老闆綁定」「員工管理」）
//
// 客人端可呼叫：redeemInvite
// 僅老闆可呼叫：createInvite（type：staff 員工／host 組局員，澄清 N1）、listStaff、setRemark、removeStaff
// 僅開發者在雲開發控制台「雲端測試」可呼叫：createOwnerInvite（控制台呼叫時沒有 OPENID）
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const invites = db.collection('invites')

const STAFF_TTL = 10 * 60 * 1000 // 員工碼 10 分鐘
const OWNER_TTL = 24 * 60 * 60 * 1000 // 老闆碼 24 小時
// 小程序未正式發布前，二維碼要打開「開發版」；上線後在雲函數環境變量把 QR_ENV_VERSION 設為 release
const QR_ENV_VERSION = process.env.QR_ENV_VERSION || 'develop'

const ok = data => ({ ok: true, data })
const fail = (message, code = 'ERROR') => ({ ok: false, code, message })
const INVALID = '邀请码已失效，请联系老板重新生成'

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(16)
  let s = ''
  for (const b of bytes) s += chars[b % chars.length]
  return s
}

function publicUser(u) {
  return { _id: u._id, role: u.role, nickname: u.nickname || '', avatar: u.avatar || '', phone: u.phone || '' }
}

async function audit(actorId, action, detail) {
  await db.collection('audit_logs').add({ data: { actorId, action, detail, at: Date.now() } })
}

async function getCaller(openid) {
  const found = await users.where({ openid }).limit(1).get()
  return found.data[0] || null
}

// 產生邀請碼並生成小程序碼圖片，存到雲存儲
async function makeInvite(type, ttl, createdBy) {
  const code = newCode()
  const expiresAt = Date.now() + ttl
  const qr = await cloud.openapi.wxacode.getUnlimited({
    scene: code,
    page: 'pages/bind/index',
    checkPath: false,
    envVersion: QR_ENV_VERSION,
    width: 430
  })
  const upload = await cloud.uploadFile({ cloudPath: `invites/${code}.png`, fileContent: qr.buffer })
  await invites.add({ data: { _id: code, code, type, expiresAt, used: false, createdBy, createdAt: Date.now(), qrFileId: upload.fileID } })
  return { code, type, expiresAt, qrFileId: upload.fileID }
}

async function redeem(user, code) {
  const now = Date.now()
  // 事務：邀請碼標記已用和設定身份必須同時成功，保證一個碼只能用一次
  const result = await db.runTransaction(async t => {
    let inv
    try {
      inv = (await t.collection('invites').doc(code).get()).data
    } catch (e) {
      return { error: INVALID }
    }
    if (!inv || inv.used || inv.expiresAt < now) return { error: INVALID }
    if ((inv.type === 'staff' || inv.type === 'host') && user.role === 'owner') return { error: '你已是老板，无需绑定员工身份' }

    await t.collection('invites').doc(code).update({ data: { used: true, usedBy: user._id, usedAt: now } })
    if (inv.type === 'owner') {
      // 系統只有一位老闆：舊老闆身份自動移除（目前老闆記在 settings/owner.ownerId）
      const setting = (await t.collection('settings').doc('owner').get()).data
      if (setting.ownerId && setting.ownerId !== user._id) {
        await t.collection('users').doc(setting.ownerId).update({ data: { role: 'customer' } })
      }
      await t.collection('users').doc(user._id).update({ data: { role: 'owner' } })
      await t.collection('settings').doc('owner').update({ data: { ownerId: user._id } })
      return { role: 'owner', type: inv.type }
    }
    // 員工碼 → 員工；組局員碼 → 組局員（已是另一種身份的改為新身份）
    const role = inv.type === 'host' ? 'host' : 'staff'
    await t.collection('users').doc(user._id).update({ data: { role, staffSince: now } })
    return { role, type: inv.type }
  })
  if (result.error) return fail(result.error, 'INVITE_INVALID')
  await audit(user._id, `bind_${result.type}`, { code })
  return ok(publicUser({ ...user, role: result.role }))
}

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()

  try {
    // 開發者在控制台產生老闆碼
    if (event.action === 'createOwnerInvite') {
      if (OPENID) return fail('无权限', 'FORBIDDEN')
      return ok(await makeInvite('owner', OWNER_TTL, 'developer'))
    }

    if (!OPENID) return fail('请在小程序内使用', 'NO_OPENID')
    const caller = await getCaller(OPENID)
    if (!caller) return fail('请重新打开小程序')

    if (event.action === 'redeemInvite') {
      const code = String(event.code || '').trim().toUpperCase()
      if (!code) return fail(INVALID, 'INVITE_INVALID')
      return await redeem(caller, code)
    }

    // 以下僅老闆可用；權限在雲函數判斷，不相信手機傳來的身份
    if (caller.role !== 'owner') return fail('无权限', 'FORBIDDEN')

    switch (event.action) {
      case 'createInvite': {
        const type = event.type === 'host' ? 'host' : 'staff'
        const inv = await makeInvite(type, STAFF_TTL, caller._id)
        await audit(caller._id, type === 'host' ? 'create_host_invite' : 'create_staff_invite', { code: inv.code })
        return ok(inv)
      }

      case 'listStaff': {
        const res = await users.where({ role: _.in(['staff', 'host']) }).orderBy('staffSince', 'asc').limit(100).get()
        return ok(res.data.map(u => ({ ...publicUser(u), remark: u.remark || '', staffSince: u.staffSince || u.createdAt })))
      }

      case 'setRemark': {
        const remark = String(event.remark || '').trim().slice(0, 20)
        const res = await users.where({ _id: event.userId, role: _.in(['staff', 'host']) }).update({ data: { remark } })
        if (!res.stats.updated && remark) return fail('该员工不存在')
        await audit(caller._id, 'set_staff_remark', { userId: event.userId, remark })
        return ok(true)
      }

      case 'removeStaff': {
        const res = await users.where({ _id: event.userId, role: _.in(['staff', 'host']) }).update({ data: { role: 'customer', remark: '', removedAt: Date.now() } })
        if (!res.stats.updated) return fail('该员工不存在或已被移除')
        await audit(caller._id, 'remove_staff', { userId: event.userId })
        return ok(true)
      }

      default:
        return fail('未知操作')
    }
  } catch (e) {
    console.error(e)
    return fail('操作失败，请稍后再试')
  }
}
