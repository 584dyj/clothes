const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const app = getApp()

// 单品集合完全相同（顺序无关、去重）；与 WEAR-04 的判重逻辑同款。
const sameItems = (a, b) => {
  const left = new Set(a || []), right = new Set(b || [])
  return left.size === right.size && [...left].every(id => right.has(id))
}

Page({
  ...swipeBack,
  ...focusPlaceholder,

  data: {
    id: '',
    wearRecordId: '',
    createdOutfitId: '',
    linkError: '',
    linkNeedsReturn: false,
    quick: false,        // 快速录入模式：只突出单品与一行备注
    showMore: false,     // 快速模式下折叠的「更多选项」展开态
    name: '',
    occasion: '',
    occasions: [],
    occasionIndex: -1,
    note: '',
    imagePath: '',
    imageFileID: '',
    items: [],           // 全部衣物（供挑选）
    viewItems: [],       // 当前分类下的衣物（含 selected 标记，预计算）
    categories: [],      // 分类切换条：全部 | 已选 | 各类别
    activeCategory: '全部',
    selectedIds: [],     // 已选中的衣物 _id
    saving: false,
    ready: false,
    loading: true,
    loadError: '',
    picker: { show: false, title: '', columns: [], values: [], target: '' }  // 自定义滚轮
  },

  async onLoad(options) {
    this._options = options
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    const quick = !options.id && !options.wearRecordId && !!options.quick
    this.setData({
      id: options.wearRecordId ? '' : options.id || '',
      wearRecordId: options.wearRecordId || '',
      quick,
      occasions: app.globalData.occasions,
      categories: ['全部', '已选', ...app.globalData.categories]
    })
    if (options.wearRecordId) wx.setNavigationBarTitle({ title: '保存为穿搭' })
    else if (options.id) wx.setNavigationBarTitle({ title: '编辑穿搭' })
    else if (quick) wx.setNavigationBarTitle({ title: '记一套搭配' })
    return this.onRetry()
  },

  onUnload() {
    this._unloaded = true
    if (this._returnTimer) clearTimeout(this._returnTimer)
  },

  scheduleReturn() {
    if (this._unloaded) return
    this._returnTimer = setTimeout(() => {
      this._returnTimer = null
      if (!this._unloaded) wx.navigateBack()
    }, 500)
  },

  async onRetry() {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      await this.loadItems()
      if (this.data.id) await this.loadOutfit(this.data.id)
      if (this.data.wearRecordId) await this.loadWearRecord(this.data.wearRecordId)
      this.setData({ ready: true, loading: false })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: e.message === '实穿衣物已从衣橱删除'
        ? '实穿衣物已从衣橱删除，请返回实穿记录处理' : '穿搭或衣物加载失败，请重试' })
    }
  },

  // WXML 不支持方法调用，当前分类视图 + 选中态在 JS 里预计算到 viewItems
  syncSelected() {
    const { items, selectedIds, activeCategory } = this.data
    let list = items
    if (activeCategory === '已选') {
      list = items.filter(it => selectedIds.indexOf(it._id) >= 0)
    } else if (activeCategory !== '全部') {
      list = items.filter(it => it.category === activeCategory)
    }
    this.setData({
      viewItems: list.map(it => ({ ...it, selected: selectedIds.indexOf(it._id) >= 0 }))
    })
  },

  onCategoryTap(e) {
    if (this.data.wearRecordId) return
    this.setData({ activeCategory: e.currentTarget.dataset.value })
    this.syncSelected()
  },

  async loadItems() {
    try {
      const items = await db.listItems(true)
      const ids = new Set(items.map(item => item._id))
      this.setData({ items, selectedIds: this.data.selectedIds.filter(id => ids.has(id)) })
      this.syncSelected()
    } catch (e) {
      console.error(e)
      throw e
    }
  },

  async loadOutfit(id) {
    try {
      const outfit = await db.getOutfit(id)
      const occasionIndex = this.data.occasions.indexOf(outfit.occasion)
      const existingIds = new Set(this.data.items.map(item => item._id))
      this.setData({
        name: outfit.name || '',
        occasion: outfit.occasion || '',
        occasionIndex,
        note: outfit.note || '',
        imageFileID: outfit.imageFileID || '',
        // 过滤历史数据中已被删除的衣物引用，保存时会自动写回干净数据。
        selectedIds: (outfit.itemIds || []).filter(itemId => existingIds.has(itemId))
      })
      this.syncSelected()
    } catch (e) {
      console.error(e)
      throw e
    }
  },

  async loadWearRecord(id) {
    const record = await db.getWearRecord(id)
    const ids = record.itemIds || []
    const available = new Set(this.data.items.map(item => item._id))
    if (!ids.length || ids.some(itemId => !available.has(itemId))) throw new Error('实穿衣物已从衣橱删除')
    this.setData({ selectedIds: ids.slice(), activeCategory: '已选' })
    this.syncSelected()
  },

  async onChooseImage() {
    if (this.data.createdOutfitId) return
    try {
      const path = await db.chooseImage()
      this.setData({ imagePath: path })
    } catch (e) {
      // 用户取消
    }
  },

  onNameInput(e) { if (!this.data.createdOutfitId) this.setData({ name: e.detail.value }) },
  onNoteInput(e) { if (!this.data.createdOutfitId) this.setData({ note: e.detail.value }) },

  onToggleMore() { this.setData({ showMore: !this.data.showMore }) },

  // 快速录入留空名称时按已选单品自动命名：前两件用「·」连接，超过两件追加「等 N 件」，总长截断 20 字符。
  autoName() {
    const names = this.data.selectedIds
      .map(id => (this.data.items.find(item => item._id === id) || {}).name)
      .filter(Boolean)
    if (!names.length) return ''
    const head = names.slice(0, 2).join('·')
    return (names.length > 2 ? `${head} 等${names.length}件` : head).slice(0, 20)
  },

  // 新增（非编辑、非实穿另存）前比对现存搭配：单品集合完全相同时提示，返回是否继续保存。
  async confirmDuplicateOutfit(selectedIds) {
    let outfits = []
    try {
      outfits = await db.listOutfits()
    } catch (e) {
      console.error(e)
      return true
    }
    const existing = outfits.find(outfit => sameItems(outfit.itemIds, selectedIds))
    if (!existing) return true
    const viewExisting = await new Promise(resolve => wx.showModal({
      title: '已有相同搭配',
      content: `已有一套单品完全相同的搭配「${existing.name || '未命名'}」，查看它还是仍要新建？`,
      confirmText: '查看该搭配',
      cancelText: '仍要新建',
      success: res => resolve(res.confirm),
      fail: () => resolve(false)
    }))
    if (!viewExisting) return true
    wx.navigateTo({ url: `/pages/outfit-edit/outfit-edit?id=${existing._id}` })
    return false
  },

  // ---------- 自定义滚轮选择器 ----------
  openPicker() {
    if (this.data.createdOutfitId) return
    this.setData({
      picker: {
        show: true,
        target: 'occasion',
        title: '选择场合',
        columns: [this.data.occasions],
        values: [Math.max(this.data.occasionIndex, 0)]
      }
    })
  },

  onPickerConfirm(e) {
    if (this.data.createdOutfitId) return
    const index = e.detail.values[0]
    this.setData({
      'picker.show': false,
      occasionIndex: index,
      occasion: this.data.occasions[index]
    })
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },

  onItemToggle(e) {
    if (this.data.wearRecordId) return
    const id = e.currentTarget.dataset.id
    const selected = this.data.selectedIds.slice()
    const idx = selected.indexOf(id)
    if (idx >= 0) {
      selected.splice(idx, 1)
    } else {
      selected.push(id)
    }
    this.setData({ selectedIds: selected })
    this.syncSelected()
  },

  async onSave() {
    const { id, wearRecordId, createdOutfitId, occasion, note, imagePath, imageFileID, selectedIds, saving, quick } = this.data
    if (saving || !this.data.ready) return
    if (createdOutfitId) {
      if (this.data.linkNeedsReturn) return wx.navigateBack()
      return this.linkSavedOutfit(wearRecordId, createdOutfitId)
    }
    let name = this.data.name
    // 快速录入允许留空名称：先按已选单品自动补名（无单品时保持为空，交由下方单品校验提示）。
    if (quick && !name.trim()) {
      name = this.autoName()
      if (name) this.setData({ name })
    }
    if (!name.trim() && !quick) {
      wx.showToast({ title: '请填写穿搭名称', icon: 'none' })
      return
    }
    if (selectedIds.length > 100) {
      wx.showToast({ title: '每套最多选择 100 件衣物', icon: 'none' })
      return
    }
    if (selectedIds.length === 0) {
      wx.showToast({ title: '请至少选择一件衣物', icon: 'none' })
      return
    }
    // 新增前检查是否已有相同单品组合的搭配（编辑已有穿搭、实穿另存不触发）。
    // 先置 saving，避免检查期间（含弹窗）被再次点击重复提交。
    if (!id && !wearRecordId) {
      this.setData({ saving: true })
      const proceed = await this.confirmDuplicateOutfit(selectedIds)
      if (!proceed) { this.setData({ saving: false }); return }
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    let uploadedFileID = ''
    let committed = false
    let result = {}
    try {
      let fileID = imageFileID
      if (imagePath) {
        uploadedFileID = await db.uploadImage(imagePath)
        fileID = uploadedFileID
      }
      const data = {
        name: name.trim(),
        occasion,
        note: note.trim(),
        itemIds: selectedIds,
        imageFileID: fileID
      }
      if (id) {
        result = await db.updateOutfit(id, data)
      } else {
        const newId = await db.addOutfit(data)
        if (wearRecordId) this.setData({ createdOutfitId: newId, imagePath: '', imageFileID: fileID })
      }
      committed = true
      if (wearRecordId) await db.linkWearOutfit(wearRecordId, this.data.createdOutfitId)
      wx.hideLoading()
      wx.showToast({ title: result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
      this.scheduleReturn()
    } catch (e) {
      console.error(e)
      if (uploadedFileID && !committed) db.removeImage(uploadedFileID)
      wx.hideLoading()
      if (committed && wearRecordId) this.showLinkError(e)
      else {
        this.setData({ saving: false })
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    }
  },

  showLinkError(error) {
    const changed = /衣物与实穿记录不一致|穿着记录不存在|穿搭不存在/.test(error.message || '')
    this.setData({ saving: false, linkNeedsReturn: changed,
      linkError: changed ? '穿搭已保存，实穿记录或单品已变化，请返回实穿页处理' : '穿搭已保存，关联实穿失败，请重试' })
    wx.showToast({ title: changed ? '请返回实穿页处理' : '关联失败，请重试', icon: 'none' })
  },

  async linkSavedOutfit(wearRecordId, outfitId) {
    this.setData({ saving: true, linkError: '' })
    wx.showLoading({ title: '关联中…' })
    try {
      await db.linkWearOutfit(wearRecordId, outfitId)
      wx.hideLoading()
      wx.showToast({ title: '已保存', icon: 'none' })
      this.scheduleReturn()
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      this.showLinkError(e)
    }
  },

  onDelete() {
    if (!this.data.ready || this.data.saving) return
    wx.showModal({
      title: '删除穿搭',
      content: '确定要删除这套穿搭吗？（不会删除衣物本身）',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm || this.data.saving) return
        this.setData({ saving: true })
        wx.showLoading({ title: '删除中…' })
        try {
          const result = await db.deleteOutfit(this.data.id)
          wx.hideLoading()
          wx.showToast({ title: result.cleanupFailed ? '已删除，清理待重试' : '已删除', icon: 'none' })
          this.scheduleReturn()
        } catch (e) {
          console.error(e)
          wx.hideLoading()
          this.setData({ saving: false })
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
})
