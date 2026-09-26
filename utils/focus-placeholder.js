// 输入框聚焦时隐藏 placeholder（小程序原生 placeholder 只在有内容时才消失）
//
// 用法：
//   const focusPlaceholder = require('../../utils/focus-placeholder')
//   Page({ ...focusPlaceholder, ... })
// 输入框 / textarea 上加：
//   data-field="name" bindfocus="onFieldFocus" bindblur="onFieldBlur"
//   placeholder="{{_focus.name ? '' : '请输入名称'}}"
module.exports = {
  onFieldFocus(e) {
    const field = e.currentTarget.dataset.field
    if (field) this.setData({ [`_focus.${field}`]: true })
  },

  onFieldBlur(e) {
    const field = e.currentTarget.dataset.field
    if (field) this.setData({ [`_focus.${field}`]: false })
  }
}
