const auth = require('../../utils/auth')
const db = require('../../utils/db')
const streak = require('../../utils/streak')

const WEATHER_TEMPLATE_ID = 'gecbz6HZQxVtg7x5eMAY7ugCWXgeIQsuWK9ELJR4Xe0'
const REPORT_TEMPLATE_ID = 'CeSjEXCpR71PZvGbIoqCDgO0H0CSHSwGbo_7o7ZgLIE'

Page({
  async onRetry() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.refreshWeatherState()
    return Promise.all([this.loadData(true), this.loadSubscriptionStatus()])
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
    locating: false,
    weatherStateText: '',
    weatherUnused: null,
    weatherQuotaLoading: true,
    weatherQuotaError: false,
    subscribingWeather: false,
    cancelingWeather: false,
    reportUnused: null,
    reportQuotaLoading: true,
    reportQuotaError: false,
    subscribingReport: false,
    cancelingReport: false,
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
    return Promise.all([this.loadData(), this.loadSubscriptionStatus()])
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

  async loadSubscriptionStatus() {
    const versions = {
      weather: this._weatherQuotaVersion = (this._weatherQuotaVersion || 0) + 1,
      report: this._reportQuotaVersion = (this._reportQuotaVersion || 0) + 1
    }
    this.setData({ weatherUnused: null, weatherQuotaLoading: true, weatherQuotaError: false,
      reportUnused: null, reportQuotaLoading: true, reportQuotaError: false })
    let result
    try {
      result = await db.getSubscriptionStatus()
    } catch (e) {
      console.error('读取提醒次数失败', e)
    }
    for (const scene of ['weather', 'report']) {
      if (versions[scene] !== this[`_${scene}QuotaVersion`]) continue
      const unused = result && result[`${scene}Unused`]
      const valid = Number.isInteger(unused) && unused >= 0
      this.setData({ [`${scene}Unused`]: valid ? unused : null,
        [`${scene}QuotaLoading`]: false, [`${scene}QuotaError`]: !valid })
    }
  },

  // 微信设置仅用于关闭或拒绝提示，剩余次数由服务端单独读取。
  refreshWeatherState() {
    if (typeof wx.getSetting !== 'function') return
    wx.getSetting({
      withSubscriptions: true,
      success: res => {
        const setting = res.subscriptionsSetting || {}
        const state = (setting.itemSettings || {})[WEATHER_TEMPLATE_ID]
        const text = setting.mainSwitch === false ? '订阅消息总开关已关闭，请在设置中开启'
          : state === 'reject' ? '你已拒绝订阅，可重新授权'
          : ''
        this.setData({ weatherStateText: text })
      },
      fail: () => {}
    })
  },

  onCityTap() {
    if (this.data.locating) return
    wx.showActionSheet({
      itemList: ['自动定位', '手动输入', '地图选点'],
      success: res => {
        if (res.tapIndex === 0) this.locateCity()
        else if (res.tapIndex === 1) this.inputCity()
        else if (res.tapIndex === 2) this.pickCityOnMap()
      }
    })
  },

  inputCity() {
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

  // 模糊定位（区县级精度，无需后台审核）→ 云端逆地理编码 → 弹窗确认
  async locateCity() {
    if (this.data.locating) return
    if (typeof wx.getFuzzyLocation !== 'function') {
      wx.showToast({ title: '当前微信版本不支持定位，请手动输入', icon: 'none' })
      return
    }
    this.setData({ locating: true })
    wx.showLoading({ title: '定位中…', mask: true })
    try {
      const location = await new Promise((resolve, reject) =>
        wx.getFuzzyLocation({ type: 'wgs84', success: resolve, fail: reject }))
      await this.applyLocation(location.longitude, location.latitude)
    } catch (e) {
      wx.hideLoading()
      console.error(e)
      const raw = String(e && (e.errMsg || e.message) || '')
      // errno 112：隐私指引中的位置声明未生效（如审核中），此期间地图选点同样被拦，只引导手动输入
      const undeclared = e && e.errno === 112 || /privacy agreement|privacy permission/i.test(raw)
      const denied = /auth deny|authorize no response/i.test(raw)
      wx.showModal({
        title: '定位失败',
        content: undeclared
          ? '定位能力尚未开放（隐私指引审核中），请改用手动输入城市'
          : denied
            ? '定位授权被拒绝，可改用手动输入或地图选点；如需定位，请在微信设置中开启位置权限'
            : raw || '请改用手动输入或地图选点',
        showCancel: false
      })
    } finally {
      this.setData({ locating: false })
    }
  },

  // 地图选点：用户自选精确位置，同样走逆地理编码落到区县
  async pickCityOnMap() {
    if (this.data.locating || typeof wx.chooseLocation !== 'function') return
    this.setData({ locating: true })
    try {
      const place = await new Promise((resolve, reject) => wx.chooseLocation({ success: resolve, fail: reject }))
      wx.showLoading({ title: '解析中…', mask: true })
      await this.applyLocation(place.longitude, place.latitude)
    } catch (e) {
      wx.hideLoading()
      if (e && /cancel/i.test(String(e.errMsg || ''))) return
      console.error(e)
      const raw = String(e && (e.errMsg || e.message) || '')
      // errno 112：位置声明未生效时与定位口径一致
      const undeclared = e && e.errno === 112 || /privacy agreement|privacy permission/i.test(raw)
      wx.showToast({ title: undeclared ? '选点暂不可用，请手动输入城市' : raw || '选点失败，请重试', icon: 'none' })
    } finally {
      this.setData({ locating: false })
    }
  },

  // 经纬度 → 云函数解析为区县并落库，成功后弹确认，可返回重新选择
  async applyLocation(longitude, latitude) {
    try {
      const result = await db.setCityByLocation(longitude, latitude)
      const name = result.cityName || ''
      this.setData({ cityName: name })
      wx.hideLoading()
      wx.showModal({
        title: '已定位到',
        content: name,
        confirmText: '确认',
        cancelText: '修改',
        success: res => { if (!res.confirm) this.onCityTap() }
      })
    } catch (e) {
      wx.hideLoading()
      throw e
    }
  },

  async onSubscribeWeather() {
    if (this.data.subscribingWeather || this.data.cancelingWeather) return
    if (this.data.weatherUnused >= 12) {
      wx.showToast({ title: '提醒次数已充足，消耗后可再增加', icon: 'none' })
      return
    }
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
      const reminders = Number.isInteger(subscribed.unused) ? subscribed.unused : 12 - subscribed.remaining
      this._weatherQuotaVersion = (this._weatherQuotaVersion || 0) + 1
      this.setData({ weatherUnused: reminders, weatherQuotaLoading: false, weatherQuotaError: false })
      wx.showToast({ title: `已增加1次，剩余 ${reminders} 次`, icon: 'none' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e && e.message || '订阅失败，请重试', icon: 'none' })
    } finally {
      this.setData({ subscribingWeather: false })
      this.refreshWeatherState()
    }
  },

  async onSubscribeReport() {
    if (this.data.subscribingReport || this.data.cancelingReport) return
    if (this.data.reportUnused >= 12) {
      wx.showToast({ title: '提醒次数已充足，消耗后可再增加', icon: 'none' })
      return
    }
    this.setData({ subscribingReport: true })
    try {
      const result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds: [REPORT_TEMPLATE_ID], success: resolve, fail: reject
      }))
      const state = result[REPORT_TEMPLATE_ID]
      if (state !== 'accept') {
        wx.showToast({ title: state === 'ban' ? '请在设置中开启订阅消息' : '已取消订阅', icon: 'none' })
        return
      }
      const { unused } = await db.subscribeReport()
      this._reportQuotaVersion = (this._reportQuotaVersion || 0) + 1
      this.setData({ reportUnused: unused, reportQuotaLoading: false, reportQuotaError: false })
      wx.showToast({ title: `已增加1次，剩余 ${unused} 次`, icon: 'none' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e && e.message || '订阅失败，请重试', icon: 'none' })
    } finally {
      this.setData({ subscribingReport: false })
    }
  },

  async onCancelReminder(e) {
    const scene = e.currentTarget.dataset.scene
    if (!['weather', 'report'].includes(scene)) return
    const kind = scene === 'weather' ? 'Weather' : 'Report'
    if (this.data[`subscribing${kind}`] || this.data[`canceling${kind}`] ||
      this.data[`${scene}QuotaLoading`] || this.data[`${scene}QuotaError`] || !(this.data[`${scene}Unused`] > 0)) return
    this.setData({ [`canceling${kind}`]: true })
    try {
      await db[`cancel${kind}`]()
      this[`_${scene}QuotaVersion`] = (this[`_${scene}QuotaVersion`] || 0) + 1
      this.setData({ [`${scene}Unused`]: 0, [`${scene}QuotaLoading`]: false, [`${scene}QuotaError`]: false })
      wx.showToast({ title: '已取消提醒，剩余 0 次', icon: 'none' })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e && e.message || '取消失败，请重试', icon: 'none' })
    } finally {
      this.setData({ [`canceling${kind}`]: false })
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
