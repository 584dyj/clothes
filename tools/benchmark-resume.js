// ponytail: 本地合成数据对照，仅计数请求和 JSON 字节；耗时结论需真机测量。
// 运行：node tools/benchmark-resume.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { loadPage } = require('../tests/support/page')
const source = fs.readFileSync(path.join(__dirname, '../utils/db.js'), 'utf8')
const reduction = (before, after) => Number(((before - after) / before * 100).toFixed(2))

async function measure(count, uncached) {
  const clothes = Array.from({ length: count }, (_, i) => ({
    _id: 'item-' + i, name: '衣物 ' + i, category: ['上衣', '下装', '鞋'][i % 3],
    brand: 'Brand ' + i % 20, color: '白色', seasons: ['春秋'], size: 'M',
    price: 100 + i, purchaseDate: '2026-09-01', note: '合成数据',
    imageFileID: 'cloud://synthetic/wardrobe/' + String(i).padStart(32, '0') + '.jpg'
  }))
  const outfits = Array.from({ length: count / 5 }, (_, i) => ({
    _id: 'outfit-' + i, name: '穿搭 ' + i,
    itemIds: ['item-' + i, 'item-' + (i + 1)], imageFileID: ''
  }))
  // 统计页还会读取账本与穿着记录，保持与真实列表页同规模。
  const expenses = Array.from({ length: count / 5 }, (_, i) => ({ _id: 'exp-' + i, category: '洗护', amount: 20, date: '2026-09-01' }))
  const wearRecords = Array.from({ length: count / 5 }, (_, i) => ({ _id: 'wear-' + i, date: '2026-09-01', itemIds: ['item-' + i], outfitId: '' }))
  const pool = { clothes, outfits, expenses, wear_records: wearRecords }
  let requests = 0
  const sandbox = { module: { exports: {} }, console, wx: { cloud: {
    callFunction: async ({ data }) => {
      assert.equal(data.action, 'data')
      assert.equal(data.operation, 'list')
      requests++
      return { result: { success: true, data: (pool[data.collection] || [])
        .slice(data.offset, data.offset + 20) } }
    }
  } } }
  // 对照组复用真实分页与归一化逻辑，仅绕过缓存和在途请求复用。
  const baseline = uncached ? `
    module.exports.listItems = () => listAll('clothes').then(rows => rows.map(normalizeItem));
    module.exports.listOutfits = () => listAll('outfits');
  ` : ''
  vm.runInNewContext(source + baseline, sandbox)
  const db = sandbox.module.exports
  const wardrobe = loadPage('wardrobe', db)
  const outfitPage = loadPage('outfits', db)
  const stats = loadPage('stats', db)
  wardrobe.onLoad()
  // 缓存有效期内依次进入三个页面；只调用数据加载，不计登录校验请求。
  await wardrobe.loadItems()
  await outfitPage.loadData()
  await stats.loadStats()
  assert.equal(stats.data.totalItems, count)
  assert.equal(stats.data.totalOutfits, outfits.length)
  const firstPass = requests
  await wardrobe.loadItems()
  await outfitPage.loadData()
  await stats.loadStats()
  const repeatPass = requests - firstPass

  const cards = () => ({ left: outfitPage.data.left, right: outfitPage.data.right })
  const firstCards = cards().left.length + cards().right.length
  const firstBytes = Buffer.byteLength(JSON.stringify(cards()))
  while (outfitPage.data.hasMore) await outfitPage.onReachBottom()
  const allCards = cards().left.length + cards().right.length
  const allBytes = Buffer.byteLength(JSON.stringify(cards()))
  assert.equal(firstCards, Math.min(20, outfits.length))
  assert.equal(allCards, outfits.length)

  db.clearCache()
  const start = requests
  const parallel = await Promise.all([db.listItems(), db.listItems(), db.listItems()])
  parallel.forEach(rows => assert.equal(rows.length, count))
  const parallelRequests = requests - start
  return { firstPass, repeatPass, parallelRequests, firstCards, allCards, firstBytes, allBytes }
}

;(async () => {
  const results = []
  for (const count of [100, 500, 1000]) {
    const before = await measure(count, true)
    const after = await measure(count, false)
    const clothesPages = Math.floor(count / 20) + 1
    const outfitPages = Math.floor(count / 5 / 20) + 1
    // 衣物/穿搭在对照组绕过缓存（每次全量重读）；账本/穿着记录走缓存（首读一次、复读命中）。
    // 穿搭列表每次只取首批 20 条，统计页仍全量读取穿搭。
    assert.equal(before.firstPass, clothesPages * 3 + 1 + outfitPages * 3)
    assert.equal(before.repeatPass, clothesPages * 3 + 1 + outfitPages)
    assert.equal(after.firstPass, clothesPages + 1 + outfitPages * 3)
    assert.equal(after.repeatPass, 1)
    assert.equal(before.parallelRequests, clothesPages * 3)
    assert.equal(after.parallelRequests, clothesPages)
    assert.equal(before.allBytes, after.allBytes)
    results.push({ clothes: count, outfits: count / 5, before, after,
      requestReductionPercent: reduction(before.firstPass, after.firstPass),
      parallelReductionPercent: reduction(before.parallelRequests, after.parallelRequests),
      initialCardReductionPercent: reduction(after.allCards, after.firstCards),
      initialListJsonReductionPercent: reduction(after.allBytes, after.firstBytes)
    })
  }
  console.log(JSON.stringify({ node: process.version,
    scope: '合成数据；对照组绕过缓存和请求复用；仅列表数据请求；穿搭列表首批 20 条，统计页读取全量；不代表历史版本或真机耗时',
    results }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
