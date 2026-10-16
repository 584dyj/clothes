const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

const today = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
const dayBefore = date => new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
const draftState = page => structuredClone(Object.fromEntries([
  'id', 'date', 'dateText', 'selectedIds', 'outfitId', 'outfitName', 'note', 'activeCategory', 'recentlyAdded'
].map(key => [key, page.data[key]])))

test('「我的穿搭」页底实穿记录入口进入实穿记录页，带入后可调整并在同页查看全部历史', async () => {
  let route = ''
  let title = ''
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
  }, { pageScrollTo() {}, setNavigationBarTitle: options => { title = options.title } })
  await page.onLoad({})
  assert.equal(title, '实穿记录')
  assert.equal(page.data.date, today())
  assert.match(page.data.dateText, /^今天（\d+月\d+日）$/)
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
  assert.equal(title, '实穿记录')
  page.onHistoryTap({ currentTarget: { dataset: { id: 'new' } } })
  assert.equal(page.data.historyEditing, true)
  assert.equal(title, '实穿记录')
  page.onCancelHistoryEdit()
  assert.equal(page.data.historyEditing, false)
  assert.equal(title, '实穿记录')
  assert.match(page.data.dateText, /^今天（\d+月\d+日）$/)
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

test('历史弹窗取消完整恢复上方草稿，切换历史记录与重置均不写库', async () => {
  for (const cancel of ['onCancelHistoryEdit', 'onResetTap']) {
    const writes = []
    const records = [
      { _id: 'first', date: '2022-01-01', itemIds: ['b'], note: '第一条' },
      { _id: 'second', date: dayBefore(today()), itemIds: ['b'], note: '第二条' }
    ]
    const page = loadPage('today-wear', {
      listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }],
      listOutfits: async () => [{ _id: 'look', name: '草稿穿搭', itemIds: ['a'] }],
      listWearRecords: async () => records,
      addWearRecord: async data => writes.push(['add', data]),
      updateWearRecord: async (id, data) => writes.push(['update', id, data]),
      deleteWearRecord: async id => writes.push(['delete', id])
    })
    await page.onLoad({})
    page.setData({
      date: dayBefore(today()), dateText: dayBefore(today()), selectedIds: ['a'],
      outfitId: 'look', outfitName: '草稿穿搭', note: '尚未保存的新增备注', activeCategory: '已选',
      recentlyAdded: [{ _id: 'a', name: '衬衫', selected: true }]
    })
    page.syncSelected()
    const draft = draftState(page)
    const before = structuredClone(records)

    page.onHistoryTap({ currentTarget: { dataset: { id: 'first' } } })
    assert.equal(page.data.historyEditing, true)
    page.onNoteInput({ detail: { value: '弹窗里未保存' } })
    page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
    page.onHistoryTap({ currentTarget: { dataset: { id: 'second' } } })
    assert.equal(page.data.id, 'second')
    assert.equal(page.data.note, '第二条')
    page[cancel]()

    assert.equal(page.data.historyEditing, false)
    assert.deepEqual(draftState(page), draft)
    assert.deepEqual(records, before)
    assert.deepEqual(writes, [])
    assert.equal(page.data.viewItems.find(item => item._id === 'a').selected, true)
  }
})

