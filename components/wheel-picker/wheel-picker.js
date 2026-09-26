// 自定义滚轮选择器：底部弹出，字体大小可调（.wp-item 的 font-size）
//
// 属性：
//   show    是否显示
//   title   标题
//   columns 各列选项，单列传 [options]，多列（如日期）传 [years, months, days]
//   values  各列选中下标，如 [0] 或 [yearIdx, monthIdx, dayIdx]
// 事件：
//   bind:confirm       确定，e.detail.values 为各列下标
//   bind:cancel        取消 / 点遮罩
//   bind:columnchange  滚动某列后触发，e.detail.values 为当前各列下标（用于联动更新列）
Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    columns: { type: Array, value: [] },
    values: { type: Array, value: [] }
  },

  data: {
    innerValues: []
  },

  observers: {
    show(show) {
      if (show) this.setData({ innerValues: this.data.values.slice() })
    },
    values(values) {
      // 页面联动更新列（如日期天数变化）时同步选中位置
      if (this.data.show) this.setData({ innerValues: values.slice() })
    }
  },

  methods: {
    onChange(e) {
      const values = e.detail.value
      this.setData({ innerValues: values })
      this.triggerEvent('columnchange', { values })
    },

    onConfirm() {
      this.triggerEvent('confirm', { values: this.data.innerValues })
    },

    onCancel() {
      this.triggerEvent('cancel')
    }
  }
})
