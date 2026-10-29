const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')
const alert = require('../cloudfunctions/weather-alert/alert')
const { ROLES } = require('../cloudfunctions/weather-alert/outfit')

const now = new Date('2026-10-09T13:30:00Z')
const date = '2026-10-10'
const item = (_id, category, seasons = ['春秋']) => ({ _id, _openid: 'u', name: _id, category, seasons })
const wardrobe = () => [item('a', '长袖'), item('b', '长袖'), item('c', '长袖'), item('pants', '长裤'),
  item('shoes', '鞋', []), item('outer', '外套'), item('down', '羽绒服', ['春秋'])]
function setup(clothes = wardrobe()) {
  const cloud = loadCloud({ users: [{ _id: 'user', openid: 'u', autoLoginEnabled: true, cityId: '500156', cityName: '武隆' }], clothes })
  const request = async () => ({ status: '1', forecasts: [{ casts: [
    { daytemp: '20', nighttemp: '14', dayweather: '晴' },
    { daytemp: '20', nighttemp: '14', dayweather: '晴' }
  ] }] })
  const run = (args = {}) => alert.dailyRecommendation({ db: cloud.db, openid: 'u', now,
    request, env: { WEATHER_API_KEY: 'test' }, ...args })
  return { cloud, run, request }
}
const change = rec => ({ operation: 'change', date: rec.date, revision: rec.revision })

test('规则升级时站内旧方案重新匹配马甲，不继续复用缺少叠穿规则的缓存', async () => {
  const { cloud, run } = setup([...wardrobe(), item('vest', '马甲')])
  const first = (await run()).recommendation
  const saved = cloud.records.ai_cache.find(row => row.status === 'daily')
  saved.signature = JSON.stringify(['500156', saved.weather])
  saved.items = saved.items.filter(row => row.category !== '马甲')
  saved.itemIds = saved.itemIds.filter(id => id !== 'vest')
  const refreshed = await run()
  assert.ok(refreshed.recommendation.revision > first.revision)
  assert.ok(refreshed.recommendation.itemIds.includes('vest'))
  assert.match(refreshed.message, /推荐规则.*已更新/)
})

test('站内推荐无需订阅；刷新、重新进入和衣橱返回顺序变化保持选择', async () => {
  const { cloud, run } = setup()
  const first = (await run()).recommendation
  assert.ok(first.bodyKey)
  assert.ok(!first.itemIds.includes('down'))
  const changed = (await run(change(first))).recommendation
  assert.notEqual(changed.bodyKey, first.bodyKey)
  cloud.records.clothes.reverse()
  assert.deepEqual((await run()).recommendation.itemIds, changed.itemIds)
  assert.equal((await run()).recommendation.revision, changed.revision)
  assert.equal(cloud.records.subscriptions.length, 0)
  assert.equal(cloud.sentMessages.length, 0)
  assert.equal(cloud.records.wear_records.length, 0)
  assert.equal(cloud.records.outfit_plans.length, 0)
})

test('换一套遍历适温主体，耗尽后保留完整搭配；不选20℃羽绒服', async () => {
  const { run } = setup()
  let rec = (await run()).recommendation
  const seen = [rec.bodyKey]
  for (let n = 0; n < 2; n++) {
    rec = (await run(change(rec))).recommendation
    assert.ok(!seen.includes(rec.bodyKey))
    assert.ok(!rec.itemIds.includes('down'))
    seen.push(rec.bodyKey)
  }
  const exhausted = await run(change(rec))
  assert.match(exhausted.message, /已看过/)
  assert.deepEqual(exhausted.recommendation.itemIds, rec.itemIds)
  assert.equal(exhausted.recommendation.revision, rec.revision)
})

test('替换只改变同类别衣物，保留其余衣物；当前类别仅一件时解释并保留', async () => {
  const { run } = setup()
  const first = (await run()).recommendation
  const target = first.items.find(row => ROLES[row.category] === 'top')._id
  const result = await run({ operation: 'replace', date, revision: first.revision, replaceId: target })
  const rec = result.recommendation
  assert.ok(!rec.itemIds.includes(target))
  assert.equal(rec.itemIds.length, first.itemIds.length)
  assert.ok(first.itemIds.filter(id => id !== target).every(id => rec.itemIds.includes(id)))
  assert.deepEqual((await run()).recommendation.itemIds, rec.itemIds)
  const unchanged = await run({ operation: 'replace', date, revision: rec.revision, replaceId: 'outer' })
  assert.equal(unchanged.message, '当前类别只有此衣物')
  assert.deepEqual(unchanged.recommendation.itemIds, rec.itemIds)
  await assert.rejects(run({ operation: 'replace', date, revision: rec.revision, replaceId: 'someone-elses-item' }), /衣物已变化/)
})

