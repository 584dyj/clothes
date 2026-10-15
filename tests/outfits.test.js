const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')
const { CATEGORIES } = require('../cloudfunctions/auth/categories')
const { today } = require('../utils/date')

test('穿搭列表按服务端页追加，触底不会重复请求', async () => {
  const outfits = Array.from({ length: 45 }, (_, index) => ({ _id: `fit-${index}`, name: `搭配${index}`, itemIds: [] }))
  const offsets = []
  const page = loadPage('outfits', {
    listItems: async () => [],
    listOutfitsPage: async offset => { offsets.push(offset); return outfits.slice(offset, offset + 20) },
    listWearRecords: async () => []
  })
  await page.loadData()
  assert.deepEqual(offsets, [0])
  assert.equal(page.data.left.length + page.data.right.length, 20)
  await page.onReachBottom()
  assert.deepEqual(offsets, [0, 20])
  assert.equal(page.data.left.length + page.data.right.length, 40)
  await page.onReachBottom()
  assert.equal(page.data.left.length + page.data.right.length, 45)
  assert.equal(page.data.hasMore, false)
  await page.onReachBottom()
  assert.deepEqual(offsets, [0, 20, 40])
})

test('穿搭编辑按 18 类分组选品，跨分类选择含其他不丢失并保存', async () => {
  const saved = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [
      { _id: 'shirt', name: '白衬衫', category: '衬衫' },
      { _id: 'charm', name: '玩偶', category: '挂件' },
      { _id: 'misc', name: '摆件', category: '其他' },
      { _id: 'bag', name: '帆布包袋', category: '包袋' }
    ],
    listOutfits: async () => [],
    addOutfit: async data => { saved.push(data) }
  }, { showToast() {} })
  await page.onLoad({})
  assert.deepEqual(Array.from(page.data.categories), ['全部', '已选', ...CATEGORIES])

  const tap = value => page.onCategoryTap({ currentTarget: { dataset: { value } } })
  const toggle = id => page.onItemToggle({ currentTarget: { dataset: { id } } })
  tap('挂件')
  assert.deepEqual(page.data.viewItems.map(item => item._id), ['charm'])
  toggle('charm')
  tap('其他')
  toggle('misc')
  tap('衬衫')
  toggle('shirt')
  tap('已选')
  assert.deepEqual(page.data.viewItems.map(item => item._id).sort(), ['charm', 'misc', 'shirt'])
  page.onNameInput({ detail: { value: '周末搭配' } })
  await page.onSave()
  assert.equal(saved.length, 1)
  assert.deepEqual(Array.from(saved[0].itemIds).sort(), ['charm', 'misc', 'shirt'])
})

test('从实穿保存收藏时固定衣物组合，创建成功后关联原记录', async () => {
  const created = [], linked = [], returns = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'shirt', name: '衬衫' }, { _id: 'bag', name: '包' }],
    getWearRecord: async id => { assert.equal(id, 'wear-1'); return { itemIds: ['bag', 'shirt'] } },
    addOutfit: async data => { created.push(data); return 'fit-1' },
    linkWearOutfit: async (...args) => { linked.push(args) }
  }, { testSetTimeout: fn => { returns.push(fn) } })
  await page.onLoad({ wearRecordId: 'wear-1' })
  assert.equal(page.data.ready, true)
  assert.deepEqual(Array.from(page.data.selectedIds), ['bag', 'shirt'])
  page.onItemToggle({ currentTarget: { dataset: { id: 'shirt' } } })
  assert.deepEqual(Array.from(page.data.selectedIds), ['bag', 'shirt'])
  page.onNameInput({ detail: { value: '周末穿搭' } })
  await page.onSave()
  assert.equal(created.length, 1)
  assert.deepEqual(Array.from(created[0].itemIds), ['bag', 'shirt'])
  assert.deepEqual(linked, [['wear-1', 'fit-1']])
  assert.equal(returns.length, 1)
})

