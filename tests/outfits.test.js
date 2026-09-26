const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

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
