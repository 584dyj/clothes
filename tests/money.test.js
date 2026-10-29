const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const { loadPage, loadComponent } = require('./support/page')
const { priceOf, centsOf } = require('../utils/money')
const { inventory, getInventory } = require('../cloudfunctions/auth/recommend')
const purchase = require('../cloudfunctions/auth/purchase')

test('未填价格与0元在单件、批量保存及服务端往返中保持区别', async () => {
  const cloud = loadCloud({ users: [{ _id: 'u', openid: 'openid-1' }] })
  let sequence = 0
  for (const [input, expected] of [['', null], ['0', 0], ['0.10', 0.1]]) {
    const saved = []
    const db = { addItem: async data => {
      saved.push(data)
      const result = await cloud.main({ action: 'data', operation: 'add', collection: 'clothes', id: 'price-' + sequence++, data })
      assert.equal(result.success, true, result.error)
      return result._id
    } }
    const single = loadPage('item-edit', db)
    await single.onLoad({})
    single.setData({ name: '衣物', category: '衬衫', price: input })
    await single.onSave()
    assert.equal(saved[0].price, expected)
    assert.equal(cloud.records.clothes.at(-1).price, expected)
    const edit = loadPage('item-edit', { getItem: async () => cloud.records.clothes.at(-1) })
    await edit.onLoad({ id: cloud.records.clothes.at(-1)._id })
    assert.equal(edit.data.price, expected === null ? '' : String(expected))
    const batch = loadComponent('batch-panel')
    assert.equal(batch.buildPayload({ name: '衣物', category: '衬衫', price: input }).price, expected)
  }
  for (const price of [-1, NaN, Infinity, '10', {}, false]) {
    const result = await cloud.main({ action: 'data', operation: 'add', collection: 'clothes',
      data: { name: '非法金额', category: '衬衫', seasons: [], price } })
    assert.equal(result.success, false)
  }
})

test('金额读取兼容旧数字字符串，空值不作为免费价格，汇总使用整数分', () => {
  for (const value of [undefined, null, '', '  ', NaN, Infinity, -1, false, {}]) assert.equal(priceOf(value), null)
  assert.equal(priceOf('0'), 0)
  assert.equal(priceOf('12.30'), 12.3)
  assert.equal(centsOf(0.1) + centsOf(0.2), 30)
  assert.equal(centsOf(null), 0)
})

test('统计区分缺价与0元，删除后汇总随现存记录变化', async () => {
  let items = [
    { _id: 'paid', name: '有价格', category: '衬衫', price: 0.1 },
    { _id: 'zero', category: '衬衫', price: 0 },
    { _id: 'unknown', category: '马甲', price: null },
    { _id: 'legacy', category: '短袖' }
  ]
  const page = loadPage('stats', { listItems: async () => items, listOutfits: async () => [],
    listWearRecords: async () => [], listExpenses: async () => [{ amount: 0.2, category: '洗护' }] })
  await page.loadStats()
  assert.equal(page.data.itemSpent, 0.1)
  assert.equal(page.data.totalSpent, 0.3)
  assert.equal(page.data.unpricedCount, 2)
  assert.equal(page.data.categoryStats.find(row => row.name === '衬衫').pricedCount, 2)
  assert.equal(page.data.categoryStats.find(row => row.name === '马甲').pricedCount, 0)
  items = items.filter(item => item._id !== 'paid')
  await page.loadStats(true)
  assert.equal(page.data.totalSpent, 0.2)
  assert.equal(page.data.unpricedCount, 2)
})

