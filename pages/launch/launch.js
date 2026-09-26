const auth = require('../../utils/auth')

// 启动页：小程序第一个页面。校验登录态后跳转，避免先闪现衣物页再被弹到登录页。
Page({
  onLoad() {
    this.redirect()
  },

  async redirect() {
    try {
      const r = await auth.check()
      if (r.loggedIn) {
        wx.reLaunch({ url: '/pages/wardrobe/wardrobe' })
      } else {
        wx.reLaunch({ url: '/pages/login/login' })
      }
    } catch (e) {
      // 校验失败（如云环境异常）仍进登录页，由登录页再兜底
      wx.reLaunch({ url: '/pages/login/login' })
    }
  }
})
