const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

const today = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
const dayBefore = date => new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)

test('穿搭入口进入今日穿着，带入后可调整并在同页查看全部历史', async () => {
  let route = ''
  const gallery = loadPage('outfits', {}, { navigateTo: ({ url }) => { route = url } })
  gallery.onWearTap()
  assert.equal(route, '/pages/today-wear/today-wear')

  const records = Array.from({ length: 21 }, (_, i) => ({ _id: `old-${i}`, date: '2022-01-01', itemIds: ['c'], note: '' }))
  records.push({ _id: 'recent', date: dayBefore(today()), itemIds: ['a', 'b', 'gone'], note: '', createdAt: new Date(Date.now() - 3600000) })
  records.push({ _id: 'recent-later', date: dayBefore(today()), itemIds: ['b', 'c'], note: '', createdAt: new Date() })
  const saved = []
  const page = loadPage('today-wear', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }, { _id: 'c', name: '外套' }],
    listOutfits: async () => [{ _id: 'look', name: '通勤', itemIds: ['a', 'b'] }],
    listWearRecords: async () => records,
    addWearRecord: async data => { saved.push(data); records.push({ _id: 'new', ...data }); return 'new' }
  }, { pageScrollTo() {} })
  await page.onLoad({})
  assert.equal(page.data.date, today())
  assert.equal(page.data.history.length, 20)
  assert.equal(page.data.hasMoreHistory, true)
  assert.equal(page.data.history[0]._id, 'recent-later')
  page.onMoreHistory()
  assert.equal(page.data.history.length, 23)
  assert.equal(page.data.hasMoreHistory, false)

  page.onLastWearTap()
  assert.deepEqual(Array.from(page.data.selectedIds), ['b', 'c'])
  page.openPicker({ currentTarget: { dataset: { target: 'outfit' } } })
  page.onPickerConfirm({ detail: { values: [1] } })
  assert.equal(page.data.outfitId, 'look')
  page.onItemToggle({ currentTarget: { dataset: { id: 'c' } } })
  assert.equal(page.data.outfitId, '')
  await page.onSave()
  assert.equal(saved.length, 1)
  assert.deepEqual(Array.from(saved[0].itemIds), ['a', 'b', 'c'])
  assert.equal(saved[0].outfitId, '')
  assert.equal(page.data.history[0]._id, 'new')
  assert.equal(page.data.id, '')
})

test('历史未来日期可修正，失效衣物需显式移除，删除后刷新列表', async () => {
  const future = new Date(Date.parse(today() + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  let records = [{ _id: 'legacy', date: future, itemIds: ['a', 'gone'], note: '旧记录' }]
  const saved = []
  const toasts = []
  const page = loadPage('today-wear', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }],
    listOutfits: async () => [],
    listWearRecords: async () => records,
    updateWearRecord: async (id, data) => { saved.push(data); records = [{ _id: id, ...data }]; return {} },
    deleteWearRecord: async id => { records = records.filter(row => row._id !== id) }
  }, { pageScrollTo() {}, showToast: opts => toasts.push(opts.title), showModal: opts => opts.success({ confirm: true }) })
  await page.onLoad({})
  assert.equal(page.data.history[0].future, true)
  page.onHistoryTap({ currentTarget: { dataset: { id: 'legacy' } } })
  assert.equal(page.data.missingCount, 1)
  await page.onSave()
  assert.equal(saved.length, 0)
  assert.ok(toasts.includes('请先移除已删除衣物'))
  page.onRemoveMissing()
  page.openPicker({ currentTarget: { dataset: { target: 'date' } } })
  const picker = page.data.picker
  assert.equal(picker.columns[2].at(-1), today().slice(8, 10))
  page.onPickerConfirm({ detail: { values: picker.values } })
  await page.onSave()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].date, today())
  assert.deepEqual(Array.from(saved[0].itemIds), ['a'])
  assert.equal(page.data.history[0].future, false)

  page.onHistoryDelete({ currentTarget: { dataset: { id: 'legacy' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.history.length, 0)
})

test('月历旧入口不预填未来日期，保存后仍返回月历', async () => {
  const future = new Date(Date.parse(today() + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  let backCount = 0
  const page = loadPage('wear-edit', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }],
    listOutfits: async () => [],
    listWearRecords: async () => [],
    addWearRecord: async () => 'new'
  }, { navigateBack: () => { backCount++ }, testSetTimeout: fn => fn() })
  await page.onLoad({ date: future })
  assert.equal(page.data.date, today())
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  await page.onSave()
  assert.equal(backCount, 1)
})

