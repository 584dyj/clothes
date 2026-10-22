const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')
const { CATEGORIES } = require('../cloudfunctions/auth/categories')

const items = [{ _id: 'item-1', name: '白衬衫', category: '上衣' }]
const expenses = [
  { _id: 'exp-1', category: '洗护', amount: 39.9, date: '2026-09-20', itemId: 'item-1', note: '干洗' },
  { _id: 'exp-2', category: '服饰', amount: 60.1, date: '2026-09-20', itemId: '', note: '' }
]

function ledgerDb(overrides = {}) {
  return {
    listItems: async () => items,
    listExpenses: async () => expenses,
    addExpense: async () => 'new-id',
    updateExpense: async () => ({}),
    deleteExpense: async () => ({}),
    ...overrides
  }
}

// ---------- expense-edit 页面 ----------

test('账本新增带出传入日期，保存校验分类金额日期', async () => {
  const calls = []
  const page = loadPage('expense-edit', ledgerDb({ addExpense: async data => { calls.push(data); return 'new-id' } }))
  await page.onLoad({ date: '2026-09-20' })
  assert.equal(page.data.ready, true)
  assert.equal(page.data.date, '2026-09-20')

  await page.onSave()
  page.onCategoryTap({ currentTarget: { dataset: { value: '洗护' } } })
  await page.onSave()
  page.onAmountInput({ detail: { value: '-3' } })
  await page.onSave()
  assert.equal(calls.length, 0)

  page.onAmountInput({ detail: { value: '25.5' } })
  page.onNoteInput({ detail: { value: ' 改裤脚 ' } })
  await page.onSave()
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ category: '洗护', amount: 25.5, date: '2026-09-20', itemId: '', note: '改裤脚' }))
})

test('账本编辑加载已有记录并更新，加载失败禁止保存', async () => {
  const calls = []
  const page = loadPage('expense-edit', ledgerDb({ updateExpense: async (id, data) => { calls.push([id, data]); return {} } }))
  await page.onLoad({ id: 'exp-1' })
  assert.equal(page.data.category, '洗护')
  assert.equal(page.data.amount, '39.9')
  assert.equal(page.data.itemName, '白衬衫')
  await page.onSave()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'exp-1')

  const broken = loadPage('expense-edit', ledgerDb({ listExpenses: async () => { throw Error('offline') } }))
  await broken.onLoad({ id: 'exp-1' })
  assert.equal(broken.data.ready, false)
  assert.equal(broken.data.loadError, '记录加载失败，请重试')
  await broken.onSave()
})

test('账本删除经确认框执行', async () => {
  let deleted = ''
  const page = loadPage('expense-edit', ledgerDb({ deleteExpense: async id => { deleted = id } }), {
    showModal: opts => opts.success({ confirm: true })
  })
  await page.onLoad({ id: 'exp-2' })
  page.onDelete()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deleted, 'exp-2')
})

test('关联衣物滚轮可选择与不关联', async () => {
  const page = loadPage('expense-edit', ledgerDb())
  await page.onLoad({})
  page.openPicker({ currentTarget: { dataset: { target: 'item' } } })
  assert.equal(page.data.picker.columns[0].join(','), '不关联,白衬衫')
  page.onPickerConfirm({ detail: { values: [1] } })
  assert.equal(page.data.itemId, 'item-1')
  assert.equal(page.data.itemName, '白衬衫')
  page.onPickerConfirm({ detail: { values: [0] } })
  assert.equal(page.data.itemId, '')
})

// ---------- calendar 月历合并账本 ----------

// 月历测试用当月日期，避免跨月后断言失效
const thisMonth = day => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

