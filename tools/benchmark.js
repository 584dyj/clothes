// 本地合成数据测量；不包含云网络、微信渲染和图片下载时间。
const { performance } = require('node:perf_hooks')
const { loadPage } = require('../tests/support/page')

async function measure(count) {
  const clothes = Array.from({ length: count }, (_, i) => ({
    _id: 'item-' + i, name: '衣物 ' + i, category: ['上衣', '下装', '鞋'][i % 3],
    brand: 'Brand ' + i % 20, color: '白色', seasons: ['春秋'], size: 'M',
    price: 100 + i, purchaseDate: '2026-09-01', note: '合成数据',
    imageFileID: 'cloud://synthetic/wardrobe/' + String(i).padStart(32, '0') + '.jpg'
  }))
  const outfits = Array.from({ length: count / 5 }, (_, i) => ({
    _id: 'outfit-' + i, name: '穿搭 ' + i, itemIds: ['item-' + i, 'item-' + (i + 1)], imageFileID: ''
  }))
  let requests = 0, totalBytes = 0, largestBytes = 0
  global.wx = { cloud: { callFunction: async ({ data }) => {
    requests++
    return { result: { success: true, data: (data.collection === 'clothes' ? clothes : outfits).slice(data.offset, data.offset + 20) } }
  } } }
  delete require.cache[require.resolve('../utils/db')]
  const db = require('../utils/db')
  const pages = ['wardrobe', 'outfits', 'stats'].map(name => {
    const page = loadPage(name, db)
    const original = page.setData
    page.setData = patch => {
      const bytes = Buffer.byteLength(JSON.stringify(patch))
      totalBytes += bytes; largestBytes = Math.max(largestBytes, bytes)
      original(patch)
    }
    return page
  })
  pages[0].onLoad()
  const start = performance.now()
  await pages[0].loadItems()
  const wardrobeMs = performance.now() - start
  await Promise.all([pages[1].loadData(), pages[2].loadStats()])
  if (pages[2].data.totalItems !== count) throw Error('统计数量不一致')
  return { clothes: count, outfits: outfits.length, wardrobeMs, totalMs: performance.now() - start, requests, largestBytes, totalBytes }
}

;(async () => {
  const rows = []
  for (const count of [100, 500, 1000]) {
    await measure(count)
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(await measure(count))
    const row = { ...runs[0] }
    for (const key of ['wardrobeMs', 'totalMs']) row[key] = Number(runs.map(r => r[key]).sort((a, b) => a - b)[2].toFixed(3))
    rows.push(row)
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, runs: 5, results: rows }, null, 2))
})().catch(e => { console.error(e); process.exitCode = 1 })