test('连衣裙替换不改成上下装；整套更换允许两种完整主体转换', async () => {
  const { run } = setup([item('dress', '连衣裙'), item('dress2', '连衣裙'), item('shoes', '鞋', [])])
  const rec = (await run()).recommendation
  const target = rec.items.find(row => row.category === '连衣裙')._id
  const next = (await run({ operation: 'replace', date, revision: rec.revision, replaceId: target })).recommendation
  assert.notEqual(next.bodyKey, rec.bodyKey)
  assert.deepEqual(next.items.map(row => ROLES[row.category]), ['dress', 'shoes'])
  const mixed = setup([item('dress', '连衣裙'), item('top', '长袖'), item('pants', '长裤'), item('shoes', '鞋', [])])
  const first = (await mixed.run()).recommendation
  const second = (await mixed.run(change(first))).recommendation
  assert.notEqual(first.bodyKey, second.bodyKey)
  assert.deepEqual(new Set([first.bodyKey, second.bodyKey]), new Set(['dress', 'pants|top']))
})

test('换这件仅允许同类别：类别只有一件时准确提示，其他类别仍可由换一套选择', async () => {
  const { cloud, run } = setup([item('short', '短袖', ['夏']), item('long', '长袖', ['夏'])])
  cloud.records.wear_records.push({ _id: 'wear', _openid: 'u', date: '2026-10-09', itemIds: ['long'] })
  const first = (await run()).recommendation
  assert.deepEqual(first.itemIds, ['short'])
  const unchanged = await run({ operation: 'replace', date, revision: first.revision, replaceId: 'short' })
  assert.equal(unchanged.message, '当前类别只有此衣物')
  assert.equal(unchanged.recommendation.revision, first.revision)
  assert.deepEqual(unchanged.recommendation.itemIds, ['short'])
  const changed = await run(change(first))
  assert.deepEqual(changed.recommendation.itemIds, ['long'])
  const toasts = []
  const page = loadPage('weather-outfit', { dailyRecommendation: args => run(args) }, { showToast: value => toasts.push(value) })
  await page.onLoad({ daily: '1' })
  page.onItemTap({ currentTarget: { dataset: { id: 'long' } } })
  await page.onReplaceTap({ currentTarget: { dataset: { id: 'long' } } })
  assert.equal(toasts.at(-1).title, '当前类别只有此衣物')
  assert.equal(page.data.adjustMessage, '')
  assert.equal(page.data.selectedCount, 0)
})

test('同类存在但季节不适合时提示无适温候选，有适温同类时只替换该件', async () => {
  for (const otherSeasons of [['冬'], ['夏']]) {
    const { cloud, run } = setup([item('short-a', '短袖', ['夏']), item('short-b', '短袖', otherSeasons),
      item('long', '长袖', ['夏']), item('pants', '长裤'), item('shoes', '鞋', [])])
    cloud.records.wear_records.push({ _id: 'wear', _openid: 'u', date: '2026-10-09', itemIds: ['long'] })
    const first = (await run()).recommendation
    const target = first.items.find(row => row.category === '短袖')._id
    const result = await run({ operation: 'replace', date, revision: first.revision, replaceId: target })
    if (otherSeasons[0] === '冬') {
      assert.equal(result.message, '暂无同类适温衣物，已保留当前搭配')
      assert.deepEqual(result.recommendation.itemIds, first.itemIds)
    } else {
      assert.ok(!result.recommendation.itemIds.includes(target))
      assert.equal(result.recommendation.items.find(row => ROLES[row.category] === 'top').category, '短袖')
      assert.ok(first.itemIds.filter(id => id !== target).every(id => result.recommendation.itemIds.includes(id)))
    }
  }
})

