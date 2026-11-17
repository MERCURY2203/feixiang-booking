// 發起球局／編輯說明（規格書「管理端 · 球局管理」，澄清 N3、N16）
// 發起：選日期 → 點格子（只能選還能訂的）→ 填內容 → 發布；有必填項沒填時一次列出全部並把欄位名標紅
// 編輯（帶 id）：只能改標題、封面、標籤、說明
const api = require('../../../utils/api')
const { pickImages } = require('../../../utils/image')
const { yuanToFen } = require('../../../utils/money')
const req = require('../../../utils/required')

Page({
  data: {
    id: '', days: [], date: '', courts: [], hours: [], cells: [], picked: 0, summary: '',
    title: '', cover: '', tags: '', desc: '', priceM: '', priceF: '', cap: '', capM: '', capF: '', minPlayers: '',
    err: {}, errText: ''
  },

  onLoad(options) {
    if (options.id) {
      wx.setNavigationBarTitle({ title: '编辑球局说明' })
      this.setData({ id: options.id })
      api
        .call('admin', 'gameGet', { id: options.id })
        .then(g => this.setData({ title: g.title, cover: g.cover, tags: (g.tags || []).join('、'), desc: g.desc }))
        .catch(err => api.toast(err.message))
      return
    }
    this.loadGrid()
  },

  loadGrid(date) {
    return api
      .call('admin', 'courtSchedule', { date: date || this.data.date })
      .then(r => {
        this.raw = r.cells
        this.sel = {}
        this.setData({
          days: r.days, date: r.date, courts: r.courts, hours: r.hours, picked: 0, summary: '',
          // 綠色可選；其餘（已訂、待支付、鎖場、球局、已過）一律灰叉不能選
          cells: r.cells.map(row => row.map(c => (c.s === 'free' ? { cls: 'free', text: '' } : { cls: c.s === 'past' ? 'past' : 'taken', text: '' })))
        })
      })
      .catch(err => api.toast(err.message))
  },

  pickDate(e) {
    const date = e.currentTarget.dataset.date
    if (date !== this.data.date) this.loadGrid(date)
  },

  onCellTap(e) {
    const { r, c } = e.detail
    const s = this.raw[r][c].s
    if (s === 'past') return
    if (s !== 'free') return api.toast('这个格子已被占用，不能选')
    const key = `${r}_${c}`
    if (this.sel[key]) delete this.sel[key]
    else this.sel[key] = true
    const picked = Object.keys(this.sel).length
    this.setData({
      [`cells[${r}][${c}]`]: this.sel[key] ? { cls: 'sel', text: '已选' } : { cls: 'free', text: '' },
      picked,
      summary: this.summaryText(),
      'err.cells': false
    })
  },

  selectedCells() {
    return Object.keys(this.sel || {}).map(k => {
      const [r, c] = k.split('_').map(Number)
      return { court: this.data.courts[c], hour: this.data.hours[r].hour }
    })
  },

  summaryText() {
    const cells = this.selectedCells()
    if (!cells.length) return ''
    const courts = [...new Set(cells.map(x => x.court))].sort((a, b) => a - b)
    const hours = cells.map(x => x.hour)
    const pad = n => String(n).padStart(2, '0')
    return `已选 ${cells.length} 格：${courts.map(x => `${x}号`).join('、')}场 ${pad(Math.min(...hours))}:00–${pad(Math.max(...hours) + 1)}:00`
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value, [`err.${field}`]: false })
  },

  addCover() {
    pickImages({ count: 1, scale: '4:3' }).then(paths => {
      if (!paths.length) return
      wx.showLoading({ title: '上传中', mask: true })
      wx.cloud
        .uploadFile({ cloudPath: `games/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`, filePath: paths[0] })
        .then(r => this.setData({ cover: r.fileID }))
        .catch(() => api.toast('上传失败，请重试'))
        .finally(() => wx.hideLoading())
    })
  },

  removeCover() {
    this.setData({ cover: '' })
  },

  // 有必填項沒填：一次列出全部、欄位名標紅，不提交（澄清 N16）
  check() {
    const miss = req.gameMissing(this.data, !!this.data.id)
    this.setData({ err: req.flags(miss), errText: miss.length ? `还有必填项没填：${miss.join('、')}。请填完再${this.data.id ? '保存' : '发布'}。` : '' })
    return !miss.length
  },

  submit() {
    if (this.saving || !this.check()) return
    const d = this.data
    this.saving = true
    const done = () => (this.saving = false)
    if (d.id) {
      api
        .call('admin', 'gameUpdate', { id: d.id, game: { title: d.title, cover: d.cover, tags: d.tags, desc: d.desc } })
        .then(() => {
          wx.showToast({ title: '已保存', icon: 'none' })
          setTimeout(() => wx.navigateBack(), 600)
        })
        .catch(err => api.toast(err.message))
        .then(done)
      return
    }
    wx.showLoading({ title: '发布中', mask: true })
    api
      .call('admin', 'gamePublish', {
        game: {
          date: d.date, cells: this.selectedCells(), title: d.title, cover: d.cover, tags: d.tags, desc: d.desc,
          priceM: yuanToFen(d.priceM), priceF: yuanToFen(d.priceF), cap: d.cap, capM: d.capM, capF: d.capF, minPlayers: d.minPlayers
        }
      })
      .then(r => {
        wx.hideLoading()
        wx.showToast({ title: '已发布', icon: 'none' })
        setTimeout(() => wx.redirectTo({ url: `/pages/admin/game-manage/index?id=${r._id}` }), 600)
      })
      .catch(err => {
        wx.hideLoading()
        if (err.code === 'MISSING') this.setData({ err: req.flags(err.missing || []), errText: err.message })
        else api.toast(err.message)
        // 格子剛被別人訂走：重新讀表格
        if (err.code === 'TAKEN') this.loadGrid()
      })
      .then(done)
  }
})
