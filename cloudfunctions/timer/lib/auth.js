// 身份：權限一律在雲函數判斷，不相信手機傳來的身份（技術方案「關鍵機制 6」）
async function getCaller(db, openid) {
  if (!openid) return null
  const res = await db.collection('users').where({ openid }).limit(1).get()
  return res.data[0] || null
}

function isAdmin(user) {
  return !!user && (user.role === 'owner' || user.role === 'staff')
}

function isOwner(user) {
  return !!user && user.role === 'owner'
}

function displayName(user) {
  if (!user) return ''
  return user.remark || user.nickname || (user.role === 'owner' ? '老板' : user.role === 'host' ? '组局员' : '员工')
}

module.exports = { getCaller, isAdmin, isOwner, displayName }