test('历史编辑失败保留弹窗和编辑值，重试成功只更新该记录并恢复草稿', async () => {
  const records = [{ _id: 'history', date: dayBefore(today()), itemIds: ['b'], note: '原备注' }]
  const updates = []
  let fail = true
  let added = 0
  const page = loadPage('today-wear', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }, { _id: 'c', name: '外套' }],
    listOutfits: async () => [{ _id: 'look', name: '草稿穿搭', itemIds: ['a'] }],
    listWearRecords: async () => records,
    addWearRecord: async () => { added++; return 'unexpected' },
    updateWearRecord: async (id, data) => {
      updates.push([id, structuredClone(data)])
      if (fail) throw Error('offline')
      Object.assign(records.find(record => record._id === id), data)
      return {}
    }
  })
  await page.onLoad({})
  page.setData({ selectedIds: ['a'], outfitId: 'look', outfitName: '草稿穿搭', note: '新增草稿', activeCategory: '已选' })
  page.syncSelected()
  const draft = draftState(page)
  page.onHistoryTap({ currentTarget: { dataset: { id: 'history' } } })
  page.setData({ date: today() })
  page.onNoteInput({ detail: { value: ' 修改后的备注 ' } })
  page.onItemToggle({ currentTarget: { dataset: { id: 'c' } } })
  page.onItemToggle({ currentTarget: { dataset: { id: 'b' } } })
  await page.onSave()

  assert.equal(page.data.historyEditing, true)
  assert.equal(page.data.saving, false)
  assert.equal(page.data.id, 'history')
  assert.equal(page.data.date, today())
  assert.equal(page.data.note, ' 修改后的备注 ')
  assert.deepEqual(Array.from(page.data.selectedIds), ['c'])
  assert.equal(records[0].note, '原备注')
  assert.equal(added, 0)

  fail = false
  await page.onSave()
  assert.equal(updates.length, 2)
  assert.equal(updates[1][0], 'history')
  assert.deepEqual(updates[1][1], { date: today(), itemIds: ['c'], outfitId: '', note: '修改后的备注' })
  assert.equal(added, 0)
  assert.equal(page.data.historyEditing, false)
  assert.deepEqual(draftState(page), draft)
  assert.equal(page.data.history[0].date, today())
  assert.equal(page.data.history[0].note, '修改后的备注')
  assert.deepEqual(Array.from(page.data.history[0].itemIds), ['c'])
  assert.equal(page.data.quickPicks.find(item => item._id === 'c').selected, false)
})

test('同步或刷新中不打开历史弹窗，保存中不能取消、切换或重复提交', async () => {
  const records = [
    { _id: 'first', date: dayBefore(today()), itemIds: ['a'], note: '第一条' },
    { _id: 'second', date: '2022-01-01', itemIds: ['b'], note: '第二条' }
  ]
  let finish
  let updates = 0
  const page = loadPage('today-wear', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }],
    listOutfits: async () => [],
    listWearRecords: async () => records,
    updateWearRecord: async (id, data) => {
      updates++
      await new Promise(resolve => { finish = resolve })
      Object.assign(records.find(record => record._id === id), data)
      return {}
    }
  })
  await page.onLoad({})
  page.setData({ selectedIds: ['b'], note: '新增草稿' })
  page.syncSelected()
  const draft = draftState(page)
  for (const flag of ['outfitSyncPending', 'refreshingItems']) {
    page.setData({ [flag]: true })
    page.onHistoryTap({ currentTarget: { dataset: { id: 'first' } } })
    assert.equal(page.data.historyEditing, false)
    assert.deepEqual(draftState(page), draft)
    page.setData({ [flag]: false })
  }

  page.onHistoryTap({ currentTarget: { dataset: { id: 'first' } } })
  const saving = page.onSave()
  assert.equal(page.data.saving, true)
  page.onCancelHistoryEdit()
  page.onResetTap()
  page.onHistoryTap({ currentTarget: { dataset: { id: 'second' } } })
  await page.onSave()
  assert.equal(page.data.historyEditing, true)
  assert.equal(page.data.id, 'first')
  assert.equal(updates, 1)
  finish()
  await saving
  assert.equal(page.data.historyEditing, false)
  assert.deepEqual(draftState(page), draft)
})