test('仅有上衣的方案可以遍历轮换，耗尽后保留当前衣物和缺项，重新进入保持方案', async () => {
  const { run } = setup([item('a', '短袖', ['夏']), item('b', '短袖', ['夏']), item('c', '长袖', ['夏'])])
  let rec = (await run()).recommendation
  const ids = new Set(rec.itemIds)
  assert.equal(rec.bodyKey, '')
  for (let n = 0; n < 2; n++) {
    rec = (await run(change(rec))).recommendation
    assert.equal(rec.itemIds.length, 1)
    assert.ok(!ids.has(rec.itemIds[0]))
    ids.add(rec.itemIds[0])
    assert.ok(rec.missing.includes('下装'))
  }
  const exhausted = await run(change(rec))
  assert.match(exhausted.message, /已看过/)
  assert.deepEqual(exhausted.recommendation.itemIds, rec.itemIds)
  assert.equal((await run()).recommendation.revision, rec.revision)
})

test('实穿增删重新匹配，衣物顺序和备注变化不重算，未来记录不影响当日缓存', async () => {
  const { cloud, run } = setup()
  const first = (await run()).recommendation
  const top = first.items.find(row => ROLES[row.category] === 'top')._id
  cloud.records.wear_records.push({ _id: 'wear', _openid: 'u', date: '2026-10-09', itemIds: [top, 'pants'] })
  const refreshed = await run()
  assert.match(refreshed.message, /实穿记录已更新/)
  assert.ok(refreshed.recommendation.revision > first.revision)
  assert.ok(!refreshed.recommendation.itemIds.includes(top))
  cloud.records.wear_records[0].itemIds.reverse()
  cloud.records.wear_records[0].note = '补充备注'
  cloud.records.wear_records.push({ _id: 'future', _openid: 'u', date: '2026-10-11', itemIds: ['a'] })
  assert.equal((await run()).recommendation.revision, refreshed.recommendation.revision)
  cloud.records.wear_records = []
  assert.match((await run()).message, /实穿记录已更新/)
})

test('站内历史参与次日轮换，调试预览及推送文档不被调整覆盖', async () => {
  const { cloud, run } = setup()
  const id = alert.recommendationId('u', date)
  cloud.records.ai_cache.push({ _id: id, _openid: 'u', date, status: 'sent', itemIds: ['original'] },
    { _id: id + '-preview', _openid: 'u', date, status: 'preview', itemIds: ['preview'] })
  const first = (await run()).recommendation
  const next = (await run({ now: new Date('2026-10-10T13:30:00Z') })).recommendation
  assert.notEqual(next.bodyKey, first.bodyKey)
  assert.deepEqual(cloud.records.ai_cache.find(row => row._id === id).itemIds, ['original'])
  assert.deepEqual(cloud.records.ai_cache.find(row => row._id === id + '-preview').itemIds, ['preview'])
})

test('并发调整和重发旧版本只应用一次；不同账号不能读写此方案', async () => {
  const { cloud, run } = setup()
  const rec = (await run()).recommendation
  const results = await Promise.allSettled([run(change(rec)), run(change(rec))])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.match(results.find(row => row.status === 'rejected').reason.message, /推荐已更新/)
  await assert.rejects(run(change(rec)), /推荐已更新/)
  await assert.rejects(run({ openid: 'other' }), /登录状态/)
  cloud.records.users[0].autoLoginEnabled = false
  await assert.rejects(run(), /登录状态/)
})

test('城市、天气或衣橱变化后重新匹配；删除的衣物不继续显示', async () => {
  const { cloud, run } = setup()
  const first = (await run()).recommendation
  const target = first.items.find(row => ROLES[row.category] === 'top')._id
  cloud.records.clothes = cloud.records.clothes.filter(row => row._id !== target)
  const refreshed = await run()
  assert.ok(!refreshed.recommendation.itemIds.includes(target))
  assert.match(refreshed.message, /衣橱已更新/)
  cloud.records.users[0].cityId = '310115'
  assert.ok((await run()).recommendation.revision > refreshed.recommendation.revision)
  const hot = await run({ request: async () => ({ status: '1', forecasts: [{ casts: [
    { daytemp: '35', nighttemp: '26', dayweather: '晴' }, { daytemp: '35', nighttemp: '26', dayweather: '晴' }
  ] }] }) })
  assert.ok(!hot.recommendation.itemIds.includes('outer'))
  assert.ok(!hot.recommendation.itemIds.includes('down'))
})

