const auth = require('../../utils/auth')
const focusPlaceholder = require('../../utils/focus-placeholder')

Page({
  ...focusPlaceholder,

  data: {
    mode: 'login', // login | register
    fading: false, // 切换时表单淡出中
    username: '',
    password: '',
    confirm: '',
    registerCode: '',
    submitting: false
  },

  onReady() {
    // 首屏渲染完成（路由就绪）后再校验登录并跳转。
    // 若放在 onLoad，冷启动时 reLaunch 可能早于 routeDone，导致
    // "routeDone with a webviewId is not found" 路由错误
    this.checkLogin()
  },

  // 已绑定微信则自动进入系统（快速登录）
  async checkLogin() {
    const r = await auth.check()
    if (r.unavailable) {
      wx.showToast({ title: '登录状态校验失败', icon: 'none' })
      return
    }
    if (r.loggedIn) {
      wx.reLaunch({ url: '/pages/wardrobe/wardrobe' })
    }
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode || this._switching) return
    // 先淡出当前表单，再切换 mode，新表单渲染时播放淡入动画
    this._switching = true
    this.setData({ fading: true })
    setTimeout(() => {
      this.setData({ mode, fading: false })
      this._switching = false
    }, 200)
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  async onSubmit() {
    const { mode, username, password, confirm, registerCode, submitting } = this.data
    const cleanUsername = username.trim()
    const cleanRegisterCode = registerCode.trim()
    if (submitting) return

    if (!cleanUsername || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    if (mode === 'register') {
      if (!cleanRegisterCode) {
        wx.showToast({ title: '请输入注册码', icon: 'none' })
        return
      }
      if (password.length < 6) {
        wx.showToast({ title: '密码至少 6 位', icon: 'none' })
        return
      }
      if (password !== confirm) {
        wx.showToast({ title: '两次输入的密码不一致', icon: 'none' })
        return
      }
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '请稍候…', mask: true })
    try {
      if (mode === 'login') {
        await auth.login(cleanUsername, password)
      } else {
        await auth.register({ username: cleanUsername, password, registerCode: cleanRegisterCode })
      }
      wx.hideLoading()
      wx.showToast({ title: mode === 'login' ? '登录成功' : '注册成功', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/wardrobe/wardrobe' }), 800)
    } catch (err) {
      wx.hideLoading()
      console.error('登录/注册失败', err)
      wx.showToast({ title: err.message || '操作失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
