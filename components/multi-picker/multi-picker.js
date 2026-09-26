// 多选筛选面板：底部弹层，选项以 chip 平铺，点选切换，确定生效
//
// 属性：
//   show     是否显示
//   title    标题
//   options  全部可选项（字符串数组）
//   selected 当前已选项（字符串数组）
// 事件：
//   bind:confirm  确定，e.detail.selected 为已选数组
//   bind:cancel   取消 / 点遮罩
Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    options: { type: Array, value: [] },
    selected: { type: Array, value: [] }
  },

  data: {
    inner: [],   // 弹层内的已选项
    list: []     // [{value, active}]，WXML 不支持方法调用，选中态预计算
  },

  observers: {
    show(show) {
      if (show) this.rebuild(this.data.selected)
    }
  },

  methods: {
    rebuild(selected) {
      this.setData({
        inner: selected.slice(),
        list: this.data.options.map(v => ({ value: v, active: selected.indexOf(v) >= 0 }))
      })
    },

    onToggle(e) {
      const value = e.currentTarget.dataset.value
      const inner = this.data.inner.slice()
      const i = inner.indexOf(value)
      if (i >= 0) {
        inner.splice(i, 1)
      } else {
        inner.push(value)
      }
      this.rebuild(inner)
    },

    onConfirm() {
      this.triggerEvent('confirm', { selected: this.data.inner })
    },

    onCancel() {
      this.triggerEvent('cancel')
    }
  }
})
