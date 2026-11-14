// 24 小時制時間選擇（全局規則 G10，澄清 L5）：兩列滾輪「時 00–23、分 00–59」，
// 不用微信自帶的 picker mode="time"（它跟著手機 12/24 小時設置，會出現上午、下午）。
// 用法：<time-picker value="{{t}}" data-field="startTime" bindchange="input">顯示內容</time-picker>
// change 事件的 e.detail.value 是 'HH:MM'，和原來的時間選擇器一樣
const pad = n => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i))
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i))

function toIndex(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || '')
  if (!m) return [0, 0]
  return [Math.min(23, +m[1]), Math.min(59, +m[2])]
}

Component({
  properties: {
    value: { type: String, value: '' },
    disabled: { type: Boolean, value: false }
  },

  data: { range: [HOURS, MINUTES], index: [0, 0] },

  observers: {
    value(v) {
      this.setData({ index: toIndex(v) })
    }
  },

  methods: {
    onChange(e) {
      const [h, m] = e.detail.value
      this.triggerEvent('change', { value: `${HOURS[h]}:${MINUTES[m]}` })
    }
  }
})
