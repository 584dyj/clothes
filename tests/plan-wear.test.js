const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

// ---------- calendar 月历：分段 + 计划/实穿 ----------

// 月历打开的是当前月份，夹具日期须落在当月，避免跨月后断言失效
const thisMonth = day => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

test('月历分段切换与计划实穿标记、明细', async () => {
  const day20 = thisMonth(20)
  const page = loadPage('calendar', {
    listItems: async () => [{ _id: 'i1', name: '衬衫', price: 100, purchaseDate: day20 }],
    listExpenses: async () => [{ _id: 'e1', category: '洗护', amount: 50, date: day20 }],
    listPlans: async () => [{ _id: 'p1', date: day20, outfitId: 'f1', note: '' }],
    listWearRecords: async () => [{ _id: 'w1', date: day20, itemIds: ['i1'], outfitId: '' }],
    listOutfits: async () => [{ _id: 'f1', name: '通勤' }]
  })
  page.onLoad()
  await page.loadData()
  assert.equal(page.data.monthTotal, 150) // 全部 = 衣物 + 账本
  const cell = page.data.cells.find(row => row.date === day20)
  assert.equal(cell.hasPlan, true)
  assert.equal(cell.hasWorn, true)

  page.onDayTap({ currentTarget: { dataset: { date: day20 } } })
  assert.equal(page.data.dayPlans[0].outfitName, '通勤')
  assert.equal(page.data.dayWears[0].itemCount, 1)
  assert.equal(page.data.selectedTotal, 150)

  page.onSegmentTap({ currentTarget: { dataset: { value: 'clothes' } } })
  assert.equal(page.data.monthTotal, 100)
  assert.equal(page.data.dayExpenses.length, 0)
  assert.equal(page.data.dayItems.length, 1)
  assert.equal(page.data.selectedTotal, 100)

  page.onSegmentTap({ currentTarget: { dataset: { value: 'expenses' } } })
  assert.equal(page.data.monthTotal, 50)
  assert.equal(page.data.dayItems.length, 0)
  assert.equal(page.data.dayExpenses.length, 1)
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
  const page = loadPage('stats', {
    listItems: async () => [
      { _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }
    ],
    listOutfits: async () => [],
    listExpenses: async () => [],
    listWearRecords: async () => [
      { _id: 'w1', date: '2026-09-20', itemIds: ['a', 'b'] },
      { _id: 'w2', date: '2026-09-25', itemIds: ['a', 'gone'] },
      { _id: 'w3', date: '2026-09-26', itemIds: ['a'] }
    ]
  })
  await page.loadStats()
  assert.equal(page.data.wearRank[0].name, '衬衫')
  assert.equal(page.data.wearRank[0].count, 3)
  assert.equal(page.data.wearRank[1].name, '长裤')
  // 已删除单品 gone 不出现在榜单
  assert.equal(page.data.wearRank.some(row => row.name === '已删'), false)
  assert.equal(page.data.idleRank.some(row => row.name === '已删'), false)
  // 闲置最久的是长裤（9-20）
  assert.equal(page.data.idleRank[0].name, '长裤')
  assert.ok(page.data.idleRank[0].days > 0)
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