test('历史弹窗关闭满 300ms 才恢复草稿，关闭期间阻止操作，卸载取消回写', async () => {
  for (const unload of ['never', 'after-timer', 'before-render']) {
    let now = 0
    let nextTimer = 0
    let writes = 0
    const timers = new Map()
    const routes = []
    const advance = ms => {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.due > now) continue
        timers.delete(id)
        timer.callback()
      }
    }
    const records = [
      { _id: 'first', date: dayBefore(today()), itemIds: ['a'], note: '第一条' },
      { _id: 'second', date: '2022-01-01', itemIds: ['b'], note: '第二条' }
    ]
    const page = loadPage('today-wear', {
      listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }],
      listOutfits: async () => [],
      listWearRecords: async () => records,
      addWearRecord: async () => { writes++; return 'new' },
      updateWearRecord: async () => { writes++; return {} },
      deleteWearRecord: async () => { writes++ }
    }, {
      navigateTo: ({ url }) => routes.push(url),
      testSetTimeout: (callback, delay) => {
        const id = ++nextTimer
        timers.set(id, { callback, due: now + delay })
        return id
      },
      testClearTimeout: id => timers.delete(id)
    })
    await page.onLoad({})
    page.setData({ selectedIds: ['b'], note: '上方新增草稿' })
    page.syncSelected()
    const draft = draftState(page)
    page.onHistoryTap({ currentTarget: { dataset: { id: 'first' } } })
    page.onNoteInput({ detail: { value: '弹窗未保存的编辑' } })
    const editing = draftState(page)
    const renderCallbacks = []
    if (unload === 'before-render') {
      const setData = page.setData
      page.setData = (patch, callback) => {
        setData(patch)
        if (callback) renderCallbacks.push(callback)
      }
    }

    page.onCancelHistoryEdit()
    assert.equal(page.data.historyClosing, true)
    assert.equal(page.data.historyEditing, true)
    assert.deepEqual(draftState(page), editing)
    if (unload === 'before-render') {
      assert.equal(timers.size, 0)
      assert.equal(renderCallbacks.length, 1)
      page.onUnload()
      const state = structuredClone(page.data)
      let lateUpdates = 0
      const setData = page.setData
      page.setData = patch => { lateUpdates++; setData(patch) }
      for (const callback of renderCallbacks) callback()
      advance(300)
      assert.equal(nextTimer, 0)
      assert.equal(lateUpdates, 0)
      assert.deepEqual(page.data, state)
      assert.equal(writes, 0)
      continue
    }
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].due, 300)
    page.onCancelHistoryEdit()
    page.onResetTap()
    page.onHistoryTap({ currentTarget: { dataset: { id: 'second' } } })
    page.onQuickAddTap()
    await page.onSave()
    await page.onSaveAsOutfit()
    assert.equal(nextTimer, 1)
    assert.equal(writes, 0)
    assert.deepEqual(routes, [])
    advance(299)
    assert.equal(page.data.historyEditing, true)
    assert.deepEqual(draftState(page), editing)

    if (unload === 'after-timer') {
      page.onUnload()
      assert.equal(timers.size, 0)
      const state = structuredClone(page.data)
      let lateUpdates = 0
      const setData = page.setData
      page.setData = patch => { lateUpdates++; setData(patch) }
      advance(1)
      assert.equal(lateUpdates, 0)
      assert.deepEqual(page.data, state)
    } else {
      advance(1)
      assert.equal(page.data.historyEditing, false)
      assert.equal(page.data.historyClosing, false)
      assert.deepEqual(draftState(page), draft)
      assert.equal(timers.size, 0)
    }
    assert.equal(writes, 0)
  }
})

