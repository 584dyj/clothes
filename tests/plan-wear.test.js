const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

// calendar 月历：全部开销与计划

// 月历打开的是当前月份，夹具日期须落在当月，避免跨月后断言失效
const thisMonth = day => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

test('月历统一合计全部开销，切月保留计划与账本明细', async () => {
  const day20 = thisMonth(new Date().getDate())
  let wearReads = 0
  const page = loadPage('calendar', {
    listItems: async () => [{ _id: 'i1', name: '衬衫', price: 100, purchaseDate: day20 }],
    listExpenses: async () => [{ _id: 'e1', category: '洗护', amount: 50, date: day20 }],
    listPlans: async () => [{ _id: 'p1', date: day20, outfitId: 'f1', note: '' }],
    listWearRecords: async () => { wearReads++; return [{ _id: 'w1', date: day20, itemIds: ['i1'] }] },
    listOutfits: async () => [{ _id: 'f1', name: '通勤' }]
  })
  page.onLoad()
  await page.loadData()
  assert.equal(wearReads, 0)
  assert.equal(page.data.monthTotal, 150) // 全部 = 衣物 + 账本
  assert.equal(page.data.yearTotal, 150)
  assert.equal(page.data.todayTotal, 150)
  const cell = page.data.cells.find(row => row.date === day20)
  assert.equal(cell.total, 150)
  assert.equal(cell.hasPlan, true)

  page.onDayTap({ currentTarget: { dataset: { date: day20 } } })
  assert.equal(page.data.dayPlans[0].outfitName, '通勤')
  assert.equal(page.data.selectedTotal, 150)
  assert.equal(page.data.dayItems.length, 1)
  assert.equal(page.data.dayExpenses.length, 1)

  page.onPrevMonth()
  assert.equal(page.data.monthTotal, 0)
  page.onNextMonth()
  assert.equal(page.data.monthTotal, 150)
  assert.equal(page.data.selectedTotal, 150)
  assert.equal(page.data.dayItems.length, 1)
  assert.equal(page.data.dayExpenses.length, 1)
  assert.equal(page.data.dayPlans.length, 1)
})

// ---------- 计划仅作计划 ----------

test('月历保留计划编辑入口，不读取或写入实穿', async () => {
  const day20 = thisMonth(new Date().getDate())
  const routes = []
  const page = loadPage('calendar', {
    listItems: async () => [],
    listExpenses: async () => [],
    listPlans: async () => [{ _id: 'p1', date: day20, outfitId: 'f1', note: '见客户' }],
    listWearRecords: async () => { throw Error('月历不应读取实穿') },
    listOutfits: async () => [{ _id: 'f1', name: '通勤', itemIds: ['i1', 'i2'] }],
    addWearRecord: async () => { throw Error('月历不应写入实穿') }
  }, { navigateTo: ({ url }) => routes.push(url) })
  page.onLoad()
  await page.loadData()
  page.onDayTap({ currentTarget: { dataset: { date: day20 } } })
  assert.equal(page.data.dayPlans[0].outfitName, '通勤')
  assert.equal(page.data.dayPlans[0].note, '见客户')
  page.onPlanTap({ currentTarget: { dataset: { id: 'p1' } } })
  assert.deepEqual(routes, ['/pages/plan-edit/plan-edit?id=p1'])
  page.onAddPlan()
  assert.equal(routes[1], `/pages/plan-edit/plan-edit?date=${day20}`)

  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/calendar/calendar.wxml'), 'utf8')
  assert.doesNotMatch(markup, /onQuickCheckIn|onAddWear|onWearTap|hasWorn|dayWears/)
  assert.match(markup, /bindtap="onPlanTap"/)
  assert.match(markup, /bindtap="onAddPlan"/)
})