test('月历合计并入账本开销，日明细分衣物与账本', async () => {
  const navigations = []
  const day20 = thisMonth(20)
  const page = loadPage('calendar', {
    listItems: async () => [{ _id: 'item-1', name: '白衬衫', price: 100, purchaseDate: day20 }, { _id: 'item-2', name: '旧衣', price: 50, purchaseDate: '' }],
    listExpenses: async () => expenses.map(e => ({ ...e, date: day20 })),
    listPlans: async () => [],
    listWearRecords: async () => [],
    listOutfits: async () => []
  }, { navigateTo: ({ url }) => navigations.push(url), stopPullDownRefresh() {} })
  page.onLoad()
  await page.loadData()
  // 9 月合计 = 衣物 100 + 账本 39.9 + 60.1；无日期衣物计入未归集提示
  assert.equal(page.data.monthTotal, 200)
  assert.equal(page.data.yearTotal, 200)
  assert.equal(page.data.undatedTotal, 50)

  page.onDayTap({ currentTarget: { dataset: { date: day20 } } })
  assert.equal(page.data.dayItems.length, 1)
  assert.equal(page.data.dayExpenses.length, 2)
  assert.equal(page.data.selectedTotal, 200)

  page.onAddExpense()
  assert.equal(navigations[0], `/pages/expense-edit/expense-edit?date=${day20}`)
  page.onExpenseTap({ currentTarget: { dataset: { id: 'exp-1' } } })
  assert.equal(navigations[1], '/pages/expense-edit/expense-edit?id=exp-1')
})

test('月历账本加载失败显示错误可重试', async () => {
  const page = loadPage('calendar', {
    listItems: async () => [],
    listExpenses: async () => { throw Error('offline') },
    listPlans: async () => [],
    listWearRecords: async () => [],
    listOutfits: async () => []
  })
  page.onLoad()
  await page.loadData()
  assert.equal(page.data.loadError, '加载失败，请重试')
})

test('仅有贴纸购买的日期显示合计并关闭空态，心愿单不算记录', async () => {
  const purchasedAt = thisMonth(20)
  const wishDate = thisMonth(21)
  const page = loadPage('calendar', {
    listItems: async () => [], listExpenses: async () => [],
    listPlans: async () => [], listOutfits: async () => [],
    listStickers: async () => [
      { _id: 'owned', status: 'owned', price: 10, quantity: 2, purchasedAt },
      { _id: 'wish', status: 'wishlist', price: 999, quantity: 1, purchasedAt: wishDate }
    ]
  })
  page.onLoad()
  await page.loadData()
  page.onDayTap({ currentTarget: { dataset: { date: purchasedAt } } })
  assert.equal(page.data.selectedTotal, 20)
  assert.equal(page.data.hasDayRecords, true)
  assert.equal(page.data.dayItems.length + page.data.dayExpenses.length + page.data.dayPlans.length, 0)
  page.onDayTap({ currentTarget: { dataset: { date: wishDate } } })
  assert.equal(page.data.selectedTotal, 0)
  assert.equal(page.data.hasDayRecords, false)
})

// ---------- stats 账本分布 ----------

test('衣橱统计总花费仅合并衣物与账本，不依赖贴纸读取', async () => {
  let stickerReads = 0
  const page = loadPage('stats', {
    listItems: async () => [{ _id: 'item', price: 100 }],
    listExpenses: async () => [{ _id: 'expense', amount: 40, category: '洗护' }],
    listOutfits: async () => [], listWearRecords: async () => [],
    listStickers: async () => { stickerReads++; throw Error('贴纸接口不可用') }
  })
  await page.loadStats()
  assert.equal(page.data.totalSpent, 140)
  assert.equal(page.data.expenseTotal, 40)
  assert.equal(page.data.loadError, '')
  assert.equal(stickerReads, 0)
})

test('统计页账本分布按金额排序，无账本时总额为零', async () => {
  const page = loadPage('stats', {
    listItems: async () => [],
    listOutfits: async () => [],
    listExpenses: async () => [...expenses, { _id: 'exp-3', category: '服饰', amount: 100, date: '2026-09-21' }],
    listWearRecords: async () => []
  })
  await page.loadStats()
  assert.equal(page.data.expenseTotal, 200)
  assert.equal(page.data.expenseStats[0].name, '服饰')
  assert.equal(page.data.expenseStats[0].amount, 160.1)
  assert.equal(page.data.expenseStats[0].percent, 80)

  const empty = loadPage('stats', {
    listItems: async () => [],
    listOutfits: async () => [],
    listExpenses: async () => [],
    listWearRecords: async () => []
  })
  await empty.loadStats()
  assert.equal(empty.data.expenseTotal, 0)
  assert.equal(empty.data.expenseStats.every(row => row.amount === 0 && row.percent === 0), true)
})