test('月历旧入口不预填未来日期，保存后仍返回月历', async () => {
  const future = new Date(Date.parse(today() + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  let backCount = 0
  let title = ''
  const page = loadPage('wear-edit', {
    listItems: async () => [{ _id: 'a', name: '衬衫' }],
    listOutfits: async () => [],
    listWearRecords: async () => [],
    addWearRecord: async () => 'new'
  }, { navigateBack: () => { backCount++ }, testSetTimeout: fn => fn(), setNavigationBarTitle: options => { title = options.title } })
  await page.onLoad({ date: future })
  assert.equal(title, '记录穿着')
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

test('历史编辑入库刷新失败可重试，切换记录并取消后恢复新增草稿', async () => {
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
  page.onItemToggle({ currentTarget: { dataset: { id: 'b' } } })
  page.onNoteInput({ detail: { value: '新增草稿' } })
  const draft = draftState(page)
  page.onHistoryTap({ currentTarget: { dataset: { id: 'first' } } })
  page.onNoteInput({ detail: { value: '编辑中的备注' } })
  page.onQuickAddTap()
  items = [...items, { _id: 'c', name: '新毛衣' }]
  await page.onShow()
  assert.equal(page.data.itemRefreshError, '衣橱刷新失败，点此重试')
  assert.equal(page.data.id, 'first')
  assert.equal(page.data.note, '编辑中的备注')
  await page.refreshItemsAfterQuickAdd()
  assert.equal(page.data.itemRefreshError, '')
  assert.equal(page.data.recentlyAdded[0]._id, 'c')
  page.onItemToggle({ currentTarget: { dataset: { id: 'c' } } })
  assert.deepEqual(Array.from(page.data.selectedIds), ['a', 'c'])
  page.onHistoryTap({ currentTarget: { dataset: { id: 'second' } } })
  assert.equal(page.data.id, 'second')
  assert.equal(page.data.note, '另一条')
  assert.deepEqual(Array.from(page.data.selectedIds), ['b'])
  assert.equal(page.data.recentlyAdded.length, 0)
  page.onCancelHistoryEdit()
  assert.deepEqual(draftState(page), draft)
  assert.equal(page.data.items.some(item => item._id === 'c'), true)
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

test('主动保存为穿搭先保存实穿，历史编辑回程取消恢复草稿，取消收藏后记录仍可编辑', async () => {
  for (const historyEditing of [false, true]) {
    const records = historyEditing ? [{ _id: 'wear-1', date: dayBefore(today()), itemIds: ['a'], note: '旧实穿' }] : []
    const routes = []
    const outfits = []
    let failSync = false
    let added = 0
    let updated = 0
    const page = loadPage('today-wear', {
      listItems: async () => [{ _id: 'a', name: '衬衫' }, { _id: 'b', name: '长裤' }],
      listOutfits: async () => outfits,
      listWearRecords: async () => records,
      getWearRecord: async id => { if (failSync) throw Error('offline'); return records.find(row => row._id === id) },
      addWearRecord: async data => { added++; records.push({ _id: 'wear-1', ...data }); return 'wear-1' },
      updateWearRecord: async (id, data) => { updated++; Object.assign(records.find(row => row._id === id), data); return {} }
    }, { navigateTo: ({ url }) => routes.push(url), pageScrollTo() {} })
    await page.onLoad({})
    page.onItemToggle({ currentTarget: { dataset: { id: historyEditing ? 'b' : 'a' } } })
    page.onNoteInput({ detail: { value: '尚未提交的草稿' } })
    const draft = draftState(page)
    if (historyEditing) page.onHistoryTap({ currentTarget: { dataset: { id: 'wear-1' } } })
    await page.onSaveAsOutfit()
    assert.equal(added, historyEditing ? 0 : 1)
    assert.equal(updated, historyEditing ? 1 : 0)
    assert.equal(page.data.id, 'wear-1')
    assert.deepEqual(Array.from(records[0].itemIds), ['a'])
    assert.equal(routes[0], '/pages/outfit-edit/outfit-edit?wearRecordId=wear-1')

    await page.onShow()
    assert.equal(records.length, 1)
    assert.equal(page.data.history[0]._id, 'wear-1')
    if (historyEditing) {
      assert.equal(page.data.historyEditing, true)
      page.onCancelHistoryEdit()
      assert.deepEqual(draftState(page), draft)
      assert.equal(updated, 1)
      page.onHistoryTap({ currentTarget: { dataset: { id: 'wear-1' } } })
    }

    outfits.push({ _id: 'fit-1', name: '新收藏', itemIds: ['a'] })
    records[0].outfitId = 'fit-1'
    failSync = true
    page._returningFromOutfitEdit = true
    await page.onShow()
    assert.equal(page.data.outfitSyncError, '穿搭状态刷新失败，点此重试')
    await page.onSave()
    assert.equal(updated, historyEditing ? 1 : 0)
    failSync = false
    await page.refreshAfterOutfitEdit()
    assert.equal(page.data.outfitSyncError, '')
    assert.equal(page.data.outfitId, 'fit-1')
    await page.onSave()
    assert.equal(added, historyEditing ? 0 : 1)
    assert.equal(updated, historyEditing ? 2 : 1)
    assert.equal(records[0].outfitId, 'fit-1')
    if (historyEditing) {
      assert.equal(page.data.historyEditing, false)
      assert.deepEqual(draftState(page), draft)
      assert.equal(page.data.outfits[0]._id, 'fit-1')
    }
  }
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
