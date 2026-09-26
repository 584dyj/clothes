const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { loadCloud } = require('./support/cloud')

const MODULE_PATH = require.resolve('../utils/db')

const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', salt: 'salt', passwordHash: crypto.scryptSync('secret1', 'salt', 64).toString('hex') })
const item = () => ({ name: '衬衫', category: '上衣', seasons: ['春秋'], price: 10, imageFileID: '' })
const dataCall = (operation, collection, extra = {}) => ({ action: 'data', operation, collection, ...extra })

// ---------- expenses 独立账本 ----------

test('账本新增校验分类、金额、日期与关联衣物归属', async () => {
  const c = loadCloud({ users: [user()], clothes: [{ _id: 'own', _openid: 'openid-1', ...item() }, { _id: 'foreign', _openid: 'openid-2', ...item() }] })
  const valid = { category: '洗护', amount: 39.956, date: '2026-09-20', note: '干洗大衣', itemId: 'own' }
  const added = await c.main(dataCall('add', 'expenses', { data: valid }))
  assert.equal(added.success, true)
  assert.equal(c.records.expenses[0].amount, 39.96)
  assert.equal(c.records.expenses[0]._openid, 'openid-1')
  for (const patch of [{ category: '餐饮' }, { amount: 0 }, { amount: -5 }, { amount: 'x' }, { date: '2026-02-29' }, { date: '2021-01-01' }, { date: '' }, { itemId: 'foreign' }, { itemId: 'gone' }]) {
    assert.equal((await c.main(dataCall('add', 'expenses', { data: { ...valid, ...patch } }))).success, false, JSON.stringify(patch))
  }
  assert.equal(c.records.expenses.length, 1)
})

test('账本按身份隔离，跨身份读写被拒绝', async () => {
  const c = loadCloud({ users: [user()], expenses: [{ _id: 'own', _openid: 'openid-1', category: '服饰', amount: 100, date: '2026-09-01' }, { _id: 'foreign', _openid: 'openid-2', category: '服饰', amount: 200, date: '2026-09-01' }] })
  assert.equal((await c.main(dataCall('list', 'expenses', { offset: 0 }))).data.length, 1)
  for (const operation of ['get', 'update', 'delete']) {
    assert.equal((await c.main(dataCall(operation, 'expenses', { id: 'foreign', data: { category: '服饰', amount: 1, date: '2026-09-01' } }))).success, false)
  }
  assert.equal(c.records.expenses.length, 2)
})

// ---------- wear_records 穿着记录 ----------

test('穿着记录校验日期、衣物与穿搭归属，穿搭可空', async () => {
  const c = loadCloud({
    users: [user()],
    clothes: [{ _id: 'own', _openid: 'openid-1', ...item() }, { _id: 'foreign', _openid: 'openid-2', ...item() }],
    outfits: [{ _id: 'fit', _openid: 'openid-1', name: 'look', itemIds: ['own'] }, { _id: 'fit-foreign', _openid: 'openid-2', name: 'look', itemIds: ['foreign'] }]
  })
  const valid = { date: '2026-09-24', itemIds: ['own', 'own'], outfitId: 'fit', note: '通勤' }
  const added = await c.main(dataCall('add', 'wear_records', { data: valid }))
  assert.equal(added.success, true)
  assert.deepEqual(c.records.wear_records[0].itemIds, ['own'])
  assert.equal((await c.main(dataCall('add', 'wear_records', { data: { ...valid, outfitId: '' } }))).success, true)
  for (const patch of [{ date: '' }, { date: '2026-13-01' }, { itemIds: [] }, { itemIds: ['foreign'] }, { itemIds: ['gone'] }, { outfitId: 'fit-foreign' }, { outfitId: 'gone' }]) {
    assert.equal((await c.main(dataCall('add', 'wear_records', { data: { ...valid, ...patch } }))).success, false, JSON.stringify(patch))
  }
})

test('删除衣物不回溯清理穿着记录', async () => {
  const c = loadCloud({
    users: [user()],
    clothes: [{ _id: 'item-1', _openid: 'openid-1', ...item() }],
    wear_records: [{ _id: 'wr', _openid: 'openid-1', date: '2026-09-01', itemIds: ['item-1'], outfitId: '' }]
  })
  assert.equal((await c.main(dataCall('delete', 'clothes', { id: 'item-1' }))).success, true)
  assert.equal(c.records.wear_records.length, 1)
  assert.deepEqual(c.records.wear_records[0].itemIds, ['item-1'])
})

// ---------- outfit_plans 穿搭计划 ----------