test('收藏已创建但关联失败时只重试关联，不重复创建或上传', async () => {
  let uploads = 0, creates = 0, links = 0
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'shirt', name: '衬衫' }],
    getWearRecord: async () => ({ itemIds: ['shirt'] }),
    uploadImage: async () => { uploads++; return 'cloud://saved' },
    addOutfit: async () => { creates++; return 'fit-2' },
    linkWearOutfit: async () => { links++; if (links === 1) throw Error('offline') }
  })
  await page.onLoad({ wearRecordId: 'wear-2' })
  page.setData({ name: '秋日搭配', imagePath: '/tmp/fit.jpg' })
  await page.onSave()
  assert.equal(page.data.createdOutfitId, 'fit-2')
  assert.match(page.data.linkError, /关联实穿失败/)
  assert.equal(page.data.imagePath, '')
  page.onNameInput({ detail: { value: '被忽略的修改' } })
  assert.equal(page.data.name, '秋日搭配')
  await page.onSave()
  assert.deepEqual([creates, uploads, links], [1, 1, 2])
  assert.equal(page.data.linkError, '')
})

test('实穿引用的衣物已删除时禁止创建收藏', async () => {
  let creates = 0
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'shirt' }],
    getWearRecord: async () => ({ itemIds: ['shirt', 'deleted'] }),
    addOutfit: async () => { creates++ }
  })
  await page.onLoad({ wearRecordId: 'wear-3' })
  assert.equal(page.data.ready, false)
  assert.match(page.data.loadError, /实穿衣物已从衣橱删除/)
  await page.onSave()
  assert.equal(creates, 0)
})

test('保存后手动离开会取消延迟返回，保存中离开也不安排返回', async () => {
  const timers = new Map(), cleared = []
  let nextTimer = 0, backs = 0
  const wx = {
    testSetTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
    testClearTimeout: id => { cleared.push(id); timers.delete(id) },
    navigateBack: () => { backs++ }
  }
  const db = { listItems: async () => [{ _id: 'shirt' }], listOutfits: async () => [], addOutfit: async () => 'fit' }
  const page = loadPage('outfit-edit', db, wx)
  await page.onLoad({})
  page.setData({ name: '穿搭', selectedIds: ['shirt'] })
  await page.onSave()
  assert.equal(timers.size, 1)
  const scheduled = [...timers.values()][0]
  page.onUnload()
  assert.deepEqual(cleared, [1])
  scheduled()
  assert.equal(backs, 0)

  let finishSave
  const pending = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'shirt' }],
    listOutfits: async () => [],
    addOutfit: () => new Promise(resolve => { finishSave = resolve })
  }, wx)
  await pending.onLoad({})
  pending.setData({ name: '另一套', selectedIds: ['shirt'] })
  const saving = pending.onSave()
  // 新增前会先 await 重复搭配检查，等真正进入写入（addOutfit 被调用）后再模拟保存中离开。
  while (!finishSave) await new Promise(resolve => setTimeout(resolve, 0))
  pending.onUnload()
  finishSave('fit-2')
  await saving
  assert.equal(timers.size, 0)
  assert.equal(backs, 0)
})

test('我的穿搭列表「+」进入快速录入', () => {
  const urls = []
  const page = loadPage('outfits', { listItems: async () => [], listOutfitsPage: async () => [] },
    { navigateTo: options => urls.push(options.url) })
  page.onAddTap()
  assert.equal(urls[0], '/pages/outfit-edit/outfit-edit?quick=1')
})

test('快速录入：留空名称按已选单品自动命名并可保存', async () => {
  const saved = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [
      { _id: 'a', name: '白衬衫' },
      { _id: 'b', name: '牛仔裙' },
      { _id: 'c', name: '帆布鞋' }
    ],
    listOutfits: async () => [],
    addOutfit: async data => { saved.push(data) }
  }, { showToast() {} })
  await page.onLoad({ quick: '1' })
  assert.equal(page.data.quick, true)

  const toggle = id => page.onItemToggle({ currentTarget: { dataset: { id } } })
  toggle('a')
  assert.equal(page.autoName(), '白衬衫')
  toggle('b')
  assert.equal(page.autoName(), '白衬衫·牛仔裙')
  toggle('c')
  assert.equal(page.autoName(), '白衬衫·牛仔裙 等3件')

  page.onNoteInput({ detail: { value: '配黑色裤袜' } })
  await page.onSave()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, '白衬衫·牛仔裙 等3件')
  assert.equal(saved[0].note, '配黑色裤袜')
  assert.deepEqual(Array.from(saved[0].itemIds), ['a', 'b', 'c'])
})

test('自动命名：超长名称截断至 20 字符', async () => {
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '测'.repeat(30) }]
  })
  await page.onLoad({ quick: '1' })
  page.setData({ selectedIds: ['a'] })
  assert.equal(page.autoName(), '测'.repeat(20))
  assert.equal(page.autoName().length, 20)
})

