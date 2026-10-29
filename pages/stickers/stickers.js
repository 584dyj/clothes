const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const { priceOf } = require('../../utils/money')

Page({
  ...swipeBack,

  data: {
    activeTab: 'owned',
    items: [],
    emptyText: '还没有贴纸，点 + 记一款吧',
    loading: true,
    loadError: '',
    unpricedCount: 0,
    // 统计区常驻展开：拥有（含已拼贴）、已贴、未贴、已购贴纸开销
    statsView: { owned: 0, done: 0, undone: 0, spent: 0 }
  },

  async onShow() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.loadData()
  },

  async onRetry() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.loadData(true)
  },

  async onPullDownRefresh() {
    try { await this.onRetry() } finally { wx.stopPullDownRefresh() }
  },

  async loadData(force = false) {
    const token = this._loadToken = (this._loadToken || 0) + 1
    this.setData({ loadError: '' })
    if (!this._loaded) this.setData({ loading: true })
    try {
      const items = await db.listStickers(force)
      if (token !== this._loadToken) return
      this._loaded = true
      this._all = items
      this.setData({ loading: false })
      this.applyFilter()
      await this.loadStats(token)
    } catch (e) {
      if (token !== this._loadToken) return
      console.error(e)
      this.setData({ loading: false, loadError: '贴纸加载失败，请重试' })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 统计失败保持当前数字（默认 0），不影响列表主路径
  async loadStats(token) {
    try {
      const stats = await db.stickerStats()
      if (token !== this._loadToken) return
      this.setData({ statsView: {
        owned: stats.ownedCount,
        done: stats.doneCount,
        undone: stats.ownedCount - stats.doneCount,
        spent: stats.ownedSpent
      } })
    } catch (e) {
      if (token !== this._loadToken) return
      console.error(e)
    }
  },

  applyFilter() {
    const { activeTab } = this.data
    const items = (this._all || []).filter(item => activeTab === 'wishlist'
      ? item.status === 'wishlist'
      : item.status === 'owned' || item.status === 'done')
    const emptyText = activeTab === 'wishlist'
      ? '心愿单还是空的，记下想买的贴纸吧'
      : '还没有贴纸，点 + 记一款吧'
    const unpricedCount = (this._all || []).filter(item => (item.status === 'owned' || item.status === 'done') && priceOf(item.price) === null).length
    this.setData({ items, emptyText, unpricedCount })
  },

  onTabTap(e) {
    const value = e.currentTarget.dataset.value
    if (!['owned', 'wishlist'].includes(value) || value === this.data.activeTab) return
    this.setData({ activeTab: value })
    this.applyFilter()
  },

  onAddTap() {
    wx.navigateTo({ url: '/pages/sticker-edit/sticker-edit' })
  },

  onItemTap(e) {
    wx.navigateTo({ url: `/pages/sticker-edit/sticker-edit?id=${e.currentTarget.dataset.id}` })
  }
})