test('计划必须引用本人穿搭，删除穿搭后计划由清理任务分批移除', async () => {
  const plans = Array.from({ length: 21 }, (_, index) => ({ _id: `plan-${index}`, _openid: 'openid-1', date: '2026-09-01', outfitId: 'fit' }))
  const c = loadCloud({
    users: [user()],
    clothes: [{ _id: 'own', _openid: 'openid-1', ...item() }],
    outfits: [{ _id: 'fit', _openid: 'openid-1', name: 'look', itemIds: ['own'] }],
    outfit_plans: plans
  })
  const valid = { date: '2026-09-25', outfitId: 'fit', note: '' }
  assert.equal((await c.main(dataCall('add', 'outfit_plans', { data: valid }))).success, true)
  for (const patch of [{ outfitId: '' }, { outfitId: 'gone' }, { date: '2099-01-01' }]) {
    assert.equal((await c.main(dataCall('add', 'outfit_plans', { data: { ...valid, ...patch } }))).success, false, JSON.stringify(patch))
  }
  const deleted = await c.main(dataCall('delete', 'outfits', { id: 'fit' }))
  assert.equal(deleted.success, true)
  assert.equal(deleted.cleanupFailed, true)
  // 每轮最多清理 20 条，22 条计划首次删除后仍有剩余，任务保留待重试。
  assert.equal(c.records.outfit_plans.length, 2)
  assert.equal(c.records.cleanup_jobs.some(job => job.kind === 'plans' && job.state === 'pending'), true)
  assert.equal((await c.main({ action: 'retryCleanup' })).success, true)
  assert.equal(c.records.outfit_plans.length, 0)
  assert.equal(c.records.cleanup_jobs.some(job => job.kind === 'plans'), false)
})

test('计划清理失败保留任务，故障恢复后可继续', async () => {
  const c = loadCloud({
    users: [user()],
    outfits: [{ _id: 'fit', _openid: 'openid-1', name: 'look', itemIds: [] }],
    outfit_plans: [{ _id: 'plan-1', _openid: 'openid-1', date: '2026-09-01', outfitId: 'fit' }]
  })
  c.faults.before = (name, op) => { if (name === 'outfit_plans' && op === 'remove') throw Error('write failed') }
  const deleted = await c.main(dataCall('delete', 'outfits', { id: 'fit' }))
  assert.equal(deleted.success, true)
  assert.equal(deleted.cleanupFailed, true)
  assert.equal(c.records.outfit_plans.length, 1)
  c.faults.before = null
  await c.main({ action: 'retryCleanup' })
  assert.equal(c.records.outfit_plans.length, 0)
})

// ---------- 客户端缓存 ----------

function loadDb(records) {
  records.users = [{ _id: 'u', username: 'alice', openid: 'openid-1' }]
  for (const name of ['clothes', 'outfits', 'expenses', 'wear_records', 'outfit_plans']) for (const row of records[name] || []) row._openid = 'openid-1'
  const cloud = loadCloud(records)
  const queryCalls = []
  global.wx = { cloud: { callFunction: async ({ data }) => {
    if (data.operation === 'list') queryCalls.push({ collection: data.collection, offset: data.offset })
    return { result: await cloud.main(data) }
  } } }
  delete require.cache[MODULE_PATH]
  return { api: require(MODULE_PATH), queryCalls, records }
}

test('新集合缓存复用、写后失效与 clearCache 覆盖', async () => {
  const { api, queryCalls, records } = loadDb({
    expenses: [{ _id: 'exp-1', category: '洗护', amount: 20, date: '2026-09-01' }],
    outfit_plans: [{ _id: 'plan-1', date: '2026-09-02', outfitId: 'fit' }],
    clothes: [{ _id: 'own', ...item() }],
    outfits: [{ _id: 'fit', name: 'look', itemIds: ['own'] }]
  })
  await api.listExpenses()
  await api.listExpenses()
  assert.equal(queryCalls.filter(call => call.collection === 'expenses').length, 1)

  await api.addExpense({ category: '服饰', amount: 99, date: '2026-09-03' })
  await api.listExpenses()
  assert.equal(queryCalls.filter(call => call.collection === 'expenses').length, 2)

  // 删除穿搭连带失效计划缓存，服务端同步清理计划。
  await api.listPlans()
  assert.equal(queryCalls.filter(call => call.collection === 'outfit_plans').length, 1)
  await api.deleteOutfit('fit')
  const plans = await api.listPlans()
  assert.equal(queryCalls.filter(call => call.collection === 'outfit_plans').length, 2)
  assert.equal(plans.length, 0)

  api.clearCache()
  records.expenses.push({ _id: 'exp-2', _openid: 'openid-1', category: '其他', amount: 5, date: '2026-09-04' })
  assert.equal((await api.listExpenses()).length, 3)
})