test('未来、已删除与空穿搭计划仍能查看', async () => {
  const day20 = thisMonth(new Date().getDate())
  const futureDate = `${new Date().getFullYear() + 1}-01-15`
  const page = loadPage('calendar', {
    listItems: async () => [],
    listExpenses: async () => [],
    listPlans: async () => [
      { _id: 'p1', date: day20, outfitId: 'f1', note: '' },
      { _id: 'p2', date: day20, outfitId: 'gone', note: '' },
      { _id: 'p3', date: day20, outfitId: 'empty', note: '' },
      { _id: 'p4', date: futureDate, outfitId: 'f1', note: '' }
    ],
    listOutfits: async () => [{ _id: 'f1', name: '通勤', itemIds: ['i1'] }, { _id: 'empty', name: '空', itemIds: [] }]
  })
  page.onLoad()
  await page.loadData()
  page.onDayTap({ currentTarget: { dataset: { date: day20 } } })
  assert.deepEqual(Array.from(page.data.dayPlans, plan => plan.outfitName), ['通勤', '已删除穿搭', '空'])
  page.onDayTap({ currentTarget: { dataset: { date: futureDate } } })
  assert.equal(page.data.dayPlans[0].outfitName, '通勤')
})

// ---------- plan-edit ----------

test('计划页保存需选穿搭，选择后提交', async () => {
  const calls = []
  const page = loadPage('plan-edit', {
    listOutfits: async () => [{ _id: 'f1', name: '通勤' }],
    listPlans: async () => [],
    addPlan: async data => { calls.push(data); return 'new' },
    updatePlan: async () => ({}),
    deletePlan: async () => ({})
  }, { showToast() {}, showModal: opts => opts.success({ confirm: true }) })
  await page.onLoad({ date: '2026-09-21' })
  assert.equal(page.data.date, '2026-09-21')
  await page.onSave()
  assert.equal(calls.length, 0)
  page.openPicker({ currentTarget: { dataset: { target: 'outfit' } } })
  page.onPickerConfirm({ detail: { values: [0] } })
  assert.equal(page.data.outfitId, 'f1')
  await page.onSave()
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ date: '2026-09-21', outfitId: 'f1', note: '' }))
})

test('计划编辑加载已有计划并支持删除', async () => {
  let deleted = ''
  const page = loadPage('plan-edit', {
    listOutfits: async () => [{ _id: 'f1', name: '通勤' }],
    listPlans: async () => [{ _id: 'p1', date: '2026-09-21', outfitId: 'f1', note: '见客户' }],
    addPlan: async () => ({}),
    updatePlan: async () => ({}),
    deletePlan: async id => { deleted = id }
  }, { showModal: opts => opts.success({ confirm: true }) })
  await page.onLoad({ id: 'p1' })
  assert.equal(page.data.outfitName, '通勤')
  assert.equal(page.data.note, '见客户')
  page.onDelete()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deleted, 'p1')
})

// ---------- wear-edit ----------

test('穿着页选穿搭自动带出单品，未选衣物不能保存', async () => {
  const calls = []
  const page = loadPage('wear-edit', {
    listItems: async () => [{ _id: 'a', name: '衬衫', category: '上衣' }, { _id: 'b', name: '长裤', category: '下装' }],
    listOutfits: async () => [{ _id: 'f1', name: '通勤', itemIds: ['a', 'b'] }],
    listWearRecords: async () => [],
    addWearRecord: async data => { calls.push(data); return 'new' },
    updateWearRecord: async () => ({}),
    deleteWearRecord: async () => ({})
  }, { showToast() {}, showModal: opts => opts.success({ confirm: true }) })
  await page.onLoad({ date: '2026-09-21' })
  await page.onSave()
  assert.equal(calls.length, 0)

  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  assert.equal(page.data.selectedIds.length, 1)
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  assert.equal(page.data.selectedIds.length, 0)

  page.openPicker({ currentTarget: { dataset: { target: 'outfit' } } })
  page.onPickerConfirm({ detail: { values: [1] } }) // 下标 1 = 第一个穿搭（0 = 不选）
  assert.equal(page.data.outfitName, '通勤')
  assert.deepEqual(Array.from(page.data.selectedIds), ['a', 'b'])
  await page.onSave()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].itemIds.length, 2)
  assert.equal(calls[0].outfitId, 'f1')
})

