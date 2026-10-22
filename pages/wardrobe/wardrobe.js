const db = require('../../utils/db')
const auth = require('../../utils/auth')
const focusPlaceholder = require('../../utils/focus-placeholder')

const app = getApp()

Page({
  ...focusPlaceholder,

  async onRetry() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.loadItems(true)
  },

  async onPullDownRefresh() {
    try { await this.onRetry() } finally { wx.stopPullDownRefresh() }
  },

  data: {
    loadError: '',
    items: [],          // 全部衣物（listItems 按添加时间倒序返回）
    filtered: [],       // 筛选后的衣物
    sections: [],       // 分组模式：[{category, total, list(最近5件)}]
    mode: 'group',      // group | filter（有搜索词或筛选条件时为 filter）
    keyword: '',
    categories: [],
    seasons: [],
    filterSeasons: [],  // 多选筛选条件
    filterCategories: [],
    filterColors: [],
    filterBrands: [],
    seasonChips: [],    // [{value, active}]，WXML 不支持方法调用，选中态预计算
    colorOptions: [],   // 全部颜色 + 衣橱中已有的颜色
    brandOptions: [],   // 全部品牌 + 衣橱中已有的品牌
    multiPicker: { show: false, title: '', options: [], selected: [], target: '' },
    loading: true
  },

  onLoad() {
    this.setData({
      categories: app.globalData.categories,
      seasons: app.globalData.seasons
    })
    this.syncSeasonChips()
  },

  syncSeasonChips() {
    const { seasons, filterSeasons } = this.data
    this.setData({
      seasonChips: seasons.map(s => ({ value: s, active: filterSeasons.indexOf(s) >= 0 }))
    })
  },

  async onShow() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.loadItems()
  },

  // 双击底部「衣物」tab：清空搜索词和全部筛选条件，回到默认分组视图
  onTabItemTap() {
    const now = Date.now()
    const isDoubleTap = this._lastTabTap && now - this._lastTabTap < 400
    this._lastTabTap = now
    if (!isDoubleTap) return
    const { keyword, filterSeasons, filterCategories, filterColors, filterBrands } = this.data
    // 已是默认状态则不动作
    if (!keyword && !filterSeasons.length && !filterCategories.length && !filterColors.length && !filterBrands.length) return
    this.setData({
      keyword: '',
      filterSeasons: [],
      filterCategories: [],
      filterColors: [],
      filterBrands: []
    })
    this.syncSeasonChips()
    this.applyView()
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },

  async loadItems(force = false) {
    this.setData({ loadError: '' })
    // 仅首次加载显示「加载中」；之后切 tab 命中缓存，静默刷新
    if (!this._loaded) this.setData({ loading: true })
    try {
      const items = await db.listItems(force)
      this._loaded = true
      // 颜色/品牌筛选滚轮的选项来自当前衣橱已有的颜色和品牌
      const colorOptions = [
        '全部颜色',
        ...new Set(items.map(item => (item.color || '').trim()).filter(Boolean))
      ]
      const brandOptions = [
        '全部品牌',
        ...new Set(items.map(item => (item.brand || '').trim()).filter(Boolean))
      ]
      this.setData({ items, colorOptions, brandOptions, loading: false })
      this.applyView()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '加载失败，请重试' })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value.trim() })
    this.applyView()
  },

  onSeasonTap(e) {
    const value = e.currentTarget.dataset.value
    const seasons = this.data.filterSeasons.slice()
    const i = seasons.indexOf(value)
    if (i >= 0) {
      seasons.splice(i, 1)
    } else {
      seasons.push(value)
    }
    this.setData({ filterSeasons: seasons })
    this.syncSeasonChips()
    this.applyView()
  },

  // ---------- 多选筛选面板（类型/颜色/品牌） ----------
  openPicker(e) {
    const target = e.currentTarget.dataset.target
    // 颜色/品牌选项首项是「全部」，多选面板里不需要（全部不选即不过滤）
    const config = {
      category: { title: '按类型筛选', options: this.data.categories, selected: this.data.filterCategories },
      color: { title: '按颜色筛选', options: this.data.colorOptions.slice(1), selected: this.data.filterColors },
      brand: { title: '按品牌筛选', options: this.data.brandOptions.slice(1), selected: this.data.filterBrands }
    }[target]
    this.setData({
      multiPicker: { show: true, target, ...config }
    })
  },

  onMultiConfirm(e) {
    const { multiPicker } = this.data
    const field = { category: 'filterCategories', color: 'filterColors', brand: 'filterBrands' }[multiPicker.target]
    const patch = { 'multiPicker.show': false }
    patch[field] = e.detail.selected
    this.setData(patch)
    this.applyView()
  },

  onMultiCancel() {
    this.setData({ 'multiPicker.show': false })
  },

  // 无筛选条件时按类别分行展示；有搜索词或筛选条件时平铺结果
  applyView() {
    const { items, keyword, filterSeasons, filterCategories, filterColors, filterBrands, categories } = this.data
    const filtering = !!(keyword || filterSeasons.length || filterCategories.length || filterColors.length || filterBrands.length)
    if (filtering) {
      const filtered = items.filter(item => {
        if (filterSeasons.length && !(item.seasons || []).some(s => filterSeasons.indexOf(s) >= 0)) return false
        if (filterCategories.length && filterCategories.indexOf(item.category) === -1) return false
        if (filterColors.length && filterColors.indexOf(item.color) === -1) return false
        if (filterBrands.length && filterBrands.indexOf(item.brand) === -1) return false
        if (keyword && !(item.name || '').includes(keyword)) return false
        return true
      })
      this.setData({ mode: 'filter', filtered })
    } else {
      // 展示全部分类，空的分类在 WXML 里显示「还无此类衣物」
      const sections = categories.map(category => {
        const inCategory = items.filter(item => item.category === category)
        return { category, total: inCategory.length, list: inCategory.slice(0, 5) }
      })
      this.setData({ mode: 'group', sections })
    }
  },

  onMoreTap(e) {
    const category = e.currentTarget.dataset.category
    wx.navigateTo({ url: `/pages/category/category?category=${encodeURIComponent(category)}` })
  },

  onAddTap() {
    wx.navigateTo({ url: '/pages/item-edit/item-edit' })
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/item-detail/item-detail?id=${encodeURIComponent(id)}` })
  }
})
