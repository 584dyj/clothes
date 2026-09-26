const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

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

test('月历合计并入账本开销，日明细分衣物与账本', async () => {
  const navigations = []
  const page = loadPage('calendar', {
    listItems: async () => [{ _id: 'item-1', name: '白衬衫', price: 100, purchaseDate: '2026-09-20' }, { _id: 'item-2', name: '旧衣', price: 50, purchaseDate: '' }],
    listExpenses: async () => expenses,
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

  page.onDayTap({ currentTarget: { dataset: { date: '2026-09-20' } } })
  assert.equal(page.data.dayItems.length, 1)
  assert.equal(page.data.dayExpenses.length, 2)
  assert.equal(page.data.selectedTotal, 200)

  page.onAddExpense()
  assert.equal(navigations[0], '/pages/expense-edit/expense-edit?date=2026-09-20')
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