test('品牌分布将未填写品牌的衣物归入无品牌', async () => {
  let clothes = [
    { _id: 'a', brand: '塔卡沙' }, { _id: 'b', brand: ' 塔卡沙 ' },
    { _id: 'c' }, { _id: 'd', brand: '' }, { _id: 'e', brand: '  ' }
  ]
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [],
    listExpenses: async () => [], listWearRecords: async () => []
  })
  await page.loadStats()
  assert.equal(page.data.totalBrands, 1)
  assert.deepEqual(Array.from(page.data.brandStats, row => ({ ...row })), [
    { name: '无品牌', count: 3, percent: 60, barStyle: 'width: 60%;' },
    { name: '塔卡沙', count: 2, percent: 40, barStyle: 'width: 40%;' }
  ])

  clothes = []
  await page.loadStats(true)
  assert.deepEqual(Array.from(page.data.brandStats), [])
})

test('分类统计按18类固定顺序保留空类，袜子与其他的件数金额完整', async () => {
  let clothes = CATEGORIES.map((category, index) => ({
    _id: `item-${index}`, name: category, category, subcategory: category === '配饰' ? '袜子' : '',
    price: index + 1.01, brand: category === '其他' ? '其他品牌' : '测试品牌',
    seasons: [category === '其他' ? '冬' : '夏']
  }))
  clothes.push({ _id: 'other-2', name: '第二件其他', category: '其他', price: 0.02, brand: '其他品牌', seasons: ['冬'] })
  const before = structuredClone(clothes)
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [{ _id: 'fit', itemIds: ['item-8', 'item-14', 'other-2'] }],
    listExpenses: async () => [], listWearRecords: async () => []
  })
  await page.loadStats()
  assert.deepEqual(Array.from(page.data.categoryStats, row => row.name), CATEGORIES)
  assert.equal(page.data.totalItems, 19)
  assert.equal(page.data.totalSpent, 171.2)
  assert.equal(page.data.totalOutfits, 1)
  assert.equal(page.data.categoryStats.reduce((sum, row) => sum + row.count, 0), 19)
  assert.equal(page.data.categoryStats.reduce((sum, row) => sum + Math.round(row.spent * 100), 0), 17120)
  const byCategory = Object.fromEntries(page.data.categoryStats.map(row => [row.name, row]))
  for (const [category, count, spent, percent] of [
    ['连衣裙', 1, 9.01, 5], ['挂件', 1, 15.01, 5], ['配饰', 1, 14.01, 5],
    ['包袋', 1, 16.01, 5], ['其他', 2, 18.03, 11]
  ]) {
    assert.equal(byCategory[category].count, count, category)
    assert.equal(byCategory[category].spent, spent, category)
    assert.equal(byCategory[category].percent, percent, category)
  }
  assert.equal(page.data.totalBrands, 2)
  assert.equal(page.data.brandStats.find(row => row.name === '其他品牌').count, 2)
  assert.equal(page.data.seasonStats.find(row => row.name === '冬').count, 2)
  assert.deepEqual(clothes, before)

  clothes = []
  await page.loadStats(true)
  assert.deepEqual(Array.from(page.data.categoryStats, row => row.name), CATEGORIES)
  assert.equal(page.data.totalItems, 0)
  assert.equal(page.data.totalSpent, 0)
  assert.ok(page.data.categoryStats.every(row => row.count === 0 && row.spent === 0 && row.percent === 0))
})

// ---------- stats 闲置口径（WEAR-06：与月报统一为「近 90 天未记录穿着」） ----------

const shanghaiDaysAgo = n => new Date(Date.now() + 8 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10)

