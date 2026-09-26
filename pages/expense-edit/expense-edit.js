const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const { validDate } = require('../../utils/date')
const datePicker = require('../../utils/date-picker')
const app = getApp()

// 独立账本编辑：记录不挂在衣物上的开销（洗护、修改等），也可关联某件衣物。
Page({
  ...swipeBack,
  ...focusPlaceholder,
  ...datePicker,

  data: {
    id: '',                 // 为空表示新增
    category: '',
    categories: [],
    amount: '',
    date: '',
    itemId: '',             // 关联衣物，可空
    itemName: '',
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
    this.setData({ categories: app.globalData.expenseCategories })
    try {
      this._items = await db.listItems()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '衣物列表加载失败，请重试' })
      return
    }
    if (options.id) {
      this.setData({ id: options.id })
      wx.setNavigationBarTitle({ title: '编辑开销' })
      return this.loadExpense(options.id)
    }
    // 新增：默认今天；从月历进入时带出选中日期
    const date = validDate(options.date) ? options.date : this.today()
    this.setData({ ready: true, loading: false, date })
  },

  today() {
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  },

  onRetry() { return this.onLoad(this._options || {}) },

  async loadExpense(id) {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const expenses = await db.listExpenses()
      const expense = expenses.find(row => row._id === id)
      if (!expense) throw new Error('记录不存在')
      this.setData({
        ready: true, loading: false, loadError: '',
        category: expense.category || '',
        amount: expense.amount != null ? String(expense.amount) : '',
        date: expense.date || '',
        itemId: expense.itemId || '',
        itemName: this.itemNameOf(expense.itemId),
        note: expense.note || ''
      })
    } catch (e) {
      console.error(e)
      this.setData({ ready: false, loading: false, loadError: '记录加载失败，请重试' })
    }
  },

  itemNameOf(itemId) {
    const item = (this._items || []).find(row => row._id === itemId)
    return item ? item.name || '未命名' : ''
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.value
    if (this.data.categories.includes(category)) this.setData({ category })
  },

  onAmountInput(e) { this.setData({ amount: e.detail.value }) },
  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  openPicker(e) {
    const target = e.currentTarget.dataset.target
    if (target === 'item') {
      const names = ['不关联', ...(this._items || []).map(item => item.name || '未命名')]
      const index = this.data.itemId ? (this._items || []).findIndex(item => item._id === this.data.itemId) + 1 : 0
      this.setData({ picker: { show: true, target, title: '关联衣物（可选）', columns: [names], values: [Math.max(index, 0)] } })
      return
    }
    this.setData({ picker: { show: true, target: 'date', title: '日期', ...this.buildDateColumns(this.data.date) } })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const values = e.detail.values
    const patch = { 'picker.show': false }
    if (picker.target === 'item') {
      const index = values[0]
      if (index <= 0) {
        patch.itemId = ''
        patch.itemName = ''
      } else {
        const item = this._items[index - 1]
        patch.itemId = item._id
        patch.itemName = item.name || '未命名'
      }
    } else if (picker.target === 'date') {
      patch.date = `${picker.columns[0][values[0]]}-${picker.columns[1][values[1]]}-${picker.columns[2][values[2]]}`
    }
    this.setData(patch)
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },

  async onSave() {
    const { id, category, amount, date, itemId, note, saving } = this.data
    if (saving || !this.data.ready) return
    if (!category) {
      wx.showToast({ title: '请选择分类', icon: 'none' })
      return
    }
    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' })
      return
    }
    if (!validDate(date)) {
      wx.showToast({ title: '请选择有效日期', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    try {
      const data = { category, amount: numericAmount, date, itemId, note: note.trim() }
      const result = id ? await db.updateExpense(id, data) : await db.addExpense(data)
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
      title: '删除开销',
      content: '确定要删除这条开销记录吗？',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm || this.data.saving) return
        this.setData({ saving: true })
        wx.showLoading({ title: '删除中…' })
        try {
          await db.deleteExpense(this.data.id)
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
