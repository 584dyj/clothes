const db = require('../../utils/db')
const auth = require('../../utils/auth')

// 服务端每页返回 20 条。
const PAGE_SIZE = 20

Page({
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

  data: {
    loadError: '',
    left: [],        // 左列卡片
    right: [],       // 右列卡片
    itemMap: {},     // 衣物 _id -> 衣物对象
    loading: true,
    hasMore: true
  },

  async onShow() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.loadData()
  },

  async loadData(force = false) {
    const token = this._loadToken = (this._loadToken || 0) + 1
    this.setData({ loadError: '' })
    // 仅首次加载显示「加载中」；之后切 tab 命中缓存，静默刷新
    if (!this._loaded) this.setData({ loading: true })
    try {
      const [outfits, items] = await Promise.all([db.listOutfitsPage(0), db.listItems(force)])
      if (token !== this._loadToken) return
      this._loaded = true
      const itemMap = {}
      items.forEach(item => { itemMap[item._id] = item })
      this._itemMap = itemMap
      this._all = outfits.map(outfit => this.withImages(outfit))
      this.setData({ loading: false, hasMore: outfits.length === PAGE_SIZE })
      this.renderPage()
    } catch (e) {
      if (token !== this._loadToken) return
      console.error(e)
      this.setData({ loading: false, loadError: '加载失败，请重试' })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  withImages(outfit) {
    const validItems = (outfit.itemIds || []).map(id => this._itemMap[id]).filter(Boolean)
    const thumbs = validItems.filter(item => item.imageFileID).slice(0, 4)
    return { ...outfit, count: validItems.length, thumbs,
      coverFileID: outfit.imageFileID || (thumbs.length ? thumbs[0].imageFileID : '') }
  },

  // 按已加载记录渲染双列瀑布流。
  renderPage() {
    const left = []
    const right = []
    this._all.forEach((item, i) => {
      ;(i % 2 === 0 ? left : right).push(item)
    })
    this.setData({ left, right })
  },

  // 页面滚动到底：从服务端取下一页。
  async onReachBottom() {
    if (this._loadingMore || !this._all || !this.data.hasMore) return
    this._loadingMore = true
    const token = this._loadToken
    try {
      const outfits = await db.listOutfitsPage(this._all.length)
      if (token !== this._loadToken) return
      this._all.push(...outfits.map(outfit => this.withImages(outfit)))
      this.setData({ hasMore: outfits.length === PAGE_SIZE })
      this.renderPage()
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '加载更多失败，请重试', icon: 'none' })
    } finally { this._loadingMore = false }
  },

  onAddTap() {
    wx.navigateTo({ url: '/pages/outfit-edit/outfit-edit' })
  },

  onWearTap() {
    wx.navigateTo({ url: '/pages/today-wear/today-wear' })
  },

  onOutfitTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/outfit-edit/outfit-edit?id=${id}` })
  }
})