test('快速录入未选单品时提示先选衣物而非名称', async () => {
  let creates = 0
  const toasts = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    addOutfit: async () => { creates++ }
  }, { showToast: options => toasts.push(options) })
  await page.onLoad({ quick: '1' })
  await page.onSave()
  assert.equal(creates, 0)
  assert.equal(toasts.at(-1).title, '请至少选择一件衣物')
})

test('完整新建流程仍要求填写名称', async () => {
  let creates = 0
  const toasts = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    addOutfit: async () => { creates++ }
  }, { showToast: options => toasts.push(options) })
  await page.onLoad({})
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  await page.onSave()
  assert.equal(creates, 0)
  assert.equal(toasts.at(-1).title, '请填写穿搭名称')
})

test('带 id 或 wearRecordId 进入时不启用快速录入', async () => {
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    getOutfit: async () => ({ _id: 'fit-1', name: '春游', itemIds: ['a'] })
  })
  await page.onLoad({ id: 'fit-1', quick: '1' })
  assert.equal(page.data.quick, false)
  assert.equal(page.data.name, '春游')
})

test('实穿组合变化时保留已收藏穿搭并引导返回处理', async () => {
  let creates = 0, links = 0, backs = 0
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'shirt' }],
    getWearRecord: async () => ({ itemIds: ['shirt'] }),
    addOutfit: async () => { creates++; return 'fit-3' },
    linkWearOutfit: async () => { links++; throw Error('穿搭衣物与实穿记录不一致，请刷新后重试') }
  }, { navigateBack: () => { backs++ } })
  await page.onLoad({ wearRecordId: 'wear-3' })
  page.setData({ name: '春装' })
  await page.onSave()
  assert.equal(page.data.createdOutfitId, 'fit-3')
  assert.equal(page.data.linkNeedsReturn, true)
  assert.match(page.data.linkError, /返回实穿页处理/)
  await page.onSave()
  assert.deepEqual([creates, links, backs], [1, 1, 1])
})

test('我的穿搭卡片透传备注行', async () => {
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', imageFileID: 'cloud://x' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', note: '配黑色裤袜', itemIds: ['a'] }],
    listWearRecords: async () => []
  })
  await page.loadData()
  const card = [...page.data.left, ...page.data.right][0]
  assert.equal(card.note, '配黑色裤袜')
})

test('新增保存遇到相同单品组合：选择查看该搭配则不保存并跳转', async () => {
  let creates = 0
  const routes = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    listOutfits: async () => [{ _id: 'f1', name: '已有搭配', note: '别的备注', itemIds: ['a'] }],
    addOutfit: async () => { creates++ }
  }, {
    showModal: options => options.success({ confirm: true, cancel: false }),
    navigateTo: options => routes.push(options.url)
  })
  await page.onLoad({ quick: '1' })
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  await page.onSave()
  assert.equal(creates, 0)
  assert.equal(routes[0], '/pages/outfit-edit/outfit-edit?id=f1')
})

test('相同单品组合选择仍要新建则继续保存', async () => {
  const saved = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    listOutfits: async () => [{ _id: 'f1', name: '已有搭配', itemIds: ['a'] }],
    addOutfit: async data => { saved.push(data) }
  }, { showModal: options => options.success({ confirm: false, cancel: true }) })
  await page.onLoad({})
  page.onItemToggle({ currentTarget: { dataset: { id: 'a' } } })
  page.onNameInput({ detail: { value: '新搭配' } })
  await page.onSave()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, '新搭配')
})

test('单品组合不同不触发重复提示直接保存', async () => {
  let modals = 0
  const saved = []
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }, { _id: 'b', name: '牛仔裙' }],
    listOutfits: async () => [{ _id: 'f1', name: '已有', itemIds: ['a', 'c'] }],
    addOutfit: async data => { saved.push(data) }
  }, { showModal: () => { modals++ } })
  await page.onLoad({ quick: '1' })
  page.onItemToggle({ currentTarget: { dataset: { id: 'b' } } })
  await page.onSave()
  assert.equal(modals, 0)
  assert.equal(saved.length, 1)
})

test('编辑已有穿搭不触发重复提示', async () => {
  let modals = 0, writes = 0
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    getOutfit: async () => ({ _id: 'f1', name: '春装', itemIds: ['a'] }),
    listOutfits: async () => [{ _id: 'f1', name: '春装', itemIds: ['a'] }],
    updateOutfit: async () => { writes++; return {} }
  }, { showModal: () => { modals++ } })
  await page.onLoad({ id: 'f1' })
  await page.onSave()
  assert.equal(modals, 0)
  assert.equal(writes, 1)
})

