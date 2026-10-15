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

// ---------- stats 账本分布 ----------

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
    { name: '无品牌', count: 3, percent: 60 },
    { name: '塔卡沙', count: 2, percent: 40 }
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

test('闲置建议在截取前排除一级其他，配饰子类其他保留，手工穿着统计完整', async () => {
  const misc = Array.from({ length: 9 }, (_, index) => ({ _id: `misc-${index}`, name: `其他${index}`, category: '其他', price: 1 }))
  const eligible = [
    { _id: 'dress', name: '原连衣裙', category: '连衣裙' },
    { _id: 'pendant', name: '原挂件', category: '挂件' },
    { _id: 'socks', name: '袜子', category: '配饰', subcategory: '袜子' },
    { _id: 'accessory', name: '其他配饰', category: '配饰', subcategory: '其他' }
  ]
  let clothes = [...misc, ...eligible]
  let wears = [
    { _id: 'mixed', date: '2026-09-20', itemIds: clothes.map(item => item._id) },
    { _id: 'misc-only', date: '2026-09-01', itemIds: misc.map(item => item._id) }
  ]
  const before = structuredClone({ clothes, wears })
  const page = loadPage('stats', {
    listItems: async () => clothes, listOutfits: async () => [], listExpenses: async () => [], listWearRecords: async () => wears
  })
  await page.loadStats()
  assert.deepEqual(Array.from(page.data.idleRank, row => row.name).sort(), eligible.map(item => item.name).sort())
  assert.equal(page.data.wearRank.length, 8)
  assert.ok(page.data.wearRank.every(row => row.name.startsWith('其他') && row.count === 2))
  assert.equal(page.data.totalItems, 13)
  assert.equal(page.data.totalSpent, 9)
  assert.deepEqual({ clothes, wears }, before)

  clothes = misc
  wears = [{ _id: 'only-other', date: '2026-09-01', itemIds: misc.map(item => item._id) }]
  await page.loadStats(true)
  assert.equal(page.data.idleRank.length, 0)
  assert.equal(page.data.wearRank.length, 8)
  assert.equal(page.data.categoryStats.find(row => row.name === '其他').count, 9)
  assert.equal(page.data.totalSpent, 9)
})
