// 初始化數據庫：建立所有集合和設定文檔。只需在雲開發控制台「雲端測試」執行一次，可重複執行不會出錯
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COLLECTIONS = [
  'users', 'slot_locks', 'orders', 'order_items', 'products', 'prices',
  'business_hours', 'banners', 'refunds', 'audit_logs', 'invites', 'settings',
  'verify_logs', 'notices'
]

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID) return { ok: false, message: '请在云开发控制台执行' }

  const created = []
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name)
      created.push(name)
    } catch (e) {
      // 已存在則略過
    }
  }

  // 老闆手機號備用路：把唐先生的手機號填在 presetPhone（在控制台直接改這條記錄）
  try {
    await db.collection('settings').add({ data: { _id: 'owner', presetPhone: '', ownerId: '' } })
  } catch (e) {
    // 已存在則略過
  }

  return { ok: true, created }
}
