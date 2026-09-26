// 右滑返回手势（与 iOS 原生手势一致，开发者工具/安卓也可用）
//
// 用法：
//   const swipeBack = require('../../utils/swipe-back')
//   Page({ ...swipeBack, data: {...}, ... })
// 并在页面根节点加：
//   bindtouchstart="onSwipeBackStart" bindtouchend="onSwipeBackEnd"
//
// 关键设计：只在屏幕左缘起手时识别为返回，避免与页面内横向滚动区域
// （如穿搭页的分类条、横向滑动卡片）抢手势——iOS 原生返回也只认左缘。
//
// 注意：若页面本身需要监听 touch 事件，请改用别的事件名，避免与本模块冲突。
const EDGE = 40 // 左缘宽度（px），起手 x < EDGE 才算返回手势

module.exports = {
  onSwipeBackStart(e) {
    const t = e.touches[0]
    if (t.clientX >= EDGE) {
      // 非左缘起手：可能是横向滚动，直接放弃本次手势
      this._swipeBackStart = null
      return
    }
    this._swipeBackStart = { x: t.clientX, y: t.clientY }
  },

  onSwipeBackEnd(e) {
    if (!this._swipeBackStart) return
    const t = e.changedTouches[0]
    const dx = t.clientX - this._swipeBackStart.x
    const dy = t.clientY - this._swipeBackStart.y
    this._swipeBackStart = null
    // 手指向右滑：横向位移足够且纵向偏移不大
    if (dx > 80 && Math.abs(dy) < 60) {
      wx.navigateBack()
    }
  }
}
