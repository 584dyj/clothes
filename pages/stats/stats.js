const db = require('../../utils/db')
const auth = require('../../utils/auth')

const app = getApp()

Page({
  async onRetry() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.loadStats(true)
  },

  async onPullDownRefresh() {
    try { await this.onRetry() } finally { wx.stopPullDownRefresh() }
  },

  data: {
    loadError: '',
    loading: true,
    totalItems: 0,
    totalOutfits: 0,
    totalBrands: 0,
    totalSpent: 0,
    categoryStats: [],   // [{ name, count, spent, percent }]
    brandStats: [],      // [{ name, count, percent }]
    seasonStats: [],     // [{ name, count }]
    expenseTotal: 0,     // 账本总开销
    expenseStats: [],    // [{ name, amount, percent }]，percent 基数为账本总额
    wearRank: [],        // 穿着频次 Top N [{ name, count }]
    idleRank: []         // 闲置榜 Top N [{ name, days }]（最近未穿的天数）
  },

  async onShow() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    return this.loadStats()
  },

  async loadStats(force = false) {
    this.setData({ loadError: '' })
    // 仅首次加载显示「加载中」；之后切 tab 命中缓存，静默刷新
    if (!this._loaded) this.setData({ loading: true })
    try {
      const [items, outfits, expenses, wearRecords] = await Promise.all([
        db.listItems(force), db.listOutfits(force), db.listExpenses(force), db.listWearRecords(force)
      ])
      this._loaded = true

      const totalItems = items.length
      const totalOutfits = outfits.length
      const totalBrands = new Set(items.map(item => (item.brand || '').trim()).filter(Boolean)).size
      const totalSpent = items.reduce((sum, item) => sum + (Number(item.price) || 0), 0)

      // 类别分布 + 分类花费（按全局类别顺序，空类别显示 0）
      const categoryStats = app.globalData.categories
        .map(name => {
          const inCategory = items.filter(item => item.category === name)
          const count = inCategory.length
          const spent = inCategory.reduce((sum, item) => sum + (Number(item.price) || 0), 0)
          return {
            name,
            count,
            spent: Math.round(spent * 100) / 100,
            percent: totalItems ? Math.round((count / totalItems) * 100) : 0
          }
        })

      // 季节分布（一件衣物可属多个季节）
      const seasonStats = app.globalData.seasons.map(name => ({
        name,
        count: items.filter(item => (item.seasons || []).includes(name)).length
      }))

      // 品牌分布（每个品牌的件数，占比基数为衣物总数）
      const brandCount = Object.create(null)
      items.forEach(item => {
        const brand = (item.brand || '').trim() || '无品牌'
        brandCount[brand] = (brandCount[brand] || 0) + 1
      })
      const brandStats = Object.keys(brandCount)
        .map(name => ({
          name,
          count: brandCount[name],
          percent: totalItems ? Math.round((brandCount[name] / totalItems) * 100) : 0
        }))
        .sort((a, b) => b.count - a.count)

      // 账本开销分布（按金额，展示全部分类，空分类显示 0）
      const expenseTotal = expenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0)
      const expenseStats = app.globalData.expenseCategories
        .map(name => {
          const amount = expenses.filter(expense => expense.category === name)
            .reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0)
          return {
            name,
            amount: Math.round(amount * 100) / 100,
            percent: expenseTotal ? Math.round((amount / expenseTotal) * 100) : 0
          }
        })
        .sort((a, b) => b.amount - a.amount)

      // 穿着频次与闲置：基于 wear_records（历史保留，删除的单品不计入展示）
      const wearCount = Object.create(null)
      const lastWorn = Object.create(null)
      wearRecords.forEach(record => {
        const date = record.date
        ;(record.itemIds || []).forEach(id => {
          wearCount[id] = (wearCount[id] || 0) + 1
          if (date && (!lastWorn[id] || date > lastWorn[id])) lastWorn[id] = date
        })
      })
      const pad = n => String(n).padStart(2, '0')
      const now = new Date()
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const wearRank = items.filter(item => wearCount[item._id])
        .map(item => ({ name: item.name || '未命名', count: wearCount[item._id] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
      // 一级其他只保留基础统计和手工记录，不进入闲置建议。
      const idleRank = items.filter(item => item.category !== '其他' && lastWorn[item._id])
        .map(item => {
          const last = lastWorn[item._id]
          const days = Math.max(0, Math.round((new Date(todayStr.replace(/-/g, '/')).getTime() - new Date(last.replace(/-/g, '/')).getTime()) / 86400000))
          return { name: item.name || '未命名', days }
        })
        .sort((a, b) => b.days - a.days)   // 闲置最久在前
        .slice(0, 8)

      this.setData({
        loading: false,
        totalItems,
        totalOutfits,
        totalBrands,
        totalSpent: Math.round(totalSpent * 100) / 100,
        categoryStats,
        brandStats,
        seasonStats,
        expenseTotal: Math.round(expenseTotal * 100) / 100,
        expenseStats,
        wearRank,
        idleRank
      })
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '加载失败，请重试' })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 进入月历页（查看月度/年度开销）
  onCalendarTap() {
    wx.navigateTo({ url: '/pages/calendar/calendar' })
  }
})
