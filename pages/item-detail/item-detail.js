// 衣物详情（只读预览 + 关联穿搭）：VIEW-01 / VIEW-02 / VIEW-03
// 设计与口径见 docs/4/衣物预览与关联穿搭SPEC.md
const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const { priceOf } = require('../../utils/money')

// 关联穿搭每批渲染套数（全量已在本地，触底仅追加视图批次，不再发请求）
const BATCH_SIZE = 10

Page({
  ...swipeBack,

  data: {
    id: '',
    loading: true,        // 主记录加载中
    ready: false,         // 主记录可用（编辑入口前提）
    unavailable: false,   // 不存在或无权访问（含非法 id）
    loadError: '',        // 主记录其他读取失败
    item: null,           // 主记录视图模型
    navigating: false,    // 编辑导航中保护，防连点叠加编辑页
    relatedLoading: true, // 关联穿搭读取中
    relatedReady: false,  // 关联穿搭至少完整读取成功一次
    relatedError: '',     // 关联读取失败（与空态分离）
    relatedTotal: 0,
    outfits: [],          // 已渲染批次的穿搭视图
    hasMore: false
  },

  onLoad(options) {
    // onLoad 仅解析并校验 id：非空字符串、长度不超过 100；非法直接进入不可用态，不发数据请求
    const id = options && typeof options.id === 'string' ? options.id : ''
    if (!id || id.length > 100) {
      this._invalidParam = true
      this.setData({ loading: false, relatedLoading: false, unavailable: true })
      return
    }
    this.setData({ id })
  },

  async onShow() {
    if (this._invalidParam) return
    // 编辑页删除成功后回退到来源页，不再读取旧记录
    if (this._deleted) return this.leaveAfterDelete()
    const itemSeq = this._itemSeq = (this._itemSeq || 0) + 1
    const relatedSeq = this._relatedSeq = (this._relatedSeq || 0) + 1
    if (!await auth.ensureLogin()) {
      if (itemSeq === this._itemSeq) {
        this.setData({ loading: false, ready: false, item: null, loadError: '登录校验未完成，请重试' })
      }
      if (relatedSeq === this._relatedSeq) {
        this.setData({ relatedLoading: false, relatedError: '登录校验未完成，请重试' })
      }
      return
    }
    if (itemSeq !== this._itemSeq || this._unloaded) return
    // 主记录与关联列表并行读取，分别处理成功和失败
    this.loadItem(itemSeq)
    this.loadRelated(relatedSeq)
  },

  onUnload() { this._unloaded = true },

  // ---------- 当前衣物 ----------

  async loadItem(seq) {
    this.setData({ loading: true, loadError: '' })
    try {
      const item = await db.getItem(this.data.id)
      if (seq !== this._itemSeq || this._unloaded) return
      this._item = item
      // 用最新主记录覆盖单品映射中的当前衣物，防止主图与「本件」缩略图版本不一致
      if (this._itemMap) {
        this._itemMap[item._id] = item
        if (this._relatedRaw) this.renderRelated()
      }
      this.setData({ loading: false, ready: true, item: this.buildItemView(item) })
    } catch (e) {
      if (seq !== this._itemSeq || this._unloaded) return
      console.error(e)
      // 服务端将记录不存在与无权访问合并返回，不暴露归属信息；其余按普通读取失败处理，
      // 不把网络错误当成删除成功，不自动退出
      const gone = /不存在或无权访问/.test(e && e.message || '')
      this.setData({
        loading: false, ready: false, item: null,
        unavailable: gone,
        loadError: gone ? '' : '衣物加载失败，请重试'
      })
    }
  },

  buildItemView(item) {
    const price = priceOf(item.price)
    const hasPrice = price !== null
    return {
      name: item.name || '未命名',
      imageFileID: item.imageFileID || '',
      imageBroken: false,
      categoryText: item.category === '配饰' && item.subcategory ? `配饰 / ${item.subcategory}` : item.category || '',
      seasonsText: (item.seasons || []).join(' / '),
      color: item.color || '',
      size: item.size || '',
      brand: item.brand || '',
      hasPrice,
      priceText: hasPrice ? `¥${price.toFixed(2)}` : '',
      purchaseDate: item.purchaseDate || '',
      note: item.note || ''
    }
  },

  onMainImageError() {
    if (this.data.item) this.setData({ 'item.imageBroken': true })
  },

  onPreviewMain() {
    const item = this.data.item
    if (!item || !item.imageFileID || item.imageBroken) return
    wx.previewImage({ urls: [item.imageFileID] })
  },

  // ---------- 关联穿搭 ----------

  async loadRelated(seq, force = false) {
    this.setData({ relatedLoading: true, relatedError: '' })
    try {
      // 全量拉取后按 itemIds 筛选；只取首页分页会漏掉第 21 条以后的历史关联
      const [outfits, items] = await Promise.all([db.listOutfits(force), db.listItems(force)])
      if (seq !== this._relatedSeq || this._unloaded) return
      const itemMap = {}
      items.forEach(item => { itemMap[item._id] = item })
      if (this._item) itemMap[this.data.id] = this._item
      this._itemMap = itemMap
      // 保持服务端原顺序（createdAt、_id 倒序）；空穿搭的 itemIds 为空，天然不匹配
      this._relatedRaw = outfits.filter(outfit =>
        Array.isArray(outfit.itemIds) && outfit.itemIds.indexOf(this.data.id) >= 0)
      this.setData({ relatedLoading: false, relatedReady: true })
      this.renderRelated()
    } catch (e) {
      if (seq !== this._relatedSeq || this._unloaded) return
      console.error(e)
      // 失败必须与空列表区分，重试仅重试关联读取，不重载已成功的主记录
      this.setData({ relatedLoading: false, relatedError: '相关穿搭加载失败，点击重试', outfits: [], hasMore: false })
    }
  },

  buildOutfitView(outfit) {
    // 同一套中重复 id 只显示一次，保留原单品顺序；套间不合并
    const seen = {}
    const items = []
    ;(outfit.itemIds || []).forEach(id => {
      if (seen[id]) return
      seen[id] = true
      const found = this._itemMap[id]
      items.push(found ? {
        id,
        name: found.name || '未命名',
        imageFileID: found.imageFileID || '',
        available: true,
        isCurrent: id === this.data.id
      } : {
        // 引用无法映射：占位不可点击，不丢弃整套，也不推断其已删除
        id, available: false, isCurrent: id === this.data.id
      })
    })
    return {
      _id: outfit._id,
      name: outfit.name || '未命名穿搭',
      occasion: outfit.occasion || '',
      note: outfit.note || '',
      imageFileID: outfit.imageFileID || '',
      items
    }
  },

  // 全量原始数据与映射驻留页面实例，setData 只传当前批次的视图字段
  renderRelated() {
    const raw = this._relatedRaw || []
    const views = raw.map(outfit => this.buildOutfitView(outfit))
    this._relatedViews = views
    const shown = this.data.outfits.length
    const count = Math.min(Math.max(shown, BATCH_SIZE), views.length)
    this.setData({
      relatedTotal: raw.length,
      outfits: views.slice(0, count),
      hasMore: views.length > count
    })
  },

  onReachBottom() {
    const views = this._relatedViews || []
    const shown = this.data.outfits.length
    if (shown >= views.length) return
    const count = Math.min(shown + BATCH_SIZE, views.length)
    this.setData({ outfits: views.slice(0, count), hasMore: views.length > count })
  },

  onRelatedRetry() {
    const seq = this._relatedSeq = (this._relatedSeq || 0) + 1
    this.loadRelated(seq)
  },

  onPreviewOutfitPhoto(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.previewImage({ urls: [url] })
  },

  onPreviewItemImage(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.previewImage({ urls: [url] })
  },

  // ---------- 刷新 / 重试 / 编辑 / 删除回程 ----------

  async onPullDownRefresh() {
    if (this._invalidParam) { wx.stopPullDownRefresh(); return }
    const itemSeq = this._itemSeq = (this._itemSeq || 0) + 1
    const relatedSeq = this._relatedSeq = (this._relatedSeq || 0) + 1
    try {
      await Promise.all([this.loadItem(itemSeq), this.loadRelated(relatedSeq, true)])
    } finally {
      // 无论成功失败都结束下拉动画
      wx.stopPullDownRefresh()
    }
  },

  onRetry() {
    if (this._invalidParam) return
    const seq = this._itemSeq = (this._itemSeq || 0) + 1
    this.loadItem(seq)
  },

  onEditTap() {
    if (!this.data.ready || this.data.navigating) return
    this.setData({ navigating: true })
    wx.navigateTo({
      url: `/pages/item-edit/item-edit?id=${encodeURIComponent(this.data.id)}`,
      events: {
        // 编辑页删除明确成功后经 EventChannel 通知；负载仅含当前 id
        itemDeleted: payload => {
          if (payload && payload.id === this.data.id) this._deleted = true
        }
      },
      complete: () => this.setData({ navigating: false })
    })
  },

  // 删除后只回退一次：正常回真实来源页，无上一页时回衣橱兜底
  leaveAfterDelete() {
    if (this._left) return
    this._left = true
    this.goBack()
  },

  goBack() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/wardrobe/wardrobe' })
  },

  onBack() { this.goBack() }
})
