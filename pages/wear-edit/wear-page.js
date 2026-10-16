const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const { validDate } = require('../../utils/date')
const datePicker = require('../../utils/date-picker')
const HISTORY_PAGE_SIZE = 20
const QUICK_PICK_DAYS = 14
const HISTORY_ANIMATION_MS = 300
const sortRecords = records => records.slice().sort((a, b) =>
  String(b.date || '').localeCompare(String(a.date || '')) ||
  ((Number(new Date(b.createdAt)) || 0) - (Number(new Date(a.createdAt)) || 0)))
const sameItems = (a, b) => {
  const left = new Set(a || []), right = new Set(b || [])
  return left.size === right.size && [...left].every(id => right.has(id))
}
// 日期摘要条文案：今天显示「今天（M月D日）」，其余显示 YYYY-MM-DD
const dateTextOf = (date, today) => {
  if (!date) return ''
  if (date !== today) return date
  const [, m, d] = date.split('-')
  return `今天（${Number(m)}月${Number(d)}日）`
}

// 今日穿着与历史共用这一页的选品和保存逻辑。
module.exports = function createWearPage({ db, auth, app, wx, returnAfterSave = false, schedule = setTimeout, cancelSchedule = clearTimeout }) {
  return {
  ...swipeBack,
  ...focusPlaceholder,
  ...datePicker,

  data: {
    id: '',                 // 为空表示新增
    date: '',
    dateText: '',           // 日期摘要条展示文案
    items: [],
    viewItems: [],          // 当前分类过滤 + 选中态预计算
    categories: [],
    activeCategory: '全部',
    selectedIds: [],
    outfits: [],
    outfitId: '',
    outfitName: '',
    note: '',
    historyEnabled: !returnAfterSave,
    historyEditing: false,
    historyClosing: false,
    history: [],
    hasMoreHistory: false,
    historyError: '',
    missingCount: 0,
    recentlyAdded: [],
    quickPicks: [],
    refreshingItems: false,
    itemRefreshError: '',
    outfitSyncPending: false,
    outfitSyncError: '',
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
    const date = validDate(options.date) && options.date <= this.today() ? options.date : this.today()
    this.setData({
      id: options.id || '',
      date,
      dateText: dateTextOf(date, this.today()),
      categories: ['全部', '已选', ...app.globalData.categories]
    })
    wx.setNavigationBarTitle({ title: options.id ? '编辑穿着' : returnAfterSave ? '记录穿着' : '实穿记录' })
    return this.loadBase(options.id || '')
  },

  today() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  },

  onRetry() { return this.onLoad(this._options || {}) },

  onUnload() {
    this._unloaded = true
    cancelSchedule(this._historyCloseTimer)
    this._historyCloseTimer = null
  },

  async onShow() {
    if (this._returningFromItemEdit) {
      this._returningFromItemEdit = false
      return this.refreshItemsAfterQuickAdd()
    }
    if (this._returningFromOutfitEdit) {
      this._returningFromOutfitEdit = false
      return this.refreshAfterOutfitEdit()
    }
  },

  async refreshAfterOutfitEdit() {
    const id = this.data.id
    const revision = this._draftRevision || 0
    if (!id) return
    this.setData({ outfitSyncPending: true, outfitSyncError: '' })
    try {
      const [record, outfits] = await Promise.all([db.getWearRecord(id), db.listOutfits(true)])
      if (id !== this.data.id || revision !== (this._draftRevision || 0)) return
      this.setData({
        date: record.date, dateText: dateTextOf(record.date, this.today()),
        selectedIds: (record.itemIds || []).slice(), note: record.note || '',
        outfitId: record.outfitId || '', outfitName: this.outfitNameOf(outfits, record.outfitId),
        outfits, outfitSyncPending: false
      })
      this.syncSelected()
      await this.refreshHistory()
    } catch (e) {
      if (id !== this.data.id || revision !== (this._draftRevision || 0)) return
      console.error(e)
      this.setData({ outfitSyncPending: false, outfitSyncError: '穿搭状态刷新失败，点此重试' })
    }
  },

  onQuickAddTap() {
    if (!this.data.historyEnabled || !this.data.ready || this.data.saving || this.data.historyClosing || this.data.refreshingItems) return
    this._itemIdsBeforeQuickAdd = new Set(this.data.items.map(item => item._id))
    this._quickAddRevision = this._draftRevision || 0
    this._returningFromItemEdit = true
    wx.navigateTo({
      url: '/pages/item-edit/item-edit',
      fail: () => {
        this._returningFromItemEdit = false
        wx.showToast({ title: '无法打开入库页', icon: 'none' })
      }
    })
  },

  async refreshItemsAfterQuickAdd() {
    if (this.data.refreshingItems) return
    const before = this._itemIdsBeforeQuickAdd || new Set(this.data.items.map(item => item._id))
    this.setData({ refreshingItems: true, itemRefreshError: '' })
    try {
      const items = await db.listItems(true)
      this._items = items
      this.setData({ items, refreshingItems: false,
        recentlyAdded: (this._draftRevision || 0) === this._quickAddRevision
          ? items.filter(item => !before.has(item._id)).slice(0, 9) : [] })
      this.buildQuickPicks()
      this.syncSelected()
      this.showHistory(Math.max(this.data.history.length, HISTORY_PAGE_SIZE))
    } catch (e) {
      console.error(e)
      this.setData({ refreshingItems: false, itemRefreshError: '衣橱刷新失败，点此重试' })
    }
  },

  async loadBase(recordId = '') {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const [items, outfits, records] = await Promise.all([
        db.listItems(), db.listOutfits(), recordId || !returnAfterSave ? db.listWearRecords() : []
      ])
      const record = recordId ? records.find(row => row._id === recordId) : null
      if (recordId && !record) throw new Error('记录不存在')
      this._items = items
      this._records = sortRecords(records)
      const date = record ? record.date || '' : this.data.date
      this.setData({
        items, outfits, ready: true, loading: false,
        selectedIds: record ? (record.itemIds || []).slice() : [],
        outfitId: record ? record.outfitId || '' : '',
        outfitName: record ? this.outfitNameOf(outfits, record.outfitId) : '',
        note: record ? record.note || '' : '',
        date,
        dateText: dateTextOf(date, this.today()),
        historyError: ''
      })
      if (!returnAfterSave) this.showHistory(HISTORY_PAGE_SIZE)
      this.buildQuickPicks()
      this.syncSelected()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '衣物或穿着记录加载失败，请重试' })
    }
  },

  loadRecord(id) {
    this.setData({ id })
    return this.loadBase(id)
  },

  showHistory(count) {
    const records = this._records || []
    const itemMap = Object.fromEntries((this._items || []).map(item => [item._id, item]))
    this.setData({
      history: records.slice(0, count).map(record => {
        const ids = record.itemIds || []
        const items = ids.map(id => itemMap[id]).filter(Boolean)
        return { ...record, itemCount: ids.length, itemNames: ids.map(id => itemMap[id] ? itemMap[id].name || '未命名' : '已删除衣物').join('、') || '无衣物',
          thumbs: items.filter(item => item.imageFileID).slice(0, 3), future: record.date > this.today() }
      }),
      hasMoreHistory: records.length > count
    })
  },

  onMoreHistory() { this.showHistory(this.data.history.length + HISTORY_PAGE_SIZE) },

  onPageScroll(e) {
    if (!this.data.historyEditing) this._pageScrollTop = e.scrollTop
  },

  async refreshHistory() {
    try {
      this._records = sortRecords(await db.listWearRecords(true))
      this.showHistory(Math.max(this.data.history.length, HISTORY_PAGE_SIZE))
      this.setData({ historyError: '' })
      this.buildQuickPicks()
    } catch (e) {
      console.error(e)
      this.setData({ historyError: '历史刷新失败，请重试' })
    }
  },

  onHistoryTap(e) {
    if (!this.data.ready || this.data.saving || this.data.historyClosing || this.data.refreshingItems || this.data.outfitSyncPending) return
    const record = (this._records || []).find(row => row._id === e.currentTarget.dataset.id)
    if (!record) return
    if (!this.data.historyEditing) {
      this._historyScrollTop = this._pageScrollTop || 0
      const { id, date, dateText, selectedIds, outfitId, outfitName, note, activeCategory, recentlyAdded, outfitSyncError } = this.data
      this._historyDraft = { id, date, dateText, selectedIds: selectedIds.slice(), outfitId, outfitName, note,
        activeCategory, recentlyAdded: recentlyAdded.slice(), outfitSyncError }
    }
    this._draftRevision = (this._draftRevision || 0) + 1
    this.setData({
      historyEditing: true, 'picker.show': false, _focus: {},
      id: record._id, date: record.date || '', dateText: dateTextOf(record.date || '', this.today()),
      selectedIds: (record.itemIds || []).slice(),
      outfitId: record.outfitId || '', outfitName: this.outfitNameOf(this.data.outfits, record.outfitId),
      note: record.note || '', activeCategory: '已选', recentlyAdded: [],
      outfitSyncPending: false, outfitSyncError: ''
    })
    this.syncSelected()
  },

  onCancelHistoryEdit() {
    if (!this.data.historyEditing || this.data.saving || this.data.historyClosing) return
    this._draftRevision = (this._draftRevision || 0) + 1
    this.setData({ historyClosing: true, 'picker.show': false, _focus: {} }, () => {
      if (this._unloaded) return
      this._historyCloseTimer = schedule(() => {
        this._historyCloseTimer = null
        this.setData({ ...this._historyDraft, historyEditing: false, historyClosing: false, outfitSyncPending: false },
          () => { if (!this._unloaded) wx.pageScrollTo({ scrollTop: this._historyScrollTop, duration: 0 }) })
        this._historyDraft = null
        this.syncSelected()
      }, HISTORY_ANIMATION_MS)
    })
  },

  onHistoryEditTouch() {},

  onSwipeBackStart(e) {
    if (this.data.historyEditing) {
      this._swipeBackStart = null
      return
    }
    swipeBack.onSwipeBackStart.call(this, e)
  },

  onSwipeBackEnd(e) {
    if (!this.data.historyEditing) swipeBack.onSwipeBackEnd.call(this, e)
  },

  onResetTap() {
    if (this.data.historyEditing) return this.onCancelHistoryEdit()
    this._draftRevision = (this._draftRevision || 0) + 1
    const today = this.today()
    this.setData({ id: '', date: today, dateText: dateTextOf(today, today), selectedIds: [], outfitId: '', outfitName: '', note: '', activeCategory: '全部', recentlyAdded: [],
      outfitSyncPending: false, outfitSyncError: '' })
    this.syncSelected()
    wx.setNavigationBarTitle({ title: returnAfterSave ? '记录穿着' : '实穿记录' })
  },

  onLastWearTap() {
    const available = new Set(this.data.items.map(item => item._id))
    const record = (this._records || []).find(row => validDate(row.date) && row.date <= this.today() &&
      (row.itemIds || []).some(id => available.has(id)))
    if (!record) return wx.showToast({ title: '暂无可带入的实穿记录', icon: 'none' })
    this.setData({ selectedIds: [...new Set(record.itemIds.filter(id => available.has(id)))], outfitId: '', outfitName: '' })
    this.syncSelected()
  },

  outfitNameOf(outfits, id) {
    const outfit = outfits.find(row => row._id === id)
    return outfit ? (outfit.name || '未命名') : (id ? '已删除穿搭' : '')
  },

  // WXML 不支持方法调用，分类过滤 + 选中态在此预计算
  syncSelected() {
    const { items, activeCategory, selectedIds } = this.data
    const available = new Set(items.map(item => item._id))
    const filtered = activeCategory === '全部' ? items
      : activeCategory === '已选' ? items.filter(item => selectedIds.includes(item._id))
      : items.filter(item => item.category === activeCategory)
    this.setData({ viewItems: filtered.map(item => ({ ...item, selected: selectedIds.includes(item._id) })),
      recentlyAdded: this.data.recentlyAdded.map(item => ({ ...item, selected: selectedIds.includes(item._id) })),
      quickPicks: this.data.quickPicks.map(item => ({ ...item, selected: selectedIds.includes(item._id) })),
      missingCount: selectedIds.filter(id => !available.has(id)).length })
  },

  // 常穿：近 QUICK_PICK_DAYS 天穿着次数降序，取前 10 件在库衣物；同一记录内同一衣物只计一次，删失与窗口外记录不计
  buildQuickPicks() {
    const items = this._items || []
    const inStock = new Set(items.map(item => item._id))
    const today = this.today()
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - QUICK_PICK_DAYS * 86400000).toISOString().slice(0, 10)
    const stats = new Map()
    for (const record of this._records || []) {
      const date = record.date
      if (!validDate(date) || date < cutoff || date > today) continue
      for (const id of new Set(record.itemIds || [])) {
        if (!inStock.has(id)) continue
        const entry = stats.get(id) || { count: 0, last: '' }
        entry.count += 1
        if (date > entry.last) entry.last = date
        stats.set(id, entry)
      }
    }
    const selected = new Set(this.data.selectedIds || [])
    const picks = items
      .filter(item => stats.has(item._id))
      .sort((a, b) => stats.get(b._id).count - stats.get(a._id).count ||
        stats.get(b._id).last.localeCompare(stats.get(a._id).last))
      .slice(0, 10)
      .map(item => ({ _id: item._id, name: item.name, count: stats.get(item._id).count, selected: selected.has(item._id) }))
    this.setData({ quickPicks: picks })
  },

  onRemoveMissing() {
    const available = new Set(this.data.items.map(item => item._id))
    this.setData({ selectedIds: this.data.selectedIds.filter(id => available.has(id)), outfitId: '', outfitName: '' })
    this.syncSelected()
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.value
    if (!this.data.categories.includes(category)) return
    this.setData({ activeCategory: category })
    this.syncSelected()
  },

  onItemToggle(e) {
    if (this.data.saving) return
    const id = e.currentTarget.dataset.id
    if (!this.data.items.some(item => item._id === id)) return
    const selected = this.data.selectedIds.slice()
    const index = selected.indexOf(id)
    if (index >= 0) selected.splice(index, 1)
    else selected.push(id)
    this.setData({ selectedIds: selected, outfitId: '', outfitName: '' })
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
    this.setData({ picker: { show: true, target: 'date', title: '日期', ...this.buildDateColumns(this.data.date, this.today()) } })
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
        const available = new Set(this.data.items.map(item => item._id))
        patch.selectedIds = [...new Set((outfit.itemIds || []).filter(id => available.has(id)))]
        patch.outfitId = patch.selectedIds.length === (outfit.itemIds || []).length ? outfit._id : ''
        patch.outfitName = patch.outfitId ? outfit.name || '未命名' : ''
      }
    } else if (picker.target === 'date') {
      const date = `${picker.columns[0][values[0]]}-${picker.columns[1][values[1]]}-${picker.columns[2][values[2]]}`
      if (validDate(date) && date <= this.today()) {
        patch.date = date
        patch.dateText = dateTextOf(date, this.today())
      }
    }
    this.setData(patch)
    if (picker.target === 'outfit') this.syncSelected()
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },

  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  onSave() { return this.saveWear(false) },

  onSaveAsOutfit() { return this.saveWear(true) },

  async saveWear(saveAsOutfit) {
    const { id, date, selectedIds, outfitId, note, saving } = this.data
    if (saving || this.data.historyClosing || !this.data.ready) return
    if (this.data.outfitSyncPending || this.data.outfitSyncError) {
      wx.showToast({ title: '请先刷新穿搭状态', icon: 'none' })
      return
    }
    if (!selectedIds.length) {
      wx.showToast({ title: '请选择穿过的衣物', icon: 'none' })
      return
    }
    if (this.data.missingCount) {
      wx.showToast({ title: '请先移除已删除衣物', icon: 'none' })
      return
    }
    if (!validDate(date)) {
      wx.showToast({ title: '请选择有效日期', icon: 'none' })
      return
    }
    if (date > this.today()) {
      wx.showToast({ title: '不能记录未来日期', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    try {
      const outfit = this.data.outfits.find(row => row._id === outfitId)
      const linked = outfit && sameItems(outfit.itemIds, selectedIds)
      const data = { date, itemIds: selectedIds, outfitId: linked ? outfitId : '', note: note.trim() }
      const result = id ? await db.updateWearRecord(id, data) : await db.addWearRecord(data)
      const wearId = id || result
      wx.hideLoading()
      if (returnAfterSave) {
        wx.showToast({ title: result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
        schedule(() => wx.navigateBack(), 500)
        return
      }
      if (saveAsOutfit) {
        this.setData({ id: wearId, outfitId: data.outfitId,
          outfitName: data.outfitId ? this.outfitNameOf(this.data.outfits, data.outfitId) : '' })
        if (!this.data.historyEditing) wx.setNavigationBarTitle({ title: '编辑穿着' })
        wx.showLoading({ title: '检查已有穿搭…' })
        await this.refreshHistory()
        await this.startOutfitSave(wearId, selectedIds)
        return
      }
      wx.showToast({ title: result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
      this.setData({ saving: false })
      this.onResetTap()
      await this.refreshHistory()
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: /相同衣物组合/.test(e.message || '') ? '同日组合已记录' : '保存失败', icon: 'none' })
    }
  },

  async startOutfitSave(wearId, itemIds) {
    try {
      const outfits = await db.listOutfits(true)
      this.setData({ outfits })
      wx.hideLoading()
      const existing = outfits.find(outfit => sameItems(outfit.itemIds, itemIds))
      if (existing) {
        const choice = await new Promise(resolve => wx.showActionSheet({
          itemList: [`关联已有「${existing.name || '未命名'}」`, '继续新建穿搭'],
          success: res => resolve(res.tapIndex),
          fail: () => resolve(-1)
        }))
        if (choice === 0) {
          await db.linkWearOutfit(wearId, existing._id)
          this.setData({ outfitId: existing._id, outfitName: existing.name || '未命名' })
          await this.refreshHistory()
          wx.showToast({ title: '已关联收藏穿搭', icon: 'none' })
          return
        }
        if (choice !== 1) {
          wx.showToast({ title: '实穿已保存', icon: 'none' })
          return
        }
      }
      this._returningFromOutfitEdit = true
      wx.navigateTo({
        url: `/pages/outfit-edit/outfit-edit?wearRecordId=${encodeURIComponent(wearId)}`,
        fail: () => {
          this._returningFromOutfitEdit = false
          wx.showToast({ title: '无法打开穿搭编辑页', icon: 'none' })
        }
      })
    } catch (e) {
      console.error(e)
      wx.hideLoading()
      wx.showToast({ title: '实穿已保存，穿搭处理失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  onDelete() { this.confirmDelete(this.data.id) },

  onHistoryDelete(e) { this.confirmDelete(e.currentTarget.dataset.id) },

  confirmDelete(id) {
    if (!id || !this.data.ready || this.data.saving || this.data.historyClosing) return
    wx.showModal({
      title: '删除穿着记录',
      content: '确定删除这条穿着记录吗？',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm || this.data.saving || this.data.historyClosing) return
        this.setData({ saving: true })
        wx.showLoading({ title: '删除中…' })
        try {
          await db.deleteWearRecord(id)
          wx.hideLoading()
          wx.showToast({ title: '已删除' })
          if (returnAfterSave) {
            schedule(() => wx.navigateBack(), 500)
            return
          }
          this.setData({ saving: false })
          if (this._historyDraft && this._historyDraft.id === id) this._historyDraft.id = ''
          if (id === this.data.id) this.onResetTap()
          await this.refreshHistory()
        } catch (e) {
          console.error(e)
          wx.hideLoading()
          this.setData({ saving: false })
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
  }
}