test('闲置榜排除一级其他、保留配饰子类其他，近期穿着不入选', async () => {
  const oldDate = shanghaiDaysAgo(200)
  const misc = Array.from({ length: 9 }, (_, index) => ({ _id: `misc-${index}`, name: `其他${index}`, category: '其他', price: 1, purchaseDate: oldDate }))
  const eligible = [
    { _id: 'dress', name: '原连衣裙', category: '连衣裙', purchaseDate: oldDate },
    { _id: 'pendant', name: '原挂件', category: '挂件', purchaseDate: oldDate },
    { _id: 'socks', name: '袜子', category: '配饰', subcategory: '袜子', purchaseDate: oldDate },
    { _id: 'accessory', name: '其他配饰', category: '配饰', subcategory: '其他', purchaseDate: oldDate }
  ]
  const worn = { _id: 'worn-shirt', name: '常穿衬衫', category: '衬衫', purchaseDate: oldDate }
  let clothes = [...misc, ...eligible, worn]
  // 近期记录引用一件合格衣物（常穿衬衫）证明有近期活动，其余合格衣物未穿 → 进入闲置
  let wears = [{ _id: 'recent', date: shanghaiDaysAgo(10), itemIds: ['worn-shirt', ...misc.map(item => item._id)] }]
  const before = structuredClone({ clothes, wears })
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [], listExpenses: async () => [], listWearRecords: async () => wears
  })
  await page.loadStats()
  assert.equal(page.data.idleInsufficient, false)
  assert.deepEqual(Array.from(page.data.idleRank, row => row.name).sort(), eligible.map(item => item.name).sort())
  assert.equal(page.data.wearRank.length, 8)
  assert.ok(page.data.wearRank.every(row => row.name.startsWith('其他') && row.count === 1))
  assert.equal(page.data.totalItems, 14)
  assert.equal(page.data.totalSpent, 9)
  assert.deepEqual({ clothes, wears }, before)

  // 只有其他衣物、实穿记录仅含其他时：无可判定闲置的合格衣物，且排除其他后无近期有效记录
  clothes = misc
  wears = [{ _id: 'only-other', date: shanghaiDaysAgo(10), itemIds: misc.map(item => item._id) }]
  await page.loadStats(true)
  assert.equal(page.data.idleRank.length, 0)
  assert.equal(page.data.idleInsufficient, true)
  assert.equal(page.data.wearRank.length, 8)
  assert.equal(page.data.categoryStats.find(row => row.name === '其他').count, 9)
  assert.equal(page.data.totalSpent, 9)
})

test('近 90 天无有效实穿记录时判定不足，不列闲置', async () => {
  const oldDate = shanghaiDaysAgo(200)
  const clothes = [{ _id: 'a', name: '旧外套', category: '外套', purchaseDate: oldDate }]
  const wears = [{ _id: 'w', date: shanghaiDaysAgo(200), itemIds: ['a'] }]
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [], listExpenses: async () => [], listWearRecords: async () => wears
  })
  await page.loadStats()
  assert.equal(page.data.idleInsufficient, true)
  assert.equal(page.data.idleRank.length, 0)
})

test('购买日期缺失或无效时回退入库时间判定闲置', async () => {
  const createdAtOld = new Date(Date.now() - 200 * 86400000)
  const clothes = [
    { _id: 'a', name: '无购买日期旧衣', category: '外套', purchaseDate: '', createdAt: createdAtOld },
    { _id: 'b', name: '购买日期无效旧衣', category: '长裤', purchaseDate: 'not-a-date', createdAt: createdAtOld },
    { _id: 'c', name: '无日期信息', category: '衬衫', purchaseDate: '' }
  ]
  const wears = [{ _id: 'w', date: shanghaiDaysAgo(10), itemIds: ['deleted'] }]
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [], listExpenses: async () => [], listWearRecords: async () => wears
  })
  await page.loadStats()
  assert.equal(page.data.idleInsufficient, false)
  assert.deepEqual(Array.from(page.data.idleRank, row => row.name).sort(), ['无购买日期旧衣', '购买日期无效旧衣'])
})