test('快捷入库返回后保留草稿并可点选新衣物，取消入库也保留草稿', async () => {
  let items = [{ _id: 'a', name: '衬衫' }]
  let forced = 0
  const routes = []
  const page = loadPage('today-wear', {
    listItems: async force => { if (force) forced++; return items },
    listOutfits: async () => [],
    listWearRecords: async () => []
  }, { navigateTo: opts => routes.push(opts.url) })
  await page.onLoad({})
  await page.onShow()
  assert.equal(forced, 0)
  const date = dayBefore(today())
  page.setData({ date, note: '有风', activeCategory: '已选' })
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  page.onItemToggle({ currentTarget: { dataset: { id: 'unstocked' } } })
  assert.deepEqual(Array.from(page.data.selectedIds), ['a'])

  page.onQuickAddTap()
  assert.equal(routes[0], '/pages/item-edit/item-edit')
  items = [...items, { _id: 'b', name: '新外套' }]
  await page.onShow()
  assert.equal(forced, 1)
  assert.equal(page.data.date, date)
  assert.equal(page.data.note, '有风')
  assert.equal(page.data.activeCategory, '已选')
  assert.deepEqual(Array.from(page.data.selectedIds), ['a'])
  assert.equal(page.data.recentlyAdded[0]._id, 'b')
  page.onItemToggle({ currentTarget: { dataset: { id: 'b' } } })
  assert.deepEqual(Array.from(page.data.selectedIds), ['a', 'b'])
  assert.equal(page.data.recentlyAdded[0].selected, true)

  page.onQuickAddTap()
  await page.onShow()
  assert.equal(forced, 2)
  assert.equal(page.data.recentlyAdded.length, 0)
  assert.equal(page.data.date, date)
  assert.equal(page.data.note, '有风')
  assert.deepEqual(Array.from(page.data.selectedIds), ['a', 'b'])
})

test('历史编辑入库刷新失败可重试，切换记录不会带入原草稿', async () => {
  let items = [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }]
  let failRefresh = true
  const records = [
    { _id: 'first', date: dayBefore(today()), itemIds: ['a'], note: '原备注' },
    { _id: 'second', date: '2022-01-01', itemIds: ['b'], note: '另一条' }
  ]
  const page = loadPage('today-wear', {
    listItems: async force => {
      if (force && failRefresh) { failRefresh = false; throw new Error('网络失败') }
      return items
    },
    listOutfits: async () => [],
    listWearRecords: async () => records
  }, { navigateTo() {}, pageScrollTo() {} })
  await page.onLoad({})
  page.onHistoryTap({ currentTarget: { dataset: { id: 'first' } } })
  page.onNoteInput({ detail: { value: '修改中' } })
  page.onQuickAddTap()
  items = [...items, { _id: 'c', name: '新毛衣' }]
  await page.onShow()
  assert.equal(page.data.itemRefreshError, '衣橱刷新失败，点此重试')
  assert.equal(page.data.id, 'first')
  assert.equal(page.data.note, '修改中')
  page.onHistoryTap({ currentTarget: { dataset: { id: 'second' } } })
  await page.refreshItemsAfterQuickAdd()
  assert.equal(page.data.itemRefreshError, '')
  assert.equal(page.data.id, 'second')
  assert.equal(page.data.note, '另一条')
  assert.deepEqual(Array.from(page.data.selectedIds), ['b'])
  assert.equal(page.data.recentlyAdded.length, 0)
})

test('入库页手动返回后取消延迟返回，避免再退一层', async () => {
  let nextTimer = 0
  let backCount = 0
  const timers = new Map()
  const page = loadPage('item-edit', {
    addItem: async () => 'new'
  }, {
    testSetTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
    testClearTimeout: id => timers.delete(id),
    navigateBack: () => { backCount++ }
  })
  await page.onLoad({})
  page.setData({ name: '新衬衫', category: '衬衫' })
  await page.onSave()
  assert.equal(timers.size, 1)
  page.onUnload()
  for (const callback of timers.values()) callback()
  assert.equal(timers.size, 0)
  assert.equal(backCount, 0)

  let finishSave
  const pendingPage = loadPage('item-edit', {
    addItem: () => new Promise(resolve => { finishSave = resolve })
  }, {
    testSetTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
    testClearTimeout: id => timers.delete(id),
    navigateBack: () => { backCount++ }
  })
  await pendingPage.onLoad({})
  pendingPage.setData({ name: '新长裤', category: '长裤' })
  const saving = pendingPage.onSave()
  pendingPage.onUnload()
  finishSave()
  await saving
  assert.equal(timers.size, 0)
  assert.equal(backCount, 0)
})

