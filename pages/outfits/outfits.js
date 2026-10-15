const db = require('../../utils/db')
const auth = require('../../utils/auth')
const { today } = require('../../utils/date')

// 服务端每页返回 20 条。
const PAGE_SIZE = 20

// 单品集合完全相同（顺序无关、去重）；与 WEAR-04 的判重逻辑同款。
const sameItems = (a, b) => {
  const left = new Set(a || []), right = new Set(b || [])
  return left.size === right.size && [...left].every(id => right.has(id))
}

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
    wearBusyId: '',  // 正在写入实穿的搭配 _id（按钮 busy 态，防连点）
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
      const [outfits, items, records] = await Promise.all([db.listOutfitsPage(0), db.listItems(force), db.listWearRecords(force)])
      if (token !== this._loadToken) return
      this._loaded = true
      const itemMap = {}
      items.forEach(item => { itemMap[item._id] = item })
      this._itemMap = itemMap
      // 只保留当天实穿记录，用于判断卡片「今天穿了 / 已记录」。
      this._todayRecords = records.filter(record => record.date === today())
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
      coverFileID: outfit.imageFileID || (thumbs.length ? thumbs[0].imageFileID : ''),
      wornToday: this.isWornToday(outfit) }
  },

  // 当天已有同 outfitId 或同衣物集合的实穿记录，即视为「已记录」。
  isWornToday(outfit) {
    const ids = outfit.itemIds || []
    return (this._todayRecords || []).some(record =>
      (!!record.outfitId && record.outfitId === outfit._id) ||
      (ids.length > 0 && sameItems(record.itemIds, ids)))
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
    wx.navigateTo({ url: '/pages/outfit-edit/outfit-edit?quick=1' })
  },

  onWearTap() {
    wx.navigateTo({ url: '/pages/today-wear/today-wear' })
  },

  // 「今天穿了」：一键把该搭配的单品快照写为当天实穿记录（可选的静默打卡）。
  async onWearTodayTap(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.wearBusyId) return
    const outfit = (this._all || []).find(item => item._id === id)
    if (!outfit || outfit.wornToday) return
    const itemIds = outfit.itemIds || []
    if (!itemIds.length) {
      wx.showToast({ title: '这套搭配还没有衣物', icon: 'none' })
      return
    }
    this.setData({ wearBusyId: id })
    try {
      await db.addWearRecord({ date: today(), itemIds, outfitId: outfit._id, note: '' })
      this.markWornLocally(outfit)
      wx.showToast({ title: '已记录今天穿着', icon: 'none' })
    } catch (error) {
      // WEAR-01 服务端判重是最终边界：重复被拒按「已记录」处理，不算失败。
      if (/相同衣物组合/.test(error.message || '')) {
        this.markWornLocally(outfit)
        wx.showToast({ title: '今天已记录', icon: 'none' })
      } else {
        console.error(error)
        wx.showToast({ title: '记录失败，请重试', icon: 'none' })
      }
    } finally {
      this.setData({ wearBusyId: '' })
    }
  },

  // 本地补记当天实穿并重算所有卡片「已记录」态，避免依赖下一次整页刷新。
  markWornLocally(outfit) {
    this._todayRecords = [...(this._todayRecords || []),
      { date: today(), itemIds: outfit.itemIds || [], outfitId: outfit._id }]
    this._all = (this._all || []).map(item => ({ ...item, wornToday: this.isWornToday(item) }))
    this.renderPage()
  },

  onOutfitTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/outfit-edit/outfit-edit?id=${id}` })
  }
})
