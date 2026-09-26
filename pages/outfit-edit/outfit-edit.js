const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const app = getApp()

Page({
  ...swipeBack,
  ...focusPlaceholder,

  data: {
    id: '',
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
    this.setData({
      id: options.id || '',
      occasions: app.globalData.occasions,
      categories: ['全部', '已选', ...app.globalData.categories]
    })
    if (!options.id && options.recommended === '1') {
      this.setData({
        name: typeof options.name === 'string' ? options.name.slice(0, 40) : '',
        occasion: app.globalData.occasions.includes(options.occasion) ? options.occasion : '',
        occasionIndex: app.globalData.occasions.indexOf(options.occasion),
        selectedIds: typeof options.itemIds === 'string' ? options.itemIds.split(',').slice(0, 10) : []
      })
    }
    if (options.id) wx.setNavigationBarTitle({ title: '编辑穿搭' })
    return this.onRetry()
  },

  async onRetry() {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      await this.loadItems()
      if (this.data.id) await this.loadOutfit(this.data.id)
      this.setData({ ready: true, loading: false })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '穿搭或衣物加载失败，请重试' })
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

  async onChooseImage() {
    try {
      const path = await db.chooseImage()
      this.setData({ imagePath: path })
    } catch (e) {
      // 用户取消
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }) },
  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  // ---------- 自定义滚轮选择器 ----------
  openPicker() {
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
    const { id, name, occasion, note, imagePath, imageFileID, selectedIds, saving } = this.data
    if (saving || !this.data.ready) return
    if (!name.trim()) {
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
        await db.addOutfit(data)
      }
      committed = true
      wx.hideLoading()
      wx.showToast({ title: result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) {
      console.error(e)
      if (uploadedFileID && !committed) db.removeImage(uploadedFileID)
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败', icon: 'none' })
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
          setTimeout(() => wx.navigateBack(), 500)
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