test('主动保存为穿搭先保存实穿，取消收藏后记录仍可编辑', async () => {
  const records = []
  const routes = []
  const outfits = []
  let failSync = false
  let added = 0
  let updated = 0
  const page = loadPage('today-wear', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }],
    listOutfits: async () => outfits,
    listWearRecords: async () => records,
    getWearRecord: async id => { if (failSync) throw Error('offline'); return records.find(row => row._id === id) },
    addWearRecord: async data => { added++; records.push({ _id: 'wear-1', ...data }); return 'wear-1' },
    updateWearRecord: async (id, data) => { updated++; Object.assign(records.find(row => row._id === id), data); return {} }
  }, { navigateTo: ({ url }) => routes.push(url), pageScrollTo() {} })
  await page.onLoad({})
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  await page.onSaveAsOutfit()
  assert.equal(added, 1)
  assert.equal(page.data.id, 'wear-1')
  assert.deepEqual(Array.from(records[0].itemIds), ['a'])
  assert.equal(routes[0], '/pages/outfit-edit/outfit-edit?wearRecordId=wear-1')

  await page.onShow()
  assert.equal(records.length, 1)
  assert.equal(page.data.history[0]._id, 'wear-1')

  outfits.push({ _id: 'fit-1', name: '新收藏', itemIds: ['a'] })
  records[0].outfitId = 'fit-1'
  failSync = true
  page._returningFromOutfitEdit = true
  await page.onShow()
  assert.equal(page.data.outfitSyncError, '穿搭状态刷新失败，点此重试')
  await page.onSave()
  assert.equal(updated, 0)
  failSync = false
  await page.refreshAfterOutfitEdit()
  assert.equal(page.data.outfitSyncError, '')
  assert.equal(page.data.outfitId, 'fit-1')
  await page.onSave()
  assert.equal(added, 1)
  assert.equal(updated, 1)
  assert.equal(records[0].outfitId, 'fit-1')
})

test('已有相同单品组合可选择关联或继续新建，关联不新增实穿', async () => {
  const records = []
  const routes = []
  const actions = []
  const linked = []
  let choice = 0
  let added = 0
  const outfits = [{ _id: 'look-1', name: '通勤', itemIds: ['b', 'a'] }]
  const page = loadPage('today-wear', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }],
    listOutfits: async () => outfits,
    listWearRecords: async () => records,
    addWearRecord: async data => { added++; records.push({ _id: 'wear-1', ...data }); return 'wear-1' },
    updateWearRecord: async (id, data) => { Object.assign(records.find(row => row._id === id), data); return {} },
    linkWearOutfit: async (id, outfitId) => { linked.push([id, outfitId]); records[0].outfitId = outfitId }
  }, {
    showActionSheet: options => { actions.push(options.itemList); options.success({ tapIndex: choice }) },
    navigateTo: ({ url }) => routes.push(url),
    pageScrollTo() {}
  })
  await page.onLoad({})
  for (const id of ['a', 'b']) page.onItemToggle({ currentTarget: { dataset: { id } } })
  await page.onSaveAsOutfit()
  assert.equal(added, 1)
  assert.equal(actions.length, 1)
  assert.deepEqual(linked, [['wear-1', 'look-1']])
  assert.equal(page.data.outfitId, 'look-1')
  assert.equal(routes.length, 0)

  choice = 1
  await page.onSaveAsOutfit()
  assert.equal(added, 1)
  assert.equal(linked.length, 1)
  assert.equal(routes[0], '/pages/outfit-edit/outfit-edit?wearRecordId=wear-1')
})

test('常穿按近 14 天穿着次数降序取前 10，可点选加入', async () => {
  const daysAgo = n => new Date(Date.parse(today() + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10)
  const items = Array.from({ length: 12 }, (_, k) => ({ _id: 'i' + k, name: '衣' + k }))
  const records = []
  items.forEach(item => {
    const times = 12 - Number(item._id.slice(1))
    for (let t = 0; t < times; t += 1) records.push({ _id: `${item._id}-${t}`, date: daysAgo((t % 6) + 1), itemIds: [item._id] })
  })
  records.push({ _id: 'old', date: daysAgo(20), itemIds: ['i0'] })        // 窗口外（>14 天），不计次
  records.push({ _id: 'del', date: daysAgo(3), itemIds: ['i0', 'gone'] }) // 已删除引用不计入 gone，i0 计一次
  const page = loadPage('today-wear', {
    listItems: async () => items,
    listOutfits: async () => [],
    listWearRecords: async () => records
  }, { pageScrollTo() {} })
  await page.onLoad({})
  const picks = page.data.quickPicks
  assert.equal(picks.length, 10)
  assert.deepEqual(Array.from(picks, row => row._id), Array.from({ length: 10 }, (_, k) => 'i' + k))
  assert.equal(picks[0].count, 13) // 本组 12 次 + 已删除组合引用 1 次；窗口外旧记录不计
  assert.equal(picks.some(row => row._id === 'gone'), false)

  page.onItemToggle({ currentTarget: { dataset: { id: 'i5' } } })
  assert.ok(page.data.selectedIds.includes('i5'))
  assert.equal(page.data.quickPicks.find(row => row._id === 'i5').selected, true)
})
