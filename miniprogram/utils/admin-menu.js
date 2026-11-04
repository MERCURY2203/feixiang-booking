// 管理端側邊欄選單（規格書「頁面地圖」權限表）；url 為空表示尚未開發
module.exports = [
  { key: 'verify', title: '核销', url: '/pages/admin/home/index', roles: ['owner', 'staff'] },
  { key: 'orders', title: '订单管理', url: '', roles: ['owner', 'staff'], task: 'T16' },
  { key: 'courts', title: '场地管理', url: '', roles: ['owner', 'staff'], task: 'T17' },
  { key: 'products', title: '商品管理', url: '', roles: ['owner', 'staff'], task: 'T13' },
  { key: 'banners', title: '横幅管理', url: '', roles: ['owner', 'staff'], task: 'T19' },
  { key: 'prices', title: '价格与营业时间', url: '', roles: ['owner'], task: 'T18' },
  { key: 'reports', title: '报表', url: '', roles: ['owner'], task: 'T20' },
  { key: 'staff', title: '员工管理', url: '/pages/admin/staff/index', roles: ['owner'] }
]