// ---------- MATCH-03 「今天穿了」可选静默打卡 ----------

const outfitCard = page => [...page.data.left, ...page.data.right].find(item => item._id === 'f1')

test('「今天穿了」按当天日期与搭配快照写入实穿，成功后转已记录', async () => {
  const writes = []
  const toasts = []
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }, { _id: 'b', name: '牛仔裙' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', itemIds: ['a', 'b'] }],
    listWearRecords: async () => [],
    addWearRecord: async data => { writes.push(data); return 'wear-1' }
  }, { showToast: options => toasts.push(options) })
  await page.loadData()
  assert.equal(outfitCard(page).wornToday, false)
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].date, today())
  assert.deepEqual(Array.from(writes[0].itemIds), ['a', 'b'])
  assert.equal(writes[0].outfitId, 'f1')
  assert.equal(writes[0].note, '')
  assert.equal(outfitCard(page).wornToday, true)
  assert.equal(page.data.wearBusyId, '')
  assert.equal(toasts.at(-1).title, '已记录今天穿着')
})

test('已记录的搭配再次点击不再提交', async () => {
  let writes = 0
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', itemIds: ['a'] }],
    listWearRecords: async () => [{ _id: 'w1', date: today(), itemIds: ['a'], outfitId: 'f1' }],
    addWearRecord: async () => { writes++ }
  })
  await page.loadData()
  assert.equal(outfitCard(page).wornToday, true)
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(writes, 0)
})

test('当日已有同衣物集合的手动实穿时初始即已记录', async () => {
  const writes = []
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }, { _id: 'b', name: '牛仔裙' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', itemIds: ['a', 'b'] }],
    // 顺序不同、无 outfitId，靠衣物集合相等判定已记录
    listWearRecords: async () => [{ _id: 'w1', date: today(), itemIds: ['b', 'a'] }],
    addWearRecord: async data => { writes.push(data) }
  })
  await page.loadData()
  assert.equal(outfitCard(page).wornToday, true)
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(writes.length, 0)
})

test('服务端同日同集合判重被拒按已记录处理', async () => {
  const toasts = []
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', itemIds: ['a'] }],
    listWearRecords: async () => [],
    addWearRecord: async () => { throw new Error('同一天已记录相同衣物组合') }
  }, { showToast: options => toasts.push(options) })
  await page.loadData()
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(outfitCard(page).wornToday, true)
  assert.equal(page.data.wearBusyId, '')
  assert.equal(toasts.at(-1).title, '今天已记录')
})

test('写入失败时提示且按钮恢复可点', async () => {
  const toasts = []
  let attempts = 0
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', itemIds: ['a'] }],
    listWearRecords: async () => [],
    addWearRecord: async () => { attempts++; throw new Error('offline') }
  }, { showToast: options => toasts.push(options) })
  await page.loadData()
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(outfitCard(page).wornToday, false)
  assert.equal(page.data.wearBusyId, '')
  assert.equal(toasts.at(-1).title, '记录失败，请重试')
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(attempts, 2)
})

test('写入进行中忽略重复点击', async () => {
  let finish
  let writes = 0
  const page = loadPage('outfits', {
    listItems: async () => [{ _id: 'a', name: '白衬衫' }],
    listOutfitsPage: async () => [{ _id: 'f1', name: '春装', itemIds: ['a'] }],
    listWearRecords: async () => [],
    addWearRecord: () => new Promise(resolve => { writes++; finish = resolve })
  })
  await page.loadData()
  const saving = page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(writes, 1)
  assert.equal(page.data.wearBusyId, 'f1')
  finish()
  await saving
  assert.equal(page.data.wearBusyId, '')
})

test('空搭配不写入实穿并提示', async () => {
  let writes = 0
  const toasts = []
  const page = loadPage('outfits', {
    listItems: async () => [],
    listOutfitsPage: async () => [{ _id: 'f1', name: '空搭配', itemIds: [] }],
    listWearRecords: async () => [],
    addWearRecord: async () => { writes++ }
  }, { showToast: options => toasts.push(options) })
  await page.loadData()
  await page.onWearTodayTap({ currentTarget: { dataset: { id: 'f1' } } })
  assert.equal(writes, 0)
  assert.equal(toasts.at(-1).title, '这套搭配还没有衣物')
})