test('统计页穿着频次与闲置榜按记录计算，删除单品不计入', async () => {
  const daysAgo = n => new Date(Date.now() + 8 * 60 * 60 * 1000 - n * 86400000).toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 8 * 60 * 60 * 1000 + 86400000).toISOString().slice(0, 10)
  const page = loadPage('stats', {
    listItems: async () => [
      { _id: 'a', name: '衬衫', purchaseDate: daysAgo(200) }, { _id: 'b', name: '长裤', purchaseDate: daysAgo(200) }
    ],
    listOutfits: async () => [],
    listExpenses: async () => [],
    listWearRecords: async () => [
      { _id: 'w1', date: daysAgo(200), itemIds: ['a', 'b'] },
      { _id: 'w2', date: daysAgo(10), itemIds: ['a', 'gone'] },
      { _id: 'old-future', date: tomorrow, itemIds: ['a', 'b'] }
    ]
  })
  await page.loadStats()
  assert.equal(page.data.wearRank[0].name, '衬衫')
  assert.equal(page.data.wearRank[0].count, 2)
  assert.equal(page.data.wearRank[1].name, '长裤')
  // 已删除单品 gone 不出现在榜单
  assert.equal(page.data.wearRank.some(row => row.name === '已删'), false)
  assert.equal(page.data.idleRank.some(row => row.name === '已删'), false)
  // 长裤最近一次穿着在 90 天前 → 进入闲置；衬衫近期穿过 → 不进入
  assert.equal(page.data.idleInsufficient, false)
  assert.deepEqual(Array.from(page.data.idleRank, row => row.name), ['长裤'])
})

test('穿着页按 18 类分组选品，其他与配饰袜子跨分类选择不丢失并保存', async () => {
  const saved = []
  const page = loadPage('wear-edit', {
    listItems: async () => [
      { _id: 'shirt', name: '白衬衫', category: '衬衫' },
      { _id: 'socks', name: '棉袜', category: '配饰', subcategory: '袜子' },
      { _id: 'misc', name: '摆件', category: '其他' },
      { _id: 'dress', name: '连体裙', category: '连衣裙' }
    ],
    listOutfits: async () => [],
    listWearRecords: async () => [],
    addWearRecord: async data => { saved.push(data); return 'new' }
  }, { showToast() {} })
  await page.onLoad({ date: '2026-10-15' })
  const { CATEGORIES } = require('../cloudfunctions/auth/categories')
  assert.deepEqual(Array.from(page.data.categories), ['全部', '已选', ...CATEGORIES])

  const tap = value => page.onCategoryTap({ currentTarget: { dataset: { value } } })
  const toggle = id => page.onItemToggle({ currentTarget: { dataset: { id } } })
  tap('配饰')
  assert.deepEqual(page.data.viewItems.map(item => item._id), ['socks'])
  toggle('socks')
  tap('其他')
  assert.deepEqual(page.data.viewItems.map(item => item._id), ['misc'])
  toggle('misc')
  tap('衬衫')
  toggle('shirt')
  tap('已选')
  assert.deepEqual(page.data.viewItems.map(item => item._id).sort(), ['misc', 'shirt', 'socks'])
  assert.ok(page.data.viewItems.every(item => item.selected))
  await page.onSave()
  assert.equal(saved.length, 1)
  assert.deepEqual(Array.from(saved[0].itemIds).sort(), ['misc', 'shirt', 'socks'])
})

test('穿着编辑加载已有记录并展示件数', async () => {
  const page = loadPage('wear-edit', {
    listItems: async () => [{ _id: 'a', name: '衬衫', category: '上衣' }, { _id: 'b', name: '长裤', category: '下装' }],
    listOutfits: async () => [{ _id: 'f1', name: '通勤', itemIds: ['a', 'b'] }],
    listWearRecords: async () => [{ _id: 'w1', date: '2026-09-21', itemIds: ['a'], outfitId: '', note: '下雨' }],
    addWearRecord: async () => ({}),
    updateWearRecord: async () => ({}),
    deleteWearRecord: async () => ({})
  }, { showModal: opts => opts.success({ confirm: true }) })
  await page.onLoad({ id: 'w1' })
  assert.equal(page.data.date, '2026-09-21')
  assert.equal(page.data.note, '下雨')
  assert.equal(page.data.selectedIds.length, 1)
  const selected = page.data.viewItems.find(item => item._id === 'a')
  assert.equal(selected.selected, true)
})

