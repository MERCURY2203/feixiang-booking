// 場地 × 時段表格：場地號一行凍結在頂部、時間一列凍結在左邊（規格書「訂場首頁」）
// cells[r][c] = { cls, text }；點格子觸發 celltap 事件 { r, c }
Component({
  properties: {
    courts: { type: Array, value: [] },
    hours: { type: Array, value: [] },
    cells: { type: Array, value: [] },
    height: { type: Number, value: 400 },
    // 表格底部多留的空白（rpx）；後台場地管理頁會調大，確保最後一行不貼著底部操作列
    tail: { type: Number, value: 40 }
  },
  methods: {
    onTap(e) {
      this.triggerEvent('celltap', { r: +e.currentTarget.dataset.r, c: +e.currentTarget.dataset.c })
    }
  }
})
