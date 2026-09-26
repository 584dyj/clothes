const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')

// 月历：开销（衣物购买 + 独立账本，可按 全部/衣物/账本 分段统计）+
// 穿搭计划与实穿记录叠加展示。数据在客户端内存过滤，与既有口径一致。

const { validDate } = require('../../utils/date')
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const SEGMENTS = [
  { value: 'all', label: '全部' },
  { value: 'clothes', label: '衣物' },
  { value: 'expenses', label: '账本' }
]

Page({
  ...swipeBack,

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
    weekLabels: WEEK_LABELS,
    segments: SEGMENTS,
    segment: 'all',          // 开销统计口径：all/clothes/expenses
    year: 0,
    month: 0,                // 1-12
    title: '',               // 如「2026年8月」
    selectedDate: '',
    dayItems: [],
    dayExpenses: [],
    dayPlans: [],
    dayWears: [],
    selectedTotal: 0,
    undatedTotal: 0,
    canPrev: true,
    canNext: true,
    cells: [],               // [{ day, date, total, isToday, hasPlan, hasWorn }]，day 为 0 表示补位空格
    monthTotal: 0,
    yearTotal: 0,
    todayTotal: 0,           // 今日消费
    todayLabel: '',          // 如「8月24日」
    picker: { show: false, title: '', columns: [], values: [], target: '' },  // 年月滚轮
    loading: true
  },

  onLoad() {
    const now = new Date()
    this._year = now.getFullYear()
    this._month = now.getMonth() + 1
  },

  async onShow() {
    if (!this._year) return
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    await this.loadData()
  },

  async loadData(force = false) {
    this.setData({ loadError: '' })
    try {
      const [items, expenses, plans, wears, outfits] = await Promise.all([
        db.listItems(force), db.listExpenses(force), db.listPlans(force),
        db.listWearRecords(force), db.listOutfits(force)
      ])
      this._items = items
      this._expenses = expenses
      this._plans = plans
      this._wears = wears
      this._outfits = outfits
      this.setData({ loading: false })
      this.render()
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '加载失败，请重试' })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  outfitNameOf(id) {
    const outfit = (this._outfits || []).find(row => row._id === id)
    return outfit ? (outfit.name || '未命名') : (id ? '已删除穿搭' : '')
  },

  // 渲染当前年月
  render() {
    const { _year: year, _month: month, _items, _expenses, _plans, _wears } = this
    const segment = this.data.segment
    // 每日开销映射：'YYYY-MM-DD' -> 总金额（按分段口径）
    const dayTotal = {}
    let monthTotal = 0
    let yearTotal = 0
    let undatedTotal = 0
    const pad = n => String(n).padStart(2, '0')
    if (segment !== 'expenses') {
      _items.forEach(item => {
        const date = item.purchaseDate || ''
        const price = Math.round(Number(item.price) * 100)
        if (!Number.isFinite(price) || price <= 0) return
        if (!validDate(date)) { undatedTotal += price; return }
        const [y, m] = date.split('-').map(Number)
        dayTotal[date] = (dayTotal[date] || 0) + price
        if (y === year && m === month) monthTotal += price
        if (y === year) yearTotal += price
      })
    }
    if (segment !== 'clothes') {
      // 账本开销：日期与金额由云端强校验，直接按日期并入合计
      ;(_expenses || []).forEach(expense => {
        const amount = Math.round(Number(expense.amount) * 100)
        if (!Number.isFinite(amount) || amount <= 0 || !validDate(expense.date)) return
        const [y, m] = expense.date.split('-').map(Number)
        dayTotal[expense.date] = (dayTotal[expense.date] || 0) + amount
        if (y === year && m === month) monthTotal += amount
        if (y === year) yearTotal += amount
      })
    }
    // 计划与实穿标记（与开销分段无关）
    const planDates = {}
    const wornDates = {}
    ;(_plans || []).forEach(plan => { if (validDate(plan.date)) planDates[plan.date] = true })
    ;(_wears || []).forEach(wear => { if (validDate(wear.date)) wornDates[wear.date] = true })

    const firstDay = new Date(year, month - 1, 1).getDay() // 当月1号是周几（0=周日）
    const daysInMonth = new Date(year, month, 0).getDate()
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

    const cells = []
    for (let i = 0; i < firstDay; i++) cells.push({ day: 0 })
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${pad(month)}-${pad(d)}`
      cells.push({
        day: d,
        date,
        total: (dayTotal[date] || 0) / 100,
        isToday: date === todayStr,
        hasPlan: !!planDates[date],
        hasWorn: !!wornDates[date]
      })
    }

    this.setData({
      year,
      month,
      title: `${year}年${month}月`,
      cells,
      monthTotal: monthTotal / 100,
      undatedTotal: undatedTotal / 100,
      canPrev: year > 2022 || month > 1,
      canNext: year < today.getFullYear() + 1 || month < 12,
      yearTotal: yearTotal / 100,
      todayTotal: (dayTotal[todayStr] || 0) / 100,
      todayLabel: `${today.getMonth() + 1}月${today.getDate()}日`
    })
    const prefix = `${year}-${pad(month)}-`
    const selected = this.data.selectedDate.startsWith(prefix) ? this.data.selectedDate : todayStr.startsWith(prefix) ? todayStr : prefix + '01'
    this.selectDate(selected)
  },

  selectDate(date) {
    if (!validDate(date)) return
    const segment = this.data.segment
    const dayItems = segment !== 'expenses'
      ? (this._items || []).filter(item => item.purchaseDate === date && Number.isFinite(Number(item.price)) && Number(item.price) > 0)
        .map(item => ({ ...item, price: Math.round(Number(item.price) * 100) / 100 }))
      : []
    const dayExpenses = segment !== 'clothes'
      ? (this._expenses || []).filter(expense => expense.date === date && Number(expense.amount) > 0)
        .map(expense => ({ ...expense, amount: Math.round(Number(expense.amount) * 100) / 100 }))
      : []
    const dayPlans = (this._plans || []).filter(plan => plan.date === date)
      .map(plan => ({ ...plan, outfitName: this.outfitNameOf(plan.outfitId) }))
    const dayWears = (this._wears || []).filter(wear => wear.date === date)
      .map(wear => ({ ...wear, outfitName: this.outfitNameOf(wear.outfitId), itemCount: (wear.itemIds || []).length }))
    const cents = dayItems.reduce((total, item) => total + Math.round(item.price * 100), 0) +
      dayExpenses.reduce((total, expense) => total + Math.round(expense.amount * 100), 0)
    this.setData({ selectedDate: date, dayItems, dayExpenses, dayPlans, dayWears, selectedTotal: cents / 100 })
  },

  onSegmentTap(e) {
    const segment = e.currentTarget.dataset.value
    if (!['all', 'clothes', 'expenses'].includes(segment) || segment === this.data.segment) return
    this.setData({ segment })
    this.render()
  },

  onDayTap(e) { this.selectDate(e.currentTarget.dataset.date) },

  onItemTap(e) {
    wx.navigateTo({ url: '/pages/item-edit/item-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) })
  },

  onExpenseTap(e) {
    wx.navigateTo({ url: '/pages/expense-edit/expense-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) })
  },

  onPlanTap(e) {
    wx.navigateTo({ url: '/pages/plan-edit/plan-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) })
  },

  onWearTap(e) {
    wx.navigateTo({ url: '/pages/wear-edit/wear-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) })
  },

  // 给当前选中日期记一笔账本开销
  onAddExpense() {
    if (!validDate(this.data.selectedDate)) return
    wx.navigateTo({ url: '/pages/expense-edit/expense-edit?date=' + this.data.selectedDate })
  },

  onAddPlan() {
    if (!validDate(this.data.selectedDate)) return
    wx.navigateTo({ url: '/pages/plan-edit/plan-edit?date=' + this.data.selectedDate })
  },

  onAddWear() {
    if (!validDate(this.data.selectedDate)) return
    wx.navigateTo({ url: '/pages/wear-edit/wear-edit?date=' + this.data.selectedDate })
  },

  // ---------- 快速切换年月（滚轮选择器） ----------
  openPicker() {
    const currentYear = new Date().getFullYear()
    // 年份范围：2022 年至当前年份的下一年
    const years = []
    for (let y = 2022; y <= currentYear + 1; y++) years.push(String(y))
    const months = []
    for (let m = 1; m <= 12; m++) months.push(String(m).padStart(2, '0'))
    this.setData({
      picker: {
        show: true,
        title: '选择年月',
        target: 'ym',
        columns: [years, months],
        values: [years.indexOf(String(this._year)), this._month - 1]
      }
    })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const values = e.detail.values
    this._year = Number(picker.columns[0][values[0]])
    this._month = Number(picker.columns[1][values[1]])
    this.setData({ 'picker.show': false })
    this.render()
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },

  onPrevMonth() {
    if (!this.data.canPrev) return
    this._month -= 1
    if (this._month < 1) {
      this._month = 12
      this._year -= 1
    }
    this.render()
  },

  onNextMonth() {
    if (!this.data.canNext) return
    this._month += 1
    if (this._month > 12) {
      this._month = 1
      this._year += 1
    }
    this.render()
  }
})
