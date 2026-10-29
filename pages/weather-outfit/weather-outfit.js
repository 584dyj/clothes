const db = require('../../utils/db')
const auth = require('../../utils/auth')
const { today } = require('../../utils/date')

// 复用天气落地页展示站内明日推荐，推送历史仍按原日期读取。
Page({
  data: {
    date: '',
    weatherText: '',
    advice: '',
    reason: '',
    missingText: '',
    items: [],       // [{ _id, name, category, subcategory, imageFileID, available, selected }]
    count: 0,
    selectedCount: 0,
    loading: true,
    loadError: '',
    ready: false,
    saving: false,
    saved: false,        // 已保存标记（含是否同时设为明天穿着）
    savedAsPlan: false,
    saveError: '',
    canPlan: false,
    daily: false,
    revision: 0,
    cityName: '',
    adjusting: false,
    adjustMessage: '',
    adjustError: false
  },

  async onLoad(options) {
    this._options = options
    const date = typeof options.date === 'string' ? options.date : ''
    this.setData({ date, daily: options.daily === '1' })
    if (!this.data.daily && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      this.setData({ loading: false, loadError: '未找到推荐内容' })
      return
    }
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.onRetry()
  },

  async onRetry() {
    if (this._loading || this.data.saving || this.data.adjusting) return
    this._loading = true
    this.setData({ loading: true, loadError: '', ready: false })
    try {
      const result = this.data.daily ? await db.dailyRecommendation() : null
      const recommendation = result ? result.recommendation : await db.getWeatherRecommendation(this.data.date)
      if (!recommendation) {
        this.setData({ loading: false, loadError: '未找到推荐内容，可能是推荐已过期' })
        return
      }
      const availableIds = this.data.daily ? null : new Set((await db.listItems()).map(item => item._id))
      this.applyRecommendation(recommendation, availableIds)
      this.setData({ loading: false, ready: true, adjustError: false, adjustMessage: '' })
      if (result?.message) wx.showToast({ title: result.message, icon: 'none', duration: 2500 })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: this.data.daily ? (e.message || '推荐内容加载失败，请重试') : '推荐内容加载失败，请重试' })
    } finally {
      this._loading = false
    }
  },

  applyRecommendation(recommendation, availableIds = null, preserveSelection = false) {
    const changed = this.data.daily && (recommendation.date !== this.data.date || recommendation.revision !== this.data.revision)
    const previous = new Map(this.data.items.map(item => [item._id, item.selected]))
    const items = (recommendation.items || []).map(item => {
      const available = !availableIds || availableIds.has(item._id)
      return { ...item, available, selected: available && (!preserveSelection || previous.get(item._id) !== false) }
    })
    const weather = recommendation.weather || {}
    this.setData({ date: recommendation.date || this.data.date, revision: recommendation.revision || 0,
      cityName: recommendation.cityName || '',
      weatherText: weather.textDay ? `${weather.textDay} ${weather.tempMin}~${weather.tempMax}℃` : '',
      advice: recommendation.advice || '', reason: recommendation.reason || '',
      missingText: (recommendation.missing || []).join('、'), items, count: items.length,
      selectedCount: items.filter(item => item.selected).length })
    this.setData({ canPlan: this.data.date > today(), saveError: '' })
    if (changed) this.setData({ saved: false, savedAsPlan: false })
  },

  async adjust(operation, replaceId) {
    if (!this.data.daily || !this.data.ready || this.data.loading || this.data.adjusting || this.data.saving || this.data.saved || this.data.adjustError) return
    this.setData({ adjusting: true, adjustMessage: '', adjustError: false })
    try {
      const category = this.data.items.find(item => item._id === replaceId)?.category || '衣物'
      const result = await db.dailyRecommendation({ operation, replaceId, date: this.data.date, revision: this.data.revision })
      this.applyRecommendation(result.recommendation, null, operation === 'replace' || result.recommendation.revision === this.data.revision)
      wx.showToast({ title: result.message || (operation === 'replace' ? `已替换${category}` : '已换一套搭配'), icon: 'none', duration: 2500 })
    } catch (e) {
      this.setData({ adjustError: true, adjustMessage: e.message || '调整失败，请重试' })
    } finally {
      this.setData({ adjusting: false })
    }
  },

  onChangeTap() { return this.adjust('change') },
  onReplaceTap(e) { return this.adjust('replace', e.currentTarget.dataset.id) },

  onCityTap() {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  async onPullDownRefresh() {
    try { await this.onRetry() } finally { wx.stopPullDownRefresh() }
  },

  // 保存用衣物 ID：取「可保存且已勾选」的，避免把已删除或用户取消的衣物写入。
  selectedIds() {
    return this.data.items.filter(item => item.available && item.selected).map(item => item._id)
  },

  onPreviewImage(e) {
    const item = this.data.items.find(item => item._id === e.currentTarget.dataset.id)
    if (item?.imageFileID) wx.previewImage({ urls: [item.imageFileID] })
  },

  // 点击衣物卡片切换勾选（已删除的不可选）。
  onItemTap(e) {
    if (this.data.loading || this.data.adjusting || this.data.saving || this.data.saved) return
    const id = e.currentTarget.dataset.id
    const items = this.data.items.map(item => {
      if (item._id !== id || !item.available) return item
      return { ...item, selected: !item.selected }
    })
    this.setData({ items, selectedCount: items.filter(item => item.selected).length })
  },

  outfitName() {
    const match = this.data.date.match(/^\d{4}-(\d{2})-(\d{2})$/)
    return match ? `${Number(match[1])}月${Number(match[2])}日穿搭` : '天气推荐穿搭'
  },

  async save(alsoPlan) {
    const { saving, ready, saved } = this.data
    if (saving || !ready || saved || this.data.adjusting || this.data.adjustError) return
    if (alsoPlan && this.data.date <= today()) {
      wx.showToast({ title: '推荐日期已到，请从今日计划确认实穿', icon: 'none' })
      return
    }
    const itemIds = this.selectedIds()
    if (!itemIds.length) {
      wx.showToast({ title: '请先勾选要保存的衣物', icon: 'none' })
      return
    }
    // 同一日期、推荐版本与勾选集合复用请求，刷新或响应丢失后仍可恢复。
    const requestId = JSON.stringify(['weather-outfit', this.data.date, this.data.daily ? this.data.revision : 'message', itemIds.slice().sort()])
    this.setData({ saving: true, saveError: '' })
    wx.showLoading({ title: '保存中…' })
    try {
      const outfitId = await db.addOutfit({ name: this.outfitName(), occasion: '', note: '', itemIds, imageFileID: '' }, requestId)
      if (alsoPlan) await db.addPlan({ date: this.data.date, outfitId, note: '' }, requestId)
      wx.hideLoading()
      this.setData({ saving: false, saved: true, savedAsPlan: alsoPlan })
      wx.showToast({ title: alsoPlan ? '已保存穿搭计划' : '已保存为一套穿搭', icon: 'none' })
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      this.setData({ saving: false, saveError: /已保存的记录已|保存内容已变化/.test(e.message || '')
        ? e.message : '保存未完成，请重试；同一选择不会重复创建穿搭或计划' })
      wx.showToast({ title: '保存未完成，请重试', icon: 'none' })
    }
  },

  onSaveOutfit() { return this.save(false) },
  onSaveAndPlan() { return this.save(true) }
})