test('月历保留0元和缺价购买记录，已填合计和缺价数量分别展示', async () => {
  const date = '2026-10-20'
  const page = loadPage('calendar', {
    listItems: async () => [
      { _id: 'paid', purchaseDate: date, price: 0.1 }, { _id: 'zero', purchaseDate: date, price: 0 },
      { _id: 'missing', purchaseDate: date, price: null }, { _id: 'old', purchaseDate: '2026-09-20' }
    ], listExpenses: async () => [{ date, amount: 0.2 }], listPlans: async () => [], listOutfits: async () => [],
    listStickers: async () => [
      { _id: 's', purchasedAt: date, status: 'owned', price: null },
      { _id: 'free', purchasedAt: date, status: 'done', price: 0 },
      { _id: 'wish', purchasedAt: date, status: 'wishlist', price: null }
    ]
  })
  page._year = 2026; page._month = 10
  await page.loadData()
  page.selectDate(date)
  assert.equal(page.data.monthTotal, 0.3)
  assert.equal(page.data.monthUnpricedCount, 1)
  assert.equal(page.data.monthUnpricedStickerCount, 1)
  assert.deepEqual(Array.from(page.data.dayItems, item => item.priceText), ['¥0.10', '¥0.00', '未填价格'])
  assert.deepEqual(Array.from(page.data.dayStickers, item => item.amountText), ['未填单价', '¥0.00'])
  assert.equal(page.data.selectedTotal, 0.3)
  assert.equal(page.data.hasDayRecords, true)
})

test('金额排序将缺价放最后，最贵衣物忽略缺价，详情保留明确的0元', () => {
  const items = [{ _id: 'missing', price: null }, { _id: 'free', price: 0 }, { _id: 'paid', price: 10 }]
  const category = loadPage('category')
  category._categoryItems = items
  category.setData({ sortKey: 'price', sortDesc: false })
  category.applySort()
  assert.deepEqual(Array.from(category.data.items, item => item._id), ['free', 'paid', 'missing'])
  category.setData({ sortDesc: true }); category.applySort()
  assert.deepEqual(Array.from(category.data.items, item => item._id), ['paid', 'free', 'missing'])
  const profile = loadPage('profile')
  assert.equal(profile.findMostExpensive([{ price: null }, {}]), null)
  assert.equal(profile.findMostExpensive([{ price: null }, { name: '赠品', price: 0 }]).name, '赠品')
  const detail = loadPage('item-detail')
  assert.equal(detail.buildItemView({ price: null }).hasPrice, false)
  assert.equal(detail.buildItemView({ price: 0 }).priceText, '¥0.00')
})

test('预算与AI画像保留缺价并重建旧缓存，预算缺失提示不将0元计为缺价', async () => {
  const items = [
    { _id: 'paid', category: '短袖', price: 0.1, purchaseDate: '2026-10-01' },
    { _id: 'free', category: '短袖', price: 0, purchaseDate: '' },
    { _id: 'missing', category: '短袖', price: null, purchaseDate: '2026-10-01' },
    { _id: 'undated', category: '短袖', price: 20 }
  ]
  assert.equal(inventory(items).find(item => item.id === 'missing').price, null)
  const candidate = purchase.validate({ category: '长裤', color: '黑色', seasons: ['夏'], price: 0.2, monthlyBudget: 1 })
  const result = purchase.evaluate(candidate, items, [], [], new Date('2026-10-20T00:00:00Z'))
  assert.equal(result.spending.monthSpent, 0.1)
  assert.equal(result.spending.afterPurchase, 0.3)
  assert.equal(result.spending.monthUnpricedCount, 1)
  assert.equal(result.spending.undatedCount, 1)
  const cloud = loadCloud({ clothes: items.map(item => ({ ...item, _openid: 'openid-1', seasons: ['夏'] })) })
  await getInventory(cloud.db, 'openid-1')
  const cache = cloud.records.ai_cache[0]
  cache.strategyVersion = 4
  cache.items.find(item => item.id === 'missing').price = 0
  const rebuilt = await getInventory(cloud.db, 'openid-1')
  assert.equal(rebuilt.items.find(item => item.id === 'missing').price, null)
  assert.equal(cloud.records.ai_cache[0].strategyVersion, 5)
})
