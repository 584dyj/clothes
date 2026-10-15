const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')
const { CATEGORIES } = require('../cloudfunctions/auth/categories')

test('穿搭列表按服务端页追加，触底不会重复请求', async () => {
  const outfits = Array.from({ length: 45 }, (_, index) => ({ _id: `fit-${index}`, name: `搭配${index}`, itemIds: [] }))
  const offsets = []
  const page = loadPage('outfits', {
    listItems: async () => [],
    listOutfitsPage: async offset => { offsets.push(offset); return outfits.slice(offset, offset + 20) }
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
  const db = { listItems: async () => [{ _id: 'shirt' }], addOutfit: async () => 'fit' }
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
    addOutfit: () => new Promise(resolve => { finishSave = resolve })
  }, wx)
  await pending.onLoad({})
  pending.setData({ name: '另一套', selectedIds: ['shirt'] })
  const saving = pending.onSave()
  pending.onUnload()
  finishSave('fit-2')
  await saving
  assert.equal(timers.size, 0)
  assert.equal(backs, 0)
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
