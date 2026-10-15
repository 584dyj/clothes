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
