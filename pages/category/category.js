const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')

const app = getApp()

// 服装十三类开放季节筛选，其余类别（配饰、挂件、包袋、鞋、其他）不显示
const SEASON_FILTER_CATEGORIES = ['外套', '短袖', '长袖', '衬衫', '羽绒服', '保暖衣', '毛衣', '家居服', '连衣裙', '长裙', '短裙', '长裤', '短裤']
// 配饰有二级分类，详情页底部显示类型筛选
const SUB_FILTER_CATEGORY = '配饰'

Page({
  ...swipeBack,

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
    category: '',
    items: [],        // 该类别全部衣物（季节筛选 + 排序后）
    sortKey: 'time',  // time | price
    sortDesc: true,
    timeMark: '↓',    // 排序箭头，WXML 不适合嵌套三元，预计算
    priceMark: '',
    showSeasonFilter: false, // 仅服装十三类为 true
    seasonChips: [],  // [{value, active}]，选中态预计算
    filterSeasons: [],// 多选季节筛选条件
    showSubFilter: false,    // 仅配饰为 true
    subChips: [],     // [{value, active}]
    filterSubs: [],   // 多选配饰类型筛选条件
    loading: true
  },

  async onLoad(options) {
    const category = decodeURIComponent(options.category || '')
    this.setData({
      category,
      showSeasonFilter: SEASON_FILTER_CATEGORIES.indexOf(category) >= 0,
      showSubFilter: category === SUB_FILTER_CATEGORY
    })
    wx.setNavigationBarTitle({ title: category || '类别' })
    this.syncSeasonChips()
    this.syncSubChips()
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.loadItems()
  },

  syncSeasonChips() {
    const { filterSeasons } = this.data
    this.setData({
      seasonChips: app.globalData.seasons.map(s => ({ value: s, active: filterSeasons.indexOf(s) >= 0 }))
    })
  },

  syncSubChips() {
    const { filterSubs } = this.data
    this.setData({
      subChips: app.globalData.accessoryTypes.map(s => ({ value: s, active: filterSubs.indexOf(s) >= 0 }))
    })
  },

  onShow() {
    // 首次进入由 onLoad 加载；这里只处理从编辑页返回后的刷新
    if (this.data.category && !this.data.loading) this.loadItems()
  },

  async loadItems(force = false) {
    this.setData({ loadError: '' })
    // 仅首次加载显示「加载中」；之后命中缓存，静默刷新
    if (!this._loaded) this.setData({ loading: true })
    try {
      const all = await db.listItems(force)
      this._loaded = true
      const category = this.data.category
      // 留存类别全集，季节筛选在 applySort 里叠加，避免重复拉取
      this._categoryItems = all.filter(item => item.category === category)
      this.setData({ loading: false })
      this.applySort()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '加载失败，请重试' })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
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
    this.applySort()
  },

  onSubTap(e) {
    const value = e.currentTarget.dataset.value
    const subs = this.data.filterSubs.slice()
    const i = subs.indexOf(value)
    if (i >= 0) {
      subs.splice(i, 1)
    } else {
      subs.push(value)
    }
    this.setData({ filterSubs: subs })
    this.syncSubChips()
    this.applySort()
  },

  onSortTap(e) {
    const key = e.currentTarget.dataset.key
    if (this.data.sortKey === key) {
      this.setData({ sortDesc: !this.data.sortDesc })
    } else {
      this.setData({ sortKey: key, sortDesc: true })
    }
    this.applySort()
  },

  applySort() {
    const { filterSeasons, filterSubs, sortKey, sortDesc } = this.data
    let list = this._categoryItems || []
    // 季节多选：衣物适合任一选中季节即保留
    if (filterSeasons.length) {
      list = list.filter(item => (item.seasons || []).some(s => filterSeasons.indexOf(s) >= 0))
    }
    // 配饰类型多选：属于任一选中类型即保留；未填类型的旧配饰仅在未筛选时显示
    if (filterSubs.length) {
      list = list.filter(item => filterSubs.indexOf(item.subcategory) >= 0)
    }
    const sorted = list.slice().sort((a, b) => {
      let va, vb
      if (sortKey === 'price') {
        va = Number(a.price) || 0   // 兼容旧数据 price 为 null
        vb = Number(b.price) || 0
      } else {
        va = a.createdAt ? new Date(a.createdAt).getTime() : 0
        vb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      }
      return sortDesc ? vb - va : va - vb
    })
    this.setData({
      items: sorted,
      timeMark: sortKey === 'time' ? (sortDesc ? '↓' : '↑') : '',
      priceMark: sortKey === 'price' ? (sortDesc ? '↓' : '↑') : ''
    })
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/item-edit/item-edit?id=${id}` })
  }
})
