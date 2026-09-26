const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const { validDate } = require('../../utils/date')
const datePicker = require('../../utils/date-picker')
const app = getApp()

// 穿着记录：为某天记录实际穿过的衣物（可选关联穿搭，选了自动带出其单品）。
Page({
  ...swipeBack,
  ...focusPlaceholder,
  ...datePicker,

  data: {
    id: '',                 // 为空表示新增
    date: '',
    items: [],
    viewItems: [],          // 当前分类过滤 + 选中态预计算
    categories: [],
    activeCategory: '全部',
    selectedIds: [],
    outfits: [],
    outfitId: '',
    outfitName: '',
    note: '',
    saving: false,
    ready: false,
    loading: true,
    loadError: '',
    picker: { show: false, title: '', columns: [], values: [], target: '' }
  },

  async onLoad(options) {
    this._options = options
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.setData({
      id: options.id || '',
      date: validDate(options.date) ? options.date : this.today(),
      categories: ['全部', '已选', ...app.globalData.categories]
    })
    if (options.id) {
      wx.setNavigationBarTitle({ title: '编辑穿着' })
      return this.loadRecord(options.id)
    }
    return this.loadBase()
  },

  today() {
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  },

  onRetry() { return this.onLoad(this._options || {}) },

  async loadBase() {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const [items, outfits] = await Promise.all([db.listItems(), db.listOutfits()])
      this._items = items
      this.setData({ items, outfits, ready: true, loading: false })
      this.syncSelected()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '衣物或穿搭加载失败，请重试' })
    }
  },

  async loadRecord(id) {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const [items, outfits, records] = await Promise.all([db.listItems(), db.listOutfits(), db.listWearRecords()])
      const record = records.find(row => row._id === id)
      if (!record) throw new Error('记录不存在')
      this._items = items
      this.setData({
        items,
        outfits,
        selectedIds: record.itemIds || [],
        outfitId: record.outfitId || '',
        outfitName: this.outfitNameOf(outfits, record.outfitId),
        note: record.note || '',
        date: record.date || '',
        ready: true, loading: false
      })
      this.syncSelected()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '记录加载失败，请重试' })
    }
  },

  outfitNameOf(outfits, id) {
    const outfit = outfits.find(row => row._id === id)
    return outfit ? (outfit.name || '未命名') : (id ? '已删除穿搭' : '')
  },

  // WXML 不支持方法调用，分类过滤 + 选中态在此预计算
  syncSelected() {
    const { items, activeCategory, selectedIds } = this.data
    const filtered = activeCategory === '全部' ? items
      : activeCategory === '已选' ? items.filter(item => selectedIds.includes(item._id))
      : items.filter(item => item.category === activeCategory)
    this.setData({ viewItems: filtered.map(item => ({ ...item, selected: selectedIds.includes(item._id) })) })
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.value
    if (!this.data.categories.includes(category)) return
    this.setData({ activeCategory: category })
    this.syncSelected()
  },

  onItemToggle(e) {
    const id = e.currentTarget.dataset.id
    const selected = this.data.selectedIds.slice()
    const index = selected.indexOf(id)
    if (index >= 0) selected.splice(index, 1)
    else selected.push(id)
    this.setData({ selectedIds: selected })
    this.syncSelected()
  },

  openPicker(e) {
    const target = e.currentTarget.dataset.target
    if (target === 'outfit') {
      const names = ['不选穿搭', ...(this.data.outfits || []).map(outfit => outfit.name || '未命名')]
      const index = this.data.outfitId ? this.data.outfits.findIndex(outfit => outfit._id === this.data.outfitId) + 1 : 0
      this.setData({ picker: { show: true, target, title: '选择穿搭（可选）', columns: [names], values: [Math.max(index, 0)] } })
      return
    }
    this.setData({ picker: { show: true, target: 'date', title: '日期', ...this.buildDateColumns(this.data.date) } })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const values = e.detail.values
    const patch = { 'picker.show': false }
    if (picker.target === 'outfit') {
      if (values[0] <= 0) {
        patch.outfitId = ''
        patch.outfitName = ''
      } else {
        const outfit = this.data.outfits[values[0] - 1]
        patch.outfitId = outfit._id
        patch.outfitName = outfit.name || '未命名'
        // 选了穿搭自动带出其单品，可再增删
        patch.selectedIds = (outfit.itemIds || []).slice()
      }
    } else if (picker.target === 'date') {
      patch.date = `${picker.columns[0][values[0]]}-${picker.columns[1][values[1]]}-${picker.columns[2][values[2]]}`
    }
    this.setData(patch)
    if (picker.target === 'outfit') this.syncSelected()
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },

  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  async onSave() {
    const { id, date, selectedIds, outfitId, note, saving } = this.data
    if (saving || !this.data.ready) return
    if (!selectedIds.length) {
      wx.showToast({ title: '请选择穿过的衣物', icon: 'none' })
      return
    }
    if (!validDate(date)) {
      wx.showToast({ title: '请选择有效日期', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    try {
      const data = { date, itemIds: selectedIds, outfitId, note: note.trim() }
      const result = id ? await db.updateWearRecord(id, data) : await db.addWearRecord(data)
      wx.hideLoading()
      wx.showToast({ title: result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  onDelete() {
    if (!this.data.ready || this.data.saving) return
    wx.showModal({
      title: '删除穿着记录',
      content: '确定删除这条穿着记录吗？',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm || this.data.saving) return
        this.setData({ saving: true })
        wx.showLoading({ title: '删除中…' })
        try {
          await db.deleteWearRecord(this.data.id)
          wx.hideLoading()
          wx.showToast({ title: '已删除' })
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