test('空衣橱、缺城市、天气失败及非法参数有明确结果，不写入失败方案', async () => {
  const empty = setup([])
  const result = await empty.run()
  assert.deepEqual(result.recommendation.items, [])
  assert.ok(result.recommendation.missing.length)
  const { cloud, run } = setup()
  await assert.rejects(run({ operation: 'delete' }), /操作无效/)
  await assert.rejects(run({ operation: 'change', date, revision: -1 }), /版本无效/)
  await assert.rejects(run({ date: '2026-10-11' }), /日期已变化/)
  await assert.rejects(run({ request: async () => { throw new Error('天气网络失败') } }), /天气网络失败/)
  assert.equal(cloud.records.ai_cache.length, 0)
  cloud.records.users[0].cityId = ''
  await assert.rejects(run(), /设置城市/)
})

test('穿搭页入口与推荐页支持调整、保留其他勾选状态，并保存最终选择', async () => {
  let url, saved
  const toasts = []
  const outfits = loadPage('outfits', {}, { navigateTo: value => { url = value.url } })
  outfits.onDailyTap()
  assert.equal(url, '/pages/weather-outfit/weather-outfit?daily=1')
  const { run } = setup()
  const page = loadPage('weather-outfit', { dailyRecommendation: args => run(args),
    addOutfit: async value => { saved = value; return 'outfit' } }, { showToast: value => toasts.push(value) })
  await page.onLoad({ daily: '1' })
  assert.equal(page.data.date, date)
  assert.equal(page.data.ready, true)
  const top = page.data.items.find(row => ROLES[row.category] === 'top')._id
  const category = page.data.items.find(row => row._id === top).category
  page.onItemTap({ currentTarget: { dataset: { id: 'shoes' } } })
  await page.onReplaceTap({ currentTarget: { dataset: { id: top } } })
  assert.equal(toasts.at(-1).title, `已替换${category}`)
  assert.equal(toasts.at(-1).icon, 'none')
  assert.equal(page.data.adjustMessage, '')
  assert.ok(!page.data.items.some(row => row._id === top))
  assert.equal(page.data.items.find(row => row._id === 'shoes').selected, false)
  await page.onChangeTap()
  assert.equal(toasts.at(-1).title, '已换一套搭配')
  assert.equal(page.data.adjustMessage, '')
  const ids = Array.from(page.selectedIds())
  await page.onSaveOutfit()
  assert.deepEqual(Array.from(saved.itemIds), ids)
  assert.equal(page.data.saved, true)
})

test('调整进行中禁止重复请求或保存；失败保留当前搭配，刷新恢复', async () => {
  const { run } = setup()
  let finish, calls = 0, saves = 0
  const page = loadPage('weather-outfit', {
    dailyRecommendation: args => {
      if (!args) return run()
      calls++
      return new Promise((resolve, reject) => { finish = () => reject(new Error('推荐已更新，请刷新')) })
    }, addOutfit: async () => { saves++ }
  })
  await page.onLoad({ daily: '1' })
  const before = Array.from(page.selectedIds())
  const pending = page.onChangeTap()
  await page.onChangeTap()
  await page.onSaveOutfit()
  assert.equal(calls, 1)
  assert.equal(saves, 0)
  finish()
  await pending
  assert.deepEqual(Array.from(page.selectedIds()), before)
  assert.equal(page.data.adjustError, true)
  assert.equal(page.data.adjusting, false)
  await page.onRetry()
  assert.equal(page.data.adjustError, false)
})

test('云函数入口只使用登录身份，不接受客户端冒用账号或执行推送扫描', async () => {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const exported = {}
  let openid = 'u', received
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/weather-alert/index'), 'utf8'), {
    exports: exported, process: { env: {} }, console: { error() {} },
    require: name => name === 'wx-server-sdk' ? { init() {}, database: () => ({}), getWXContext: () => ({ OPENID: openid }) } : {
      dailyRecommendation: async args => { received = args; return { success: true } },
      handle: () => { throw new Error('不应执行推送扫描') }
    }
  })
  const result = await exported.main({ action: 'dailyRecommendation', openid: 'other', operation: 'replace', date, revision: 1, replaceId: 'a' })
  assert.equal(result.success, true)
  assert.equal(received.openid, 'u')
  assert.equal(received.replaceId, 'a')
  openid = ''
  assert.equal((await exported.main({ action: 'dailyRecommendation' })).success, false)
})
