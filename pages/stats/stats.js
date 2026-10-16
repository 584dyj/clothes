const db = require('../../utils/db')
const auth = require('../../utils/auth')
const { validDate } = require('../../utils/date')

const app = getApp()

// 云端日期（Date 或字符串）归一化为上海时区 YYYY-MM-DD，便于与截止日字符串比较。
function toDateString(value) {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// 拥有日期：优先合法购买日期，缺失或无效时回退入库时间；两者均不可用时无法判定已拥有满 90 天。
function ownershipDate(item) {
  if (validDate(item.purchaseDate)) return item.purchaseDate
  const date = toDateString(item.createdAt)
  return date && validDate(date) ? date : null
}

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
    outfitRank: [],      // 搭配频次 Top N [{ name, count }]（衣物出现在多少条搭配中）
    idleRank: [],        // 闲置榜 Top N [{ name }]（近 90 天未记录穿着或搭配）
    idleInsufficient: false  // 近 90 天无有效实穿且无新建搭配引用时，不判定闲置
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
      const todayStr = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const cutoffStr = new Date(Date.now() + 8 * 60 * 60 * 1000 - 90 * 86400000).toISOString().slice(0, 10)
      const miscIds = new Set(items.filter(item => item.category === '其他').map(item => item._id))
      wearRecords.forEach(record => {
        const date = record.date
        if (!validDate(date) || date > todayStr) return
        ;(record.itemIds || []).forEach(id => {
          wearCount[id] = (wearCount[id] || 0) + 1
        })
      })
      const wearRank = items.filter(item => wearCount[item._id])
        .map(item => ({ name: item.name || '未命名', count: wearCount[item._id] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
      // 搭配频次：每件衣物出现在多少条搭配中（同一搭配内重复引用只计一次），已删除单品不计入展示。
      const existingItemIds = new Set(items.map(item => item._id))
      const outfitCount = Object.create(null)
      outfits.forEach(outfit => {
        new Set(outfit.itemIds || []).forEach(id => {
          if (existingItemIds.has(id)) outfitCount[id] = (outfitCount[id] || 0) + 1
        })
      })
      const outfitRank = items.filter(item => outfitCount[item._id])
        .map(item => ({ name: item.name || '未命名', count: outfitCount[item._id] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
      // 统一闲置口径：近 90 天未记录穿着或搭配（与闲置月报 MATCH-06 同源）。一级其他仅作基础记录，不进入闲置建议。
      const validRecords = wearRecords
        .filter(record => validDate(record.date) && record.date <= todayStr)
        .map(record => ({ date: record.date, itemIds: (Array.isArray(record.itemIds) ? record.itemIds : []).filter(id => !miscIds.has(id)) }))
        .filter(record => record.itemIds.length > 0)
      // 搭配活动信号：createdAt 不早于截止日的搭配，其单品计入近期活动集合（截止日当天算近期）。
      const recentOutfitItems = new Set()
      outfits.forEach(outfit => {
        const created = toDateString(outfit.createdAt)
        if (!created || created < cutoffStr) return
        ;(outfit.itemIds || []).forEach(id => recentOutfitItems.add(id))
      })
      // 近 90 天无有效实穿且无新建搭配引用时，不判定闲置（与闲置月报 MATCH-06 同源）。
      const idleInsufficient = !validRecords.some(record => record.date >= cutoffStr) && recentOutfitItems.size === 0
      let idleRank = []
      if (!idleInsufficient) {
        const lastWorn = Object.create(null)
        validRecords.forEach(record => record.itemIds.forEach(id => {
          if (!lastWorn[id] || record.date > lastWorn[id]) lastWorn[id] = record.date
        }))
        idleRank = items.filter(item => item.category !== '其他')
          .map(item => {
            const owned = ownershipDate(item)
            if (!owned || owned > cutoffStr) return null
            if (recentOutfitItems.has(item._id)) return null
            const worn = lastWorn[item._id]
            if (worn && worn >= cutoffStr) return null
            return { name: item.name || '未命名', since: worn || owned }
          })
          .filter(Boolean)
          .sort((a, b) => a.since.localeCompare(b.since))
          .slice(0, 8)
          .map(({ name }) => ({ name }))
      }

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
        outfitRank,
        idleRank,
        idleInsufficient
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
  },

  // 进入实穿记录页（与「我的穿搭」页底入口一致）
  onWearRecordsTap() {
    wx.navigateTo({ url: '/pages/today-wear/today-wear' })
  }
})
