const db = require('../../utils/db')
const auth = require('../../utils/auth')

// 天气推送落地页：展示每日推荐的具体衣物，可保存为一套穿搭，并可选设为明天穿着。
Page({
  data: {
    date: '',
    weatherText: '',
    advice: '',
    items: [],       // [{ _id, name, category, subcategory, imageFileID, available, selected }]
    count: 0,
    selectedCount: 0,
    loading: true,
    loadError: '',
    ready: false,
    saving: false,
    saved: false,        // 已保存标记（含是否同时设为明天穿着）
    savedAsPlan: false
  },

  async onLoad(options) {
    this._options = options
    const date = typeof options.date === 'string' ? options.date : ''
    this.setData({ date })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
    this.setData({ loading: true, loadError: '', ready: false })
    try {
      const recommendation = await db.getWeatherRecommendation(this.data.date)
      if (!recommendation) {
        this.setData({ loading: false, loadError: '未找到推荐内容，可能是推荐已过期' })
        return
      }
      // 用当前衣橱标注哪些推荐衣物已删除；可保存的默认全选，用户点击可取消/勾选。
      const availableIds = new Set((await db.listItems()).map(item => item._id))
      const items = (recommendation.items || []).map(item => {
        const available = availableIds.has(item._id)
        return { ...item, available, selected: available }
      })
      const weather = recommendation.weather || {}
      const weatherText = weather.textDay
        ? `明日 ${weather.textDay} ${weather.tempMin}~${weather.tempMax}℃`
        : ''
      this.setData({
        weatherText,
        advice: recommendation.advice || '',
        items,
        count: items.length,
        selectedCount: items.filter(item => item.selected).length,
        loading: false,
        ready: true
      })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '推荐内容加载失败，请重试' })
    }
  },

  // 保存用衣物 ID：取「可保存且已勾选」的，避免把已删除或用户取消的衣物写入。
  selectedIds() {
    return this.data.items.filter(item => item.available && item.selected).map(item => item._id)
  },

  // 点击衣物卡片切换勾选（已删除的不可选）。
  onItemTap(e) {
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
    if (saving || !ready || saved) return
    const itemIds = this.selectedIds()
    if (!itemIds.length) {
      wx.showToast({ title: '请先勾选要保存的衣物', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    try {
      const outfitId = await db.addOutfit({ name: this.outfitName(), occasion: '', note: '', itemIds, imageFileID: '' })
      if (alsoPlan) await db.addPlan({ date: this.data.date, outfitId, note: '' })
      wx.hideLoading()
      this.setData({ saving: false, saved: true, savedAsPlan: alsoPlan })
      wx.showToast({ title: alsoPlan ? '已保存并设为明天穿着' : '已保存为一套穿搭', icon: 'none' })
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  onSaveOutfit() { this.save(false) },
  onSaveAndPlan() { this.save(true) }
})
