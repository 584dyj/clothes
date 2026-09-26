const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const { validDate } = require('../../utils/date')
const datePicker = require('../../utils/date-picker')

// 穿搭计划：为某天安排一套穿搭（outfit_plans）。
Page({
  ...swipeBack,
  ...focusPlaceholder,
  ...datePicker,

  data: {
    id: '',                 // 为空表示新增
    date: '',
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
    this.setData({ id: options.id || '', date: validDate(options.date) ? options.date : this.today() })
    if (options.id) {
      wx.setNavigationBarTitle({ title: '编辑计划' })
      return this.loadPlan(options.id)
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
      const outfits = await db.listOutfits()
      this.setData({ outfits, ready: true, loading: false })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '穿搭列表加载失败，请重试' })
    }
  },

  async loadPlan(id) {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const [outfits, plans] = await Promise.all([db.listOutfits(), db.listPlans()])
      const plan = plans.find(row => row._id === id)
      if (!plan) throw new Error('计划不存在')
      this.setData({
        outfits,
        outfitId: plan.outfitId || '',
        outfitName: this.outfitNameOf(outfits, plan.outfitId),
        note: plan.note || '',
        date: plan.date || '',
        ready: true, loading: false
      })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '计划加载失败，请重试' })
    }
  },

  outfitNameOf(outfits, id) {
    const outfit = outfits.find(row => row._id === id)
    return outfit ? (outfit.name || '未命名') : (id ? '已删除穿搭' : '')
  },

  openPicker(e) {
    const target = e.currentTarget.dataset.target
    if (target === 'outfit') {
      const names = (this.data.outfits || []).map(outfit => outfit.name || '未命名')
      if (!names.length) {
        wx.showToast({ title: '还没有穿搭，请先去添加', icon: 'none' })
        return
      }
      const index = this.data.outfits.findIndex(outfit => outfit._id === this.data.outfitId)
      this.setData({ picker: { show: true, target, title: '选择穿搭', columns: [names], values: [Math.max(index, 0)] } })
      return
    }
    this.setData({ picker: { show: true, target: 'date', title: '日期', ...this.buildDateColumns(this.data.date) } })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const values = e.detail.values
    const patch = { 'picker.show': false }
    if (picker.target === 'outfit') {
      const outfit = this.data.outfits[values[0]]
      if (outfit) {
        patch.outfitId = outfit._id
        patch.outfitName = outfit.name || '未命名'
      }
    } else if (picker.target === 'date') {
      patch.date = `${picker.columns[0][values[0]]}-${picker.columns[1][values[1]]}-${picker.columns[2][values[2]]}`
    }
    this.setData(patch)
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },

  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  async onSave() {
    const { id, date, outfitId, note, saving } = this.data
    if (saving || !this.data.ready) return
    if (!outfitId) {
      wx.showToast({ title: '请选择穿搭', icon: 'none' })
      return
    }
    if (!validDate(date)) {
      wx.showToast({ title: '请选择有效日期', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    try {
      const data = { date, outfitId, note: note.trim() }
      const result = id ? await db.updatePlan(id, data) : await db.addPlan(data)
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
      title: '删除计划',
      content: '确定删除这条穿搭计划吗？',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm || this.data.saving) return
        this.setData({ saving: true })
        wx.showLoading({ title: '删除中…' })
        try {
          await db.deletePlan(this.data.id)
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
