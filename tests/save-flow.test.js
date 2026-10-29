const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')
const { today } = require('../utils/date')

const tomorrow = () => new Date(Date.parse(today() + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
const setup = () => loadCloud({ users: [{ _id: 'user', openid: 'openid-1' }, { _id: 'other', openid: 'openid-2' }],
  clothes: ['a', 'b', 'c'].map(_id => ({ _id, _openid: 'openid-1', name: _id, category: '长袖', seasons: ['春秋'] })) })
const outfit = () => ({ name: '天气穿搭', itemIds: ['a', 'b'], occasion: '', note: '', imageFileID: '' })
const add = (cloud, collection, data, requestId = 'same-operation') => cloud.main({ action: 'data', operation: 'add', collection, data, requestId })
function client(cloud, intercept = async result => result) {
  global.wx = { cloud: { callFunction: async ({ data }) => ({ result: await intercept(await cloud.main(data), data) }) } }
  delete require.cache[require.resolve('../utils/db')]
  return require('../utils/db')
}
const recommendation = () => ({ date: tomorrow(), revision: 1, items: ['a', 'b'].map(_id => ({ _id, name: _id })) })

test('新增请求按账号及集合隔离，并发和乱序重试复用记录，修改后的记录不会被覆盖', async () => {
  const cloud = setup()
  const results = await Promise.all([add(cloud, 'outfits', outfit()), add(cloud, 'outfits', outfit())])
  assert.ok(results.every(row => row.success))
  assert.equal(results[0]._id, results[1]._id)
  assert.equal(cloud.records.outfits.length, 1)
  assert.equal((await add(cloud, 'outfits', { ...outfit(), itemIds: ['b', 'a', 'a'] }))._id, results[0]._id)
  cloud.records.outfits[0].note = '后来编辑的备注'
  assert.match((await add(cloud, 'outfits', outfit())).error, /已修改/)
  assert.equal(cloud.records.outfits[0].note, '后来编辑的备注')
  assert.match((await add(cloud, 'outfits', { ...outfit(), itemIds: ['a', 'c'] })).error, /内容已变化/)
  const plan = { date: tomorrow(), outfitId: results[0]._id, note: '' }
  const plans = await Promise.all([add(cloud, 'outfit_plans', plan), add(cloud, 'outfit_plans', plan)])
  assert.ok(plans.every(row => row.success))
  assert.equal(plans[0]._id, plans[1]._id)
  assert.equal(cloud.records.outfit_plans.length, 1)
  cloud.setOpenid('openid-2')
  assert.equal((await add(cloud, 'outfits', outfit())).success, false)
  const ownItem = { _id: 'own', _openid: 'openid-2' }
  cloud.records.clothes.push(ownItem)
  const other = await add(cloud, 'outfits', { ...outfit(), itemIds: ['own'] })
  assert.equal(other.success, true)
  assert.notEqual(other._id, results[0]._id)
})

test('新增回执失败与业务记录一起回滚，冲突可重试，已删除记录不会被旧请求重建', async () => {
  const cloud = setup()
  cloud.faults.before = (name, operation) => {
    if (name === 'wardrobe_meta' && operation === 'set') throw new Error('receipt unavailable')
  }
  assert.equal((await add(cloud, 'outfits', outfit())).success, false)
  assert.equal(cloud.records.outfits.length, 0)
  assert.equal(cloud.records.wardrobe_meta.length, 0)
  let conflicts = 0
  cloud.faults.before = (name, operation) => {
    if (name === 'wardrobe_meta' && operation === 'set' && !conflicts++) throw new Error('DATABASE_TRANSACTION_CONFLICT')
  }
  const saved = await add(cloud, 'outfits', outfit())
  assert.equal(saved.success, true)
  assert.equal(cloud.records.outfits.length, 1)
  cloud.faults.before = null
  await cloud.main({ action: 'data', operation: 'delete', collection: 'outfits', id: saved._id })
  assert.match((await add(cloud, 'outfits', outfit())).error, /已删除/)
  assert.equal(cloud.records.outfits.length, 0)
  for (const requestId of ['', 1, 'x'.repeat(16385)]) {
    assert.match((await add(cloud, 'outfits', outfit(), requestId)).error, /标识无效/)
  }
  await cloud.main({ action: 'logout' })
  assert.match((await add(cloud, 'outfits', outfit())).error, /登录状态已失效/)
})

test('推荐保存覆盖连点、穿搭与计划响应丢失、计划失败后重新进入恢复', async () => {
  for (const failedCollection of ['outfits', 'outfit_plans']) {
    const cloud = setup()
    let lost = false, release
    const api = client(cloud, async (result, event) => {
      if (event.operation === 'add' && event.collection === failedCollection && !lost) {
        lost = true
        await new Promise(resolve => { release = resolve })
        throw new Error('response lost')
      }
      return result
    })
    const db = { ...api, dailyRecommendation: async () => ({ recommendation: recommendation() }) }
    const page = loadPage('weather-outfit', db)
    await page.onLoad({ daily: '1' })
    const pending = page.onSaveAndPlan()
    while (!release) await new Promise(resolve => setImmediate(resolve))
    await page.onSaveAndPlan()
    release()
    await pending
    assert.equal(page.data.saved, false)
    assert.match(page.data.saveError, /请重试/)
    const reopened = loadPage('weather-outfit', db)
    await reopened.onLoad({ daily: '1' })
    await reopened.onSaveAndPlan()
    assert.equal(reopened.data.savedAsPlan, true)
    assert.equal(cloud.records.outfits.length, 1)
    assert.equal(cloud.records.outfit_plans.length, 1)
    assert.equal(cloud.records.outfit_plans[0].outfitId, cloud.records.outfits[0]._id)
    assert.equal(cloud.records.wear_records.length, 0)
  }
  const cloud = setup()
  const api = client(cloud)
  let fail = true
  const page = loadPage('weather-outfit', { ...api, dailyRecommendation: async () => ({ recommendation: recommendation() }),
    addPlan: (...args) => fail ? Promise.reject(new Error('offline')) : api.addPlan(...args) })
  await page.onLoad({ daily: '1' })
  await page.onSaveAndPlan()
  assert.equal(cloud.records.outfits.length, 1)
  assert.equal(cloud.records.outfit_plans.length, 0)
  fail = false
  await page.onSaveAndPlan()
  assert.equal(cloud.records.outfits.length, 1)
  assert.equal(cloud.records.outfit_plans.length, 1)
})

test('旧通知展示目标日期，过期推荐不能安排成明天计划', async () => {
  let plans = 0
  const page = loadPage('weather-outfit', {
    getWeatherRecommendation: async () => ({ ...recommendation(), date: today() }),
    listItems: async () => [{ _id: 'a' }, { _id: 'b' }], addPlan: async () => { plans++ }
  })
  await page.onLoad({ date: today() })
  assert.equal(page.data.canPlan, false)
  await page.onSaveAndPlan()
  assert.equal(plans, 0)
})

test('今日计划可带入实穿，首屏之外的搭配可读取，确认和重复提交只累计一条', async () => {
  const cloud = setup(), api = client(cloud)
  const outfitId = await api.addOutfit(outfit(), 'outfit')
  const planId = await api.addPlan({ date: today(), outfitId, note: '按实际穿着确认' }, 'plan')
  let url
  const gallery = loadPage('outfits', { ...api, listOutfitsPage: async () => [] }, { navigateTo: args => { url = args.url } })
  await gallery.loadData(true)
  assert.equal(gallery.data.todayPlans.length, 1)
  assert.equal(gallery.data.todayPlans[0].wornToday, false)
  gallery.onPlanWearTap({ currentTarget: { dataset: { id: planId } } })
  assert.equal(url, `/pages/today-wear/today-wear?planId=${planId}`)
  const page = loadPage('today-wear', api)
  await page.onLoad({ planId })
  assert.deepEqual(Array.from(page.data.selectedIds), ['a', 'b'])
  assert.equal(page.data.note, '按实际穿着确认')
  assert.equal(cloud.records.wear_records.length, 0)
  await page.onSave()
  assert.equal(cloud.records.wear_records.length, 1)
  const duplicate = await cloud.main({ action: 'data', operation: 'add', collection: 'wear_records',
    data: { date: today(), outfitId, itemIds: ['b', 'a'], note: '' } })
  assert.match(duplicate.error, /相同衣物组合/)
  assert.equal(cloud.records.wear_records.length, 1)
  await gallery.loadData(true)
  assert.equal(gallery.data.todayPlans[0].wornToday, true)
  gallery.onPlanWearTap({ currentTarget: { dataset: { id: planId } } })
  assert.equal(url, `/pages/today-wear/today-wear?id=${cloud.records.wear_records[0]._id}`)
})

test('计划带入后允许调整衣物，未来计划和失效搭配不能作为今日实穿提交', async () => {
  const cloud = setup(), api = client(cloud)
  const outfitId = await api.addOutfit(outfit(), 'outfit')
  const planId = await api.addPlan({ date: today(), outfitId, note: '' }, 'plan')
  const page = loadPage('today-wear', api)
  await page.onLoad({ planId })
  page.onItemToggle({ currentTarget: { dataset: { id: 'b' } } })
  page.onItemToggle({ currentTarget: { dataset: { id: 'c' } } })
  await page.onSave()
  assert.deepEqual(cloud.records.wear_records[0].itemIds, ['a', 'c'])
  assert.equal(cloud.records.wear_records[0].outfitId, '')
  for (const invalid of ['future', 'deleted']) {
    if (invalid === 'future') cloud.records.outfit_plans[0].date = tomorrow()
    else { cloud.records.outfit_plans[0].date = today(); await api.deleteOutfit(outfitId) }
    const rejected = loadPage('today-wear', api)
    await rejected.onLoad({ planId })
    assert.equal(rejected.data.ready, false)
    await rejected.onSave()
    assert.equal(cloud.records.wear_records.length, 1)
  }
})