test('原挂件连衣裙及历史关联读取保持，其他可保存手工关联且全部计入月历', async () => {
  const date = thisMonth(new Date().getDate())
  const original = {
    clothes: [
      { _id: 'pendant', name: '原挂件', category: '挂件', price: 9.9, imageFileID: `cloud://env/wardrobe/${'1'.repeat(32)}.jpg` },
      { _id: 'dress', name: '原连衣裙', category: '连衣裙', price: 199.99, imageFileID: `cloud://env/wardrobe/${'2'.repeat(32)}.jpg` }
    ].map(item => ({ ...item, _openid: 'openid-1', purchaseDate: date, seasons: ['春秋'], subcategory: '' })),
    outfits: [{ _id: 'look', _openid: 'openid-1', name: '原穿搭', itemIds: ['dress', 'pendant'] }],
    outfit_plans: [{ _id: 'plan', _openid: 'openid-1', date, outfitId: 'look', note: '原计划' }],
    wear_records: [{ _id: 'wear', _openid: 'openid-1', date, outfitId: 'look', itemIds: ['dress', 'pendant'], note: '原实穿' }],
    expenses: [
      { _id: 'dress-care', _openid: 'openid-1', category: '洗护', date, itemId: 'dress', amount: 20.05 },
      { _id: 'pendant-care', _openid: 'openid-1', category: '修改', date, itemId: 'pendant', amount: 5.01 }
    ]
  }
  const { loadCloud } = require('./support/cloud')
  const cloud = loadCloud({ ...structuredClone(original), users: [{ _id: 'user', openid: 'openid-1', username: 'alice' }] })
  const client = { exports: {} }
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../utils/db'), 'utf8'), {
    module: client, wx: { cloud: { callFunction: async ({ data }) => ({ result: await cloud.main(data) }) } }, console, Date
  })
  const db = client.exports
  assert.deepEqual(structuredClone(await db.listItems()), original.clothes)

  const miscId = await db.addItem({ name: '基础其他', category: '其他', seasons: [], price: 30.12, purchaseDate: date })
  const itemIds = ['dress', miscId, 'pendant']
  const outfitId = await db.addOutfit({ name: '手工组合', itemIds })
  const planId = await db.addPlan({ date, outfitId })
  const wearId = await db.addWearRecord({ date, outfitId, itemIds })
  const expenseId = await db.addExpense({ category: '其他', date, itemId: miscId, amount: 3.03 })

  const gallery = loadPage('outfits', db)
  await gallery.loadData()
  const cards = [...gallery.data.left, ...gallery.data.right]
  const legacy = cards.find(outfit => outfit._id === 'look')
  assert.equal(legacy.count, 2)
  assert.deepEqual(Array.from(legacy.thumbs, item => item._id), ['dress', 'pendant'])
  assert.equal(legacy.coverFileID, original.clothes[1].imageFileID)
  assert.equal(cards.find(outfit => outfit._id === outfitId).count, 3)

  const plan = loadPage('plan-edit', db)
  await plan.onLoad({ id: 'plan' })
  assert.equal(plan.data.outfitId, 'look')
  assert.equal(plan.data.outfitName, '原穿搭')
  const wear = loadPage('wear-edit', db)
  await wear.onLoad({ id: 'wear' })
  assert.deepEqual(Array.from(wear.data.selectedIds), original.wear_records[0].itemIds)
  assert.equal(wear.data.outfitId, 'look')
  for (const expense of original.expenses) {
    const ledger = loadPage('expense-edit', db)
    await ledger.onLoad({ id: expense._id })
    assert.equal(ledger.data.itemId, expense.itemId)
    assert.equal(ledger.data.itemName, original.clothes.find(item => item._id === expense.itemId).name)
    assert.equal(Number(ledger.data.amount), expense.amount)
  }

  const calendar = loadPage('calendar', db)
  calendar.onLoad()
  await calendar.loadData()
  calendar.onDayTap({ currentTarget: { dataset: { date } } })
  assert.equal(calendar.data.selectedTotal, 268.1)
  assert.equal(calendar.data.monthTotal, 268.1)
  assert.equal(calendar.data.dayItems.length, 3)
  assert.equal(calendar.data.dayPlans.find(row => row._id === 'plan').outfitName, '原穿搭')
  assert.equal(calendar.data.dayPlans.find(row => row._id === planId).outfitId, outfitId)
  assert.equal(calendar.data.dayExpenses.find(row => row._id === expenseId).itemId, miscId)
  for (const [collection, rows] of Object.entries(original)) {
    for (const row of rows) assert.deepEqual(cloud.records[collection].find(current => current._id === row._id), row)
  }
  assert.deepEqual(cloud.deletedFiles, [])
})
