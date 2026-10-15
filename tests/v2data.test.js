const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { loadCloud } = require('./support/cloud')

const MODULE_PATH = require.resolve('../utils/db')

const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', salt: 'salt', passwordHash: crypto.scryptSync('secret1', 'salt', 64).toString('hex') })
const item = () => ({ name: '衬衫', category: '上衣', seasons: ['春秋'], price: 10, imageFileID: '' })
const dataCall = (operation, collection, extra = {}) => ({ action: 'data', operation, collection, ...extra })
const shanghaiDate = offset => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const day = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return new Date(Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day) + offset)).toISOString().slice(0, 10)
}

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
  const duplicate = await c.main(dataCall('add', 'wear_records', { data: { ...valid, outfitId: '', note: '换备注' } }))
  assert.equal(duplicate.success, false)
  assert.match(duplicate.error, /相同衣物组合/)
  for (const patch of [{ date: '' }, { date: '2026-13-01' }, { itemIds: [] }, { itemIds: ['foreign'] }, { itemIds: ['gone'] }, { outfitId: 'fit-foreign' }, { outfitId: 'gone' }]) {
    assert.equal((await c.main(dataCall('add', 'wear_records', { data: { ...valid, ...patch } }))).success, false, JSON.stringify(patch))
  }
})

test('实穿日期只允许今天及过去，未来日期无法新增或更新', async () => {
  const c = loadCloud({ users: [user()], clothes: [{ _id: 'a', _openid: 'openid-1', ...item() }] })
  const today = shanghaiDate(0), tomorrow = shanghaiDate(1)
  const data = { date: today, itemIds: ['a'], outfitId: '', note: '' }
  const added = await c.main(dataCall('add', 'wear_records', { data }))
  assert.equal(added.success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data: { ...data, date: tomorrow } }))).success, false)
  assert.equal((await c.main(dataCall('update', 'wear_records', { id: added._id, data: { ...data, date: tomorrow } }))).success, false)
  assert.equal(c.records.wear_records[0].date, today)
})

test('同日衣物集合按排序判重，修改和删除同步释放占位', async () => {
  const date = shanghaiDate(-1)
  const c = loadCloud({ users: [user()], clothes: ['a', 'b', 'c'].map(_id => ({ _id, _openid: 'openid-1', ...item() })) })
  const wear = itemIds => ({ date, itemIds, outfitId: '', note: '' })
  const first = await c.main(dataCall('add', 'wear_records', { data: wear(['a', 'b']) }))
  assert.equal(first.success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data: wear(['b', 'a', 'a']) }))).success, false)
  const second = await c.main(dataCall('add', 'wear_records', { data: wear(['a', 'c']) }))
  assert.equal(second.success, true)
  assert.equal((await c.main(dataCall('update', 'wear_records', { id: second._id, data: wear(['b', 'a']) }))).success, false)
  assert.equal((await c.main(dataCall('update', 'wear_records', { id: second._id, data: { ...wear(['a', 'c']), note: '晚间' } }))).success, true)
  assert.equal((await c.main(dataCall('update', 'wear_records', { id: second._id, data: wear(['b', 'c']) }))).success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data: wear(['a', 'c']) }))).success, true)
  assert.equal((await c.main(dataCall('delete', 'wear_records', { id: first._id }))).success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data: wear(['b', 'a']) }))).success, true)
  assert.equal(c.records.wear_records.length, 3)
})

test('旧重复实穿可改备注，删尽旧记录后同组合可重新保存', async () => {
  const date = shanghaiDate(-1)
  const old = id => ({ _id: id, _openid: 'openid-1', date, itemIds: id === 'old-a' ? ['a', 'b'] : ['b', 'a'], outfitId: '', note: '' })
  const c = loadCloud({ users: [user()], clothes: ['a', 'b'].map(_id => ({ _id, _openid: 'openid-1', ...item() })), wear_records: [old('old-a'), old('old-b')] })
  const data = { date, itemIds: ['a', 'b'], outfitId: '', note: '补充说明' }
  assert.equal((await c.main(dataCall('update', 'wear_records', { id: 'old-a', data }))).success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data }))).success, false)
  assert.equal((await c.main(dataCall('delete', 'wear_records', { id: 'old-a' }))).success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data }))).success, false)
  assert.equal((await c.main(dataCall('delete', 'wear_records', { id: 'old-b' }))).success, true)
  assert.equal((await c.main(dataCall('add', 'wear_records', { data }))).success, true)
})

test('并发提交同日同组合仅保留一条实穿记录', async () => {
  const c = loadCloud({ users: [user()], clothes: ['a', 'b'].map(_id => ({ _id, _openid: 'openid-1', ...item() })) })
  const date = shanghaiDate(0)
  const results = await Promise.all([
    c.main(dataCall('add', 'wear_records', { data: { date, itemIds: ['a', 'b'] } })),
    c.main(dataCall('add', 'wear_records', { data: { date, itemIds: ['b', 'a'] } }))
  ])
  assert.deepEqual(results.map(result => result.success).sort(), [false, true])
  assert.equal(c.records.wear_records.length, 1)
  assert.equal(c.records.wardrobe_meta.filter(row => row._id.startsWith('wear-key-')).length, 1)
  const distinct = await Promise.all([
    c.main(dataCall('add', 'wear_records', { data: { date, itemIds: ['a'] } })),
    c.main(dataCall('add', 'wear_records', { data: { date, itemIds: ['b'] } }))
  ])
  assert.deepEqual(distinct.map(result => result.success), [true, true])
  assert.equal(c.records.wear_records.length, 3)
})

