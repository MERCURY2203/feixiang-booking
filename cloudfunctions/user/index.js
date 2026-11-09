// 用戶雲函數：登入、同意協議、綁定手機號（含老闆手機號備用路）、修改頭像暱稱
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const users = db.collection('users')

const ok = data => ({ ok: true, data })
const fail = (message, code = 'ERROR') => ({ ok: false, code, message })

function publicUser(u) {
  return {
    _id: u._id,
    role: u.role,
    nickname: u.nickname || '',
    avatar: u.avatar || '',
    phone: u.phone || '',
    agreedPrivacyAt: u.agreedPrivacyAt || null,
    agreedPrivacyVersion: u.agreedPrivacyVersion || ''
  }
}

async function getOrCreate(openid) {
  const found = await users.where({ openid }).limit(1).get()
  if (found.data.length) return found.data[0]
  const doc = { openid, role: 'customer', nickname: '', avatar: '', phone: '', remark: '', createdAt: Date.now() }
  const res = await users.add({ data: doc })
  return { _id: res._id, ...doc }
}

async function audit(actor, action, detail) {
  await db.collection('audit_logs').add({ data: { actorId: actor._id, action, detail, at: Date.now() } })
}

// 老闆綁定備用路：開發者在 settings/owner.presetPhone 登記手機號，該號碼的用戶授權後自動成為老闆
async function applyOwnerPreset(user) {
  if (!user.phone || user.role === 'owner') return user
  let setting
  try {
    setting = (await db.collection('settings').doc('owner').get()).data
  } catch (e) {
    return user
  }
  if (!setting || !setting.presetPhone || setting.presetPhone !== user.phone) return user

  // 系統只有一位老闆：舊老闆身份自動移除；登記的手機號用一次即清空
  if (setting.ownerId && setting.ownerId !== user._id) {
    await users.doc(setting.ownerId).update({ data: { role: 'customer' } })
  }
  await users.doc(user._id).update({ data: { role: 'owner' } })
  await db.collection('settings').doc('owner').update({ data: { ownerId: user._id, presetPhone: '', usedAt: Date.now() } })
  await audit(user, 'owner_bound_by_phone', { phone: user.phone })
  return { ...user, role: 'owner' }
}

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return fail('请在小程序内使用', 'NO_OPENID')

  try {
    // 登入只查詢、不建立用戶：客人同意協議（agreePrivacy）之後才建立含 OpenID 的用戶資料
    if (event.action === 'login') {
      const found = await users.where({ openid: OPENID }).limit(1).get()
      const u = found.data[0]
      return ok({ serverNow: Date.now(), user: u ? publicUser(u) : { _id: '', role: 'customer', nickname: '', avatar: '', phone: '', agreedPrivacyAt: null, agreedPrivacyVersion: '' } })
    }

    const user = await getOrCreate(OPENID)

    switch (event.action) {
      case 'agreePrivacy':
        await users.doc(user._id).update({ data: { agreedPrivacyAt: Date.now(), agreedPrivacyVersion: String(event.version || '').slice(0, 20) } })
        return ok(true)

      case 'bindPhone': {
        if (!event.code) return fail('授权失败，请重试')
        const res = await cloud.openapi.phonenumber.getPhoneNumber({ code: event.code })
        const phone = res && res.phoneInfo && res.phoneInfo.purePhoneNumber
        if (!phone) return fail('获取手机号失败，请重试')
        await users.doc(user._id).update({ data: { phone, phoneBoundAt: Date.now() } })
        const updated = await applyOwnerPreset({ ...user, phone })
        return ok(publicUser(updated))
      }

      case 'updateProfile': {
        const data = {}
        if (typeof event.nickname === 'string') data.nickname = event.nickname.trim().slice(0, 20)
        if (typeof event.avatar === 'string' && event.avatar.startsWith('cloud://')) data.avatar = event.avatar
        if (!Object.keys(data).length) return fail('没有可更新的内容')
        await users.doc(user._id).update({ data })
        return ok(publicUser({ ...user, ...data }))
      }

      // 註銷帳號（規格書「我的 · 其他入口」、澄清 C6）：訂單和金額記錄保留，個人資料刪除
      case 'deleteAccount': {
        const _ = db.command
        const now = Date.now()
        const pending = await db.collection('orders').where({ userId: user._id, status: 'pending' }).count()
        const courts = await db.collection('order_items').where({ userId: user._id, kind: 'court', status: 'active', startAt: _.gt(now) }).count()
        const coupons = await db.collection('order_items').where({ userId: user._id, kind: 'product', codeActive: true }).count()
        if (pending.total || courts.total || coupons.total) return fail('你还有未使用的场地或券，请先使用或退款后再注销', 'HAS_ACTIVE')
        if (user.role !== 'customer') return fail('老板和员工请先由老板移除身份后再注销')
        await db.collection('orders').where({ userId: user._id }).update({ data: { phone: '', deletedUser: true } })
        await db.collection('verify_logs').where({ userId: user._id }).update({ data: { phone: '' } })
        // 舊核銷記錄可能沒有 userId：按訂單號再清一次
        for (let skip = 0; ; skip += 100) {
          const os = await db.collection('orders').where({ userId: user._id }).skip(skip).limit(100).get()
          if (!os.data.length) break
          await db.collection('verify_logs').where({ orderId: _.in(os.data.map(o => o._id)) }).update({ data: { phone: '' } })
          if (os.data.length < 100) break
        }
        await users.doc(user._id).update({
          data: { openid: `deleted_${user._id}`, phone: '', nickname: '', avatar: '', deletedAt: now }
        })
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
