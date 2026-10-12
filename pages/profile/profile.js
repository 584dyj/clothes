const auth = require('../../utils/auth')
const db = require('../../utils/db')
const streak = require('../../utils/streak')

const WEATHER_TEMPLATE_ID = 'gecbz6HZQxVtg7x5eMAY7ugCWXgeIQsuWK9ELJR4Xe0'

Page({
  async onRetry() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.loadData(true)
  },

  data: {
    loadError: '',
    loading: true,
    avatarSaving: false,
    loggingOut: false,
    pendingCleanup: false,
    cleaning: false,
    username: '',
    avatarText: '我',
    avatarFileID: '',
    registerCode: '',
    mostExpensive: null,
    favoriteBrand: null,
    cityName: '',
    weatherStateText: '点击订阅明日穿搭提醒',
    subscribingWeather: false,
    hasWearRecords: false,
    streakDays: 0,
    monthCheckins: 0
  },

  async onShow() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.refreshWeatherState()
    this.loadData()
  },

  async onPullDownRefresh() {
    try { await this.onRetry() } finally { wx.stopPullDownRefresh() }
  },

  async loadData(force = false) {
    this.refreshCleanupStatus()
    this.setData({ loadError: '' })
    if (this._loading) return
    this._loading = true
    if (!this._loaded) this.setData({ loading: true })
    try {
      const [profile, items, wearRecords] = await Promise.all([auth.profile(), db.listItems(force), db.listWearRecords(force)])
      const mostExpensive = this.findMostExpensive(items)
      const favoriteBrand = this.findFavoriteBrand(items)
      const username = profile.username || ''
      const now = new Date()
      const pad = n => String(n).padStart(2, '0')
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      this._loaded = true
      this.setData({
        loading: false,
        username,
        avatarText: Array.from(username)[0] || '我',
        avatarFileID: profile.avatarFileID || '',
        registerCode: profile.registerCode || '未记录',
        cityName: profile.cityName || '',
        mostExpensive,
        favoriteBrand,
        hasWearRecords: wearRecords.length > 0,
        streakDays: streak.streakDays(wearRecords, today),
        monthCheckins: streak.monthDays(wearRecords, today)
      })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '加载失败，请重试' })
      wx.showToast({ title: e.message || '资料加载失败', icon: 'none' })
    } finally {
      this._loading = false
    }
  },

  findMostExpensive(items) {
    if (!items.length) return null
    const item = items.reduce((highest, current) => {
      return (Number(current.price) || 0) > (Number(highest.price) || 0) ? current : highest
    })
    return {
      name: item.name || '未命名衣物',
      price: Math.round((Number(item.price) || 0) * 100) / 100,
      imageFileID: item.imageFileID || ''
    }
  },

  findFavoriteBrand(items) {
    const counts = Object.create(null)
    items.forEach(item => {
      const brand = (item.brand || '').trim()
      if (brand) counts[brand] = (counts[brand] || 0) + 1
    })
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    if (!names.length) return null
    const name = names[0]
    // logo 徽章：取品牌名首字符（中文品牌取首个汉字，英文取首字母大写）
    const initial = Array.from(name)[0].toUpperCase()
    return { name, count: counts[name], initial }
  },

  async onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl
    if (!tempPath || this.data.avatarSaving) return
    this.setData({ avatarSaving: true })
    wx.showLoading({ title: '保存头像…', mask: true })
    let newFileID = ''
    let committed = false
    try {
      newFileID = await db.uploadImage(tempPath, 'avatars')
      await auth.updateProfile({ avatarFileID: newFileID })
      committed = true
      const oldFileID = this.data.avatarFileID
      this.setData({ avatarFileID: newFileID })
      const cleaned = oldFileID ? await db.removeImage(oldFileID) : true
      wx.hideLoading()
      wx.showToast({ title: cleaned ? '头像已更新' : '头像已更新，清理待重试', icon: 'none' })
    } catch (err) {
      console.error(err)
      if (newFileID && !committed) db.removeImage(newFileID)
      wx.hideLoading()
      wx.showToast({ title: err.message || '头像保存失败', icon: 'none' })
    } finally {
      this.setData({ avatarSaving: false })
      this.refreshCleanupStatus()
    }
  },

  async refreshCleanupStatus() {
    try {
      const result = await db.cleanupStatus()
      this.setData({ pendingCleanup: result.pendingCleanup === true })
    } catch (e) {
      console.error('读取清理状态失败', e)
    }
  },

  // 天气提醒授权状态：勾选「总是保持以上选择」后 itemSettings 为 accept，后续点击无弹窗
  refreshWeatherState() {
    if (typeof wx.getSetting !== 'function') return
    wx.getSetting({
      withSubscriptions: true,
      success: res => {
        const setting = res.subscriptionsSetting || {}
        const state = (setting.itemSettings || {})[WEATHER_TEMPLATE_ID]
        const text = setting.mainSwitch === false ? '订阅消息总开关已关闭，请在设置中开启'
          : state === 'accept' ? '已开启免询问，点击增加一次提醒额度'
          : state === 'reject' ? '已拒绝提醒，点击重新订阅'
          : '点击订阅明日穿搭提醒'
        this.setData({ weatherStateText: text })
      },
      fail: () => {}
    })
  },

  onCityTap() {
    wx.showModal({
      title: '设置城市',
      editable: true,
      placeholderText: '输入城市名，如：上海',
      content: this.data.cityName,
      success: async res => {
        if (!res.confirm) return
        const name = String(res.content || '').trim()
        if (!name) return
        try {
          const result = await db.setCity(name)
          this.setData({ cityName: result.cityName || name })
          wx.showToast({ title: `已设置为 ${result.cityName || name}`, icon: 'none' })
        } catch (e) {
          console.error(e)
          wx.showToast({ title: e.message || '城市设置失败，请重试', icon: 'none' })
        }
      }
    })
  },

  async onSubscribeWeather() {
    if (this.data.subscribingWeather) return
    this.setData({ subscribingWeather: true })
    try {
      const result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds: [WEATHER_TEMPLATE_ID], success: resolve, fail: reject
      }))
      const state = result[WEATHER_TEMPLATE_ID]
      if (state !== 'accept') {
        wx.showToast({ title: state === 'ban' ? '请在设置中开启订阅消息' : '已取消订阅', icon: 'none' })
        return
      }
      const subscribed = await db.subscribeWeather()
      wx.showToast({ title: `已增加一次提醒额度，剩余可订 ${subscribed.remaining} 次`, icon: 'none' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e && e.message || '订阅失败，请重试', icon: 'none' })
    } finally {
      this.setData({ subscribingWeather: false })
      this.refreshWeatherState()
    }
  },

  async onRetryCleanup() {
    if (this.data.cleaning) return
    this.setData({ cleaning: true })
    try {
      const result = await db.retryCleanup()
      this.setData({ pendingCleanup: result.pendingCleanup === true })
      wx.showToast({ title: result.pendingCleanup ? '仍有清理未完成，请稍后重试' : '无需继续重试', icon: 'none' })
    } catch (e) {
      wx.showToast({ title: '清理失败，请稍后重试', icon: 'none' })
    } finally { this.setData({ cleaning: false }) }
  },

  onLogout() {
    if (this.data.loggingOut) return
    wx.showModal({
      title: '退出登录',
      content: '退出后可使用账号和密码重新登录。',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm) return
        this.setData({ loggingOut: true })
        wx.showLoading({ title: '正在退出…', mask: true })
        try {
          await auth.logout()
          wx.hideLoading()
          wx.reLaunch({ url: '/pages/login/login' })
        } catch (e) {
          console.error(e)
          wx.hideLoading()
          this.setData({ loggingOut: false })
          wx.showToast({ title: e.message || '退出失败', icon: 'none' })
        }
      }
    })
  }
})