test('元数据写入冲突重扫后仍能保存不同组合', async () => {
  const c = loadCloud({ users: [user()], clothes: [{ _id: 'a', _openid: 'openid-1', ...item() }] })
  let conflicted = false
  c.faults.before = (name, operation, id) => {
    if (name === 'wardrobe_meta' && operation === 'set' && !id.startsWith('wear-key-') && !conflicted) {
      conflicted = true
      throw new Error('DATABASE_DUPLICATE_WRITE')
    }
  }
  const result = await c.main(dataCall('add', 'wear_records', { data: { date: shanghaiDate(0), itemIds: ['a'] } }))
  assert.equal(result.success, true)
  assert.equal(c.records.wear_records.length, 1)
})

test('判重扫描覆盖同日超过一页的旧记录，占位失败会回滚实穿', async () => {
  const date = shanghaiDate(-1)
  const old = Array.from({ length: 100 }, (_, index) => ({ _id: `old-${index}`, _openid: 'openid-1', date, itemIds: ['b'] }))
  old.push({ _id: 'old-match', _openid: 'openid-1', date, itemIds: ['a'] })
  const c = loadCloud({ users: [user()], clothes: ['a', 'b'].map(_id => ({ _id, _openid: 'openid-1', ...item() })), wear_records: old })
  const data = { date, itemIds: ['a'], outfitId: '', note: '' }
  assert.equal((await c.main(dataCall('add', 'wear_records', { data }))).success, false)
  c.records.wear_records.pop()
  c.faults.before = (name, operation, id) => {
    if (name === 'wardrobe_meta' && operation === 'set' && id.startsWith('wear-key-')) throw new Error('marker write failed')
  }
  assert.equal((await c.main(dataCall('add', 'wear_records', { data }))).success, false)
  assert.equal(c.records.wear_records.length, 100)
  assert.equal(c.records.wardrobe_meta.length, 0)
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

test('关联收藏仅更新实穿 outfitId，衣物快照、备注和频次保持不变', async () => {
  const date = shanghaiDate(-1)
  const c = loadCloud({
    users: [user()],
    wear_records: [
      { _id: 'wear', _openid: 'openid-1', date, itemIds: ['b', 'a'], outfitId: '', note: '通勤' },
      { _id: 'foreign-wear', _openid: 'openid-2', date, itemIds: ['a', 'b'], outfitId: '', note: '' }
    ],
    outfits: [
      { _id: 'fit', _openid: 'openid-1', name: '收藏', itemIds: ['a', 'b'] },
      { _id: 'other', _openid: 'openid-1', name: '不同组合', itemIds: ['a'] },
      { _id: 'foreign-fit', _openid: 'openid-2', name: '他人收藏', itemIds: ['a', 'b'] }
    ]
  })
  const link = (id, outfitId) => c.main(dataCall('linkOutfit', 'wear_records', { id, outfitId }))
  for (const [id, outfitId] of [
    ['wear', 'other'], ['wear', 'foreign-fit'], ['foreign-wear', 'fit'], ['gone', 'fit'], ['wear', 'gone'], ['wear', '']
  ]) assert.equal((await link(id, outfitId)).success, false)
  assert.equal((await link('wear', 'fit')).success, true)
  assert.deepEqual(c.records.wear_records[0].itemIds, ['b', 'a'])
  assert.equal(c.records.wear_records[0].date, date)
  assert.equal(c.records.wear_records[0].note, '通勤')
  assert.equal(c.records.wear_records[0].outfitId, 'fit')
  assert.equal(c.records.wear_records.length, 2)
  const version = c.records.wardrobe_meta[0].version
  assert.equal((await link('wear', 'fit')).success, true)
  assert.equal(c.records.wardrobe_meta[0].version, version)
  assert.equal((await c.main(dataCall('linkOutfit', 'outfits', { id: 'fit', outfitId: 'fit' }))).success, false)
})

test('关联收藏写入失败时事务回滚', async () => {
  const c = loadCloud({
    users: [user()],
    wear_records: [{ _id: 'wear', _openid: 'openid-1', date: shanghaiDate(-1), itemIds: ['a'], outfitId: '' }],
    outfits: [{ _id: 'fit', _openid: 'openid-1', name: '收藏', itemIds: ['a'] }]
  })
  c.faults.before = (name, operation) => {
    if (name === 'wardrobe_meta' && operation === 'set') throw new Error('version write failed')
  }
  assert.equal((await c.main(dataCall('linkOutfit', 'wear_records', { id: 'wear', outfitId: 'fit' }))).success, false)
  assert.equal(c.records.wear_records[0].outfitId, '')
  assert.equal(c.records.wardrobe_meta.length, 0)
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

test('客户端关联收藏接口刷新实穿缓存，并能读取保存后的记录', async () => {
  const { api, queryCalls } = loadDb({
    wear_records: [{ _id: 'wear', date: shanghaiDate(-1), itemIds: ['a'], outfitId: '', note: '' }],
    outfits: [{ _id: 'fit', name: '收藏', itemIds: ['a'] }]
  })
  await api.listWearRecords()
  assert.equal((await api.getWearRecord('wear')).outfitId, '')
  await api.linkWearOutfit('wear', 'fit')
  assert.equal((await api.getWearRecord('wear')).outfitId, 'fit')
  assert.equal((await api.listWearRecords())[0].outfitId, 'fit')
  assert.equal(queryCalls.filter(call => call.collection === 'wear_records').length, 2)
})