// ---------- MATCH-05 搭配频次榜与闲置口径扩展 ----------

test('搭配频次按衣物出现在多少条搭配中计次，删除单品不计入，无搭配时为空', async () => {
  const clothes = [
    { _id: 'a', name: '白衬衫', category: '衬衫' },
    { _id: 'b', name: '牛仔裤', category: '长裤' },
    { _id: 'c', name: '帆布鞋', category: '鞋' }
  ]
  const outfits = [
    { _id: 'f1', itemIds: ['a', 'b'] },
    { _id: 'f2', itemIds: ['a', 'c'] },
    { _id: 'f3', itemIds: ['a', 'a', 'gone'] } // 同搭配重复 a 只计一次；已删除 gone 不计入
  ]
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => outfits,
    listExpenses: async () => [], listWearRecords: async () => []
  })
  await page.loadStats()
  assert.equal(page.data.outfitRank[0].name, '白衬衫')
  assert.deepEqual(Object.fromEntries(page.data.outfitRank.map(row => [row.name, row.count])),
    { 白衬衫: 3, 牛仔裤: 1, 帆布鞋: 1 })

  const empty = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [],
    listExpenses: async () => [], listWearRecords: async () => []
  })
  await empty.loadStats()
  assert.deepEqual(Array.from(empty.data.outfitRank), [])
})

test('近 90 天新建搭配中的衣物不闲置，仅旧搭配中的衣物仍入选', async () => {
  const oldDate = shanghaiDaysAgo(200)
  const clothes = [
    { _id: 'recentfit', name: '近配衣', category: '衬衫', purchaseDate: oldDate },
    { _id: 'oldfit', name: '旧配衣', category: '长裤', purchaseDate: oldDate },
    { _id: 'lonely', name: '无配衣', category: '外套', purchaseDate: oldDate }
  ]
  const outfits = [
    // createdAt 兼测字符串与 Date 两种云端形态
    { _id: 'f-new', itemIds: ['recentfit'], createdAt: new Date(Date.now() - 10 * 86400000).toISOString() },
    { _id: 'f-old', itemIds: ['oldfit'], createdAt: new Date(Date.now() - 200 * 86400000) }
  ]
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => outfits,
    listExpenses: async () => [], listWearRecords: async () => []
  })
  await page.loadStats()
  assert.equal(page.data.idleInsufficient, false)
  assert.deepEqual(Array.from(page.data.idleRank, row => row.name).sort(), ['旧配衣', '无配衣'].sort())
})

test('实穿与搭配均无近期记录时判定不足，不列闲置', async () => {
  const clothes = [{ _id: 'a', name: '旧衣', category: '衬衫', purchaseDate: shanghaiDaysAgo(200) }]
  const page = loadPage('stats', {
    listItems: async () => clothes,
    listOutfits: async () => [{ _id: 'f-old', itemIds: ['a'], createdAt: new Date(Date.now() - 200 * 86400000) }],
    listExpenses: async () => [],
    listWearRecords: async () => [{ _id: 'w-old', date: shanghaiDaysAgo(200), itemIds: ['a'] }]
  })
  await page.loadStats()
  assert.equal(page.data.idleInsufficient, true)
  assert.equal(page.data.idleRank.length, 0)
})

test('截止日当天新建的搭配算近期活动', async () => {
  const clothes = [{ _id: 'a', name: '边界衣', category: '衬衫', purchaseDate: shanghaiDaysAgo(200) }]
  const cutoffMidnight = new Date(Date.parse(`${shanghaiDaysAgo(90)}T00:00:00+08:00`))
  const page = loadPage('stats', {
    listItems: async () => clothes,
    listOutfits: async () => [{ _id: 'f-cut', itemIds: ['a'], createdAt: cutoffMidnight }],
    listExpenses: async () => [], listWearRecords: async () => []
  })
  await page.loadStats()
  assert.equal(page.data.idleInsufficient, false)
  assert.equal(page.data.idleRank.length, 0)
})
