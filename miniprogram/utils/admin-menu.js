// 管理端側邊欄選單（規格書「頁面地圖」權限表）
module.exports = [
  { key: 'verify', title: '核销', url: '/pages/admin/home/index', roles: ['owner', 'staff'] },
  { key: 'orders', title: '订单管理', url: '/pages/admin/orders/index', roles: ['owner', 'staff'], badge: true },
  { key: 'courts', title: '场地管理', url: '/pages/admin/courts/index', roles: ['owner', 'staff'] },
  { key: 'products', title: '商品管理', url: '/pages/admin/products/index', roles: ['owner', 'staff'] },
  { key: 'banners', title: '横幅管理', url: '/pages/admin/banners/index', roles: ['owner', 'staff'] },
  { key: 'games', title: '球局管理', url: '/pages/admin/games/index', roles: ['owner', 'staff', 'host'] },
  { key: 'prices', title: '价格设置', url: '/pages/admin/prices/index', roles: ['owner'] },
  { key: 'hours', title: '营业时间', url: '/pages/admin/hours/index', roles: ['owner'] },
  { key: 'reports', title: '报表', url: '/pages/admin/reports/index', roles: ['owner'] },
  { key: 'staff', title: '员工管理', url: '/pages/admin/staff/index', roles: ['owner'] }
]
