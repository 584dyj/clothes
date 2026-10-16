const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const report = require('../cloudfunctions/monthly-report/report')

const TEMPLATE_ID = 'CeSjEXCpR71PZvGbIoqCDgO0H0CSHSwGbo_7o7ZgLIE'
const NOW = new Date('2026-10-09T01:00:00.000Z')
const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
const subscription = (id, openid, patch = {}) => ({ _id: id, _openid: openid, scene: 'idle-monthly', createdAt: NOW, ...patch })
const quota = (openid, unused) => ({ _id: require('../cloudfunctions/auth/subscription').quotaId(openid), _openid: openid, scene: 'idle-monthly-quota', unused, createdAt: NOW })
const item = (id, openid, name, purchaseDate) => ({ _id: id, _openid: openid, name, purchaseDate })
const wear = (id, openid, date, itemIds = []) => ({ _id: id, _openid: openid, date, itemIds })
const outfit = (id, openid, date, itemIds = []) => ({ _id: id, _openid: openid, createdAt: new Date(date), itemIds })

test('订阅登记需要登录，并发写入不会超过十二条未消耗额度', async () => {
  const subscriptions = [quota('openid-1', 11), ...Array.from({ length: 11 }, (_, index) => subscription(`s${index}`, 'openid-1'))]
  const cloud = loadCloud({ users: [user()], subscriptions })
  const results = await Promise.all([
    cloud.main({ action: 'subscribeReport' }),
    cloud.main({ action: 'subscribeReport' })
  ])
  assert.equal(results.filter(result => result.success).length, 1)
  assert.equal(results.filter(result => !result.success).length, 1)
  assert.match(results.find(result => !result.success).error, /额度已充足/)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'idle-monthly' && !row.consumedAt).length, 12)
  assert.equal(cloud.records.subscriptions.at(-1).scene, 'idle-monthly')
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 12)
  await cloud.main({ action: 'logout' })
  assert.match((await cloud.main({ action: 'subscribeReport' })).error, /登录状态已失效/)
})

test('取消月报隔离旧授权，旧数据有无额度文档均可重新订阅', async () => {
  for (const hasQuota of [false, true]) {
    const cloud = loadCloud({
      users: [user()],
      subscriptions: [subscription('old-1', 'openid-1'), subscription('old-2', 'openid-1'), ...(hasQuota ? [quota('openid-1', 2)] : [])],
      clothes: [item('idle', 'openid-1', '旧衣物', '2025-01-01')],
      wear_records: [wear('recent', 'openid-1', '2026-10-01', ['deleted'])]
    })
    const args = { db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW }
    assert.equal((await cloud.main({ action: 'cancelReport' })).success, true)
    const currentQuota = cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota')
    assert.equal(currentQuota.unused, 0)
    assert.equal(currentQuota.generation, 1)
    assert.equal((await report.handle(args)).sent, 0)
    assert.equal((await cloud.main({ action: 'subscribeReport' })).success, true)
    const fresh = cloud.records.subscriptions.find(row => row.scene === 'idle-monthly' && row.generation === 1)
    assert.ok(fresh)
    assert.equal((await report.handle(args)).sent, 1)
    assert.ok(fresh.consumedAt)
    assert.equal(currentQuota.unused, 0)
    assert.equal((await report.handle({ ...args, now: new Date('2026-11-01T01:00:00.000Z') })).sent, 0)
    assert.equal(cloud.sentMessages.length, 1)
    for (const id of ['old-1', 'old-2']) assert.equal(cloud.records.subscriptions.find(row => row._id === id).consumedAt, undefined)
  }
})

test('月报发送失败期间取消，有无重新订阅均不恢复旧代额度', async () => {
  for (const resubscribe of [false, true]) {
    const cloud = loadCloud({
      users: [user()],
      subscriptions: [subscription('old-1', 'openid-1'), subscription('old-2', 'openid-1'), quota('openid-1', 2)],
      clothes: [item('idle', 'openid-1', '旧衣物', '2025-01-01')],
      wear_records: [wear('recent', 'openid-1', '2026-10-01', ['deleted'])]
    })
    const args = { db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW }
    cloud.faults.send = async () => {
      assert.equal((await cloud.main({ action: 'cancelReport' })).success, true)
      if (resubscribe) assert.equal((await cloud.main({ action: 'subscribeReport' })).success, true)
      const error = new Error('openapi failed: 50031')
      error.errCode = 50031
      throw error
    }
    assert.equal((await report.handle(args)).failed, 1)
    const currentQuota = cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota')
    assert.equal(currentQuota.generation, 1)
    assert.equal(currentQuota.unused, resubscribe ? 1 : 0)
    assert.equal(cloud.records.subscriptions.some(row => row.scene === 'idle-monthly-sent'), false)
    assert.equal(cloud.records.subscriptions.find(row => row._id === 'old-1').consumedAt, undefined)
    cloud.faults.send = null
    assert.equal((await report.handle(args)).sent, resubscribe ? 1 : 0)
    assert.equal(currentQuota.unused, 0)
    assert.equal((await report.handle({ ...args, now: new Date('2026-11-01T01:00:00.000Z') })).sent, 0)
    assert.equal(cloud.sentMessages.length, resubscribe ? 1 : 0)
  }
})

test('月报成功后取消并重新订阅仍保留同月发送标记', async () => {
  const cloud = loadCloud({
    users: [user()],
    subscriptions: [subscription('old-1', 'openid-1'), subscription('old-2', 'openid-1'), quota('openid-1', 2)],
    clothes: [item('idle', 'openid-1', '旧衣物', '2025-01-01')],
    wear_records: [wear('recent', 'openid-1', '2026-10-01', ['deleted'])]
  })
  const args = { db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW }
  assert.equal((await report.handle(args)).sent, 1)
  const marker = structuredClone(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-sent'))
  assert.equal((await cloud.main({ action: 'cancelReport' })).success, true)
  assert.equal((await cloud.main({ action: 'subscribeReport' })).success, true)
  assert.deepEqual(cloud.records.subscriptions.find(row => row._id === marker._id), marker)
  assert.equal((await report.handle(args)).sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'old-2').consumedAt, undefined)
  assert.equal((await report.handle({ ...args, now: new Date('2026-11-01T01:00:00.000Z') })).sent, 1)
  assert.equal(cloud.sentMessages.length, 2)
})

test('月报按购入与穿着口径发送，同账号每月最多一条并保留成功额度标记', async () => {
  const cloud = loadCloud({
    subscriptions: [
      subscription('active-1', 'active'), subscription('active-2', 'active'),
      subscription('inactive', 'inactive'), subscription('zero', 'zero'),
      subscription('used', 'used', { consumedAt: NOW }),
      quota('active', 2), quota('inactive', 1), quota('zero', 1), quota('used', 0)
    ],
    clothes: [
      item('a-old', 'active', '很久没穿的外套', '2026-01-01'),
      item('a-last', 'active', '旧衬衫', '2025-01-01'),
      item('a-worn', 'active', '常穿长裤', '2025-01-01'),
      item('a-new', 'active', '新鞋', '2026-09-01'),
      item('i-old', 'inactive', '闲置上衣', '2025-01-01'),
      item('z-worn', 'zero', '仍在穿', '2025-01-01')
    ],
    wear_records: [
      wear('a-recent', 'active', '2026-10-01', ['a-worn']),
      wear('a-history', 'active', '2026-06-01', ['a-last']),
      wear('i-history', 'inactive', '2026-01-01', ['i-old']),
      wear('z-recent', 'zero', '2026-10-01', ['z-worn'])
    ]
  })

  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.deepEqual(result, { success: true, scanned: 5, sent: 1, skipped: 2, expired: 0, failed: 0 })
  assert.equal(cloud.sentMessages.length, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.touser, 'active')
  assert.equal(message.templateId, TEMPLATE_ID)
  assert.equal(message.page, 'pages/stats/stats')
  assert.equal(message.data.number16.value, 2)
  assert.ok(Array.from(message.data.thing29.value).length <= 20)
  assert.equal(message.data.time23.value, '2026-10-09 09:00:00')
  assert.ok(cloud.records.subscriptions.find(row => row._id === 'active-1').consumedAt)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'active-2').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'inactive').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'zero').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota' && row._openid === 'active').unused, 1)
})

test('43101 删除失效额度，临时错误恢复额度且不阻塞其他账号', async () => {
  const accounts = ['expired', 'temporary', 'ok']
  const cloud = loadCloud({
    subscriptions: accounts.flatMap(openid => [subscription(openid, openid), quota(openid, 1)]),
    clothes: accounts.map(openid => item(`${openid}-idle`, openid, `${openid}衣物`, '2025-01-01')),
    wear_records: accounts.map(openid => wear(`${openid}-recent`, openid, '2026-10-01', ['deleted']))
  })
  cloud.faults.send = async message => {
    if (message.touser === 'expired') {
      const error = new Error('openapi failed: 43101 user refuse')
      error.errCode = -1
      throw error
    }
    if (message.touser === 'temporary') throw Error('network timeout')
  }

  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.expired, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.sent, 1)
  assert.equal(cloud.records.subscriptions.some(row => row._id === 'expired'), false)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'temporary').consumedAt, undefined)
  assert.ok(cloud.records.subscriptions.find(row => row._id === 'ok').consumedAt)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota' && row._openid === 'temporary').unused, 1)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota' && row._openid === 'ok').unused, 0)
  assert.deepEqual(cloud.sentMessages.map(message => message.touser), ['ok'])
})

test('同账号同月重复运行只发送一次，跨月可再次发送', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), subscription('s2', 'u1'), quota('u1', 2)],
    clothes: [item('u1-idle', 'u1', '旧衣物', '2025-01-01')],
    wear_records: [wear('u1-recent', 'u1', '2026-10-01', ['deleted'])]
  })
  const first = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(first.sent, 1)
  const second = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(second.sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
  assert.ok(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-sent' && row.month === '2026-10'))
  assert.equal(cloud.records.subscriptions.find(row => row._id === 's2').consumedAt, undefined)
  const third = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: new Date('2026-11-01T01:00:00.000Z') })
  assert.equal(third.sent, 1)
  assert.equal(cloud.sentMessages.length, 2)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 0)
})

test('SDK 对缺失幂等文档抛错时月报首次可发送且同月去重', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), subscription('s2', 'u1'), quota('u1', 2)],
    clothes: [item('u1-idle', 'u1', '旧衣物', '2025-01-01')],
    wear_records: [wear('u1-recent', 'u1', '2026-10-01', ['deleted'])]
  })
  cloud.faults.before = (collection, operation, id) => {
    if (collection === 'subscriptions' && operation === 'doc.get' &&
        !cloud.records.subscriptions.some(row => row._id === id)) {
      throw new Error(`document.get:fail document with _id ${id} does not exist`)
    }
  }
  const first = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(first.sent, 1)
  assert.equal(first.failed, 0)
  const second = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(second.sent, 0)
  assert.equal(second.failed, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.ok(cloud.records.subscriptions.find(row => row._id === 'sent-u1-2026-10'))
  assert.equal(cloud.records.subscriptions.find(row => row._id === 's2').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
})

test('月报授权、幂等与额度读取的真实错误计入失败且不消耗授权', async () => {
  for (const failedId of ['s1', 'sent-u1-2026-10', quota('u1', 1)._id]) {
    const cloud = loadCloud({
      subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
      clothes: [item('u1-idle', 'u1', '旧衣物', '2025-01-01')],
      wear_records: [wear('u1-recent', 'u1', '2026-10-01', ['deleted'])]
    })
    const before = structuredClone(cloud.records.subscriptions)
    cloud.faults.before = (collection, operation, id) => {
      if (collection === 'subscriptions' && operation === 'doc.get' && id === failedId) {
        throw new Error('database permission denied')
      }
    }
    const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
    assert.equal(result.failed, 1, failedId)
    assert.equal(result.sent, 0, failedId)
    assert.equal(cloud.sentMessages.length, 0, failedId)
    assert.deepEqual(cloud.records.subscriptions, before, failedId)
  }
})

test('发送失败恢复后同月重跑仍可发送，成功后不再重复', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), subscription('s2', 'u1'), quota('u1', 2)],
    clothes: [item('u1-idle', 'u1', '旧衣物', '2025-01-01')],
    wear_records: [wear('u1-recent', 'u1', '2026-10-01', ['deleted'])]
  })
  cloud.faults.send = async () => { throw Error('network timeout') }
  const first = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(first.failed, 1)
  assert.equal(cloud.records.subscriptions.some(row => row.scene === 'idle-monthly-sent'), false)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 2)
  cloud.faults.send = null
  const second = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(second.sent, 1)
  assert.equal(cloud.sentMessages.length, 1)
  const third = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(third.sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
})

test('43101 失效后同月不再尝试该账号的其他授权', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), subscription('s2', 'u1'), quota('u1', 2)],
    clothes: [item('u1-idle', 'u1', '旧衣物', '2025-01-01')],
    wear_records: [wear('u1-recent', 'u1', '2026-10-01', ['deleted'])]
  })
  cloud.faults.send = async () => {
    const error = new Error('43101 user refuse')
    error.errCode = 43101
    throw error
  }
  const first = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(first.expired, 1)
  assert.equal(cloud.records.subscriptions.some(row => row._id === 's1'), false)
  cloud.faults.send = null
  const second = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(second.sent, 0)
  assert.equal(cloud.sentMessages.length, 0)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 's2').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
})

test('名称摘要保留总数后缀并限制在二十字符内', () => {
  const value = report.summarize(Array.from({ length: 4 }, (_, index) => ({ name: `特别特别长的衣物名称${index}` })))
  assert.ok(Array.from(value).length <= 20)
  assert.match(value, /等4件$/)
})

test('月报分页扫描全部授权记录', async () => {
  const subscriptions = Array.from({ length: 100 }, (_, index) => subscription(`used-${String(index).padStart(3, '0')}`, `used-${index}`, { consumedAt: NOW }))
  subscriptions.push(subscription('zzz-target', 'target'))
  subscriptions.push(quota('target', 1))
  const cloud = loadCloud({
    subscriptions,
    clothes: [item('target-idle', 'target', '旧衣物', '2025-01-01')],
    wear_records: [wear('target-recent', 'target', '2026-10-01', ['deleted'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.scanned, 101)
  assert.equal(result.sent, 1)
  assert.equal(cloud.calls.filter(call => call.collection === 'subscriptions' && call.operation === 'get').length, 2)
})

test('前页删除失效授权后游标翻页仍处理后续账号', async () => {
  const subscriptions = [subscription('000-expired', 'expired')]
  subscriptions.push(...Array.from({ length: 99 }, (_, index) =>
    subscription(`used-${String(index).padStart(3, '0')}`, `used-${index}`, { consumedAt: NOW })))
  subscriptions.push(subscription('zzz-target', 'target'))
  const cloud = loadCloud({
    subscriptions,
    clothes: [item('expired-idle', 'expired', '失效衣物', '2025-01-01'), item('target-idle', 'target', '目标衣物', '2025-01-01')],
    wear_records: [wear('expired-recent', 'expired', '2026-10-01', ['deleted']), wear('target-recent', 'target', '2026-10-01', ['deleted'])]
  })
  cloud.faults.send = async message => {
    if (message.touser === 'expired') {
      const error = new Error('43101 user refuse')
      error.errCode = 43101
      throw error
    }
  }

  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.expired, 1)
  assert.equal(result.sent, 1)
  assert.deepEqual(cloud.sentMessages.map(message => message.touser), ['target'])
})

test('月报内容与数量排除一级其他，混合实穿记录保留合格单品与日期', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [
      item('idle-pants', 'u1', '闲置长裤', '2025-01-01'),
      { ...item('idle-misc', 'u1', '闲置摆件', '2025-01-01'), category: '其他' },
      item('worn-shirt', 'u1', '常穿衬衫', '2025-01-01'),
      { ...item('worn-misc', 'u1', '常穿摆件', '2025-01-01'), category: '其他' }
    ],
    wear_records: [wear('mixed', 'u1', '2026-10-01', ['worn-shirt', 'worn-misc'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.data.number16.value, 1)
  assert.ok(message.data.thing29.value.includes('闲置长裤'))
  assert.ok(!message.data.thing29.value.includes('摆件'))
  // 混合记录中的合格单品按日期参与计算，常穿衬衫不判闲置
  assert.ok(!message.data.thing29.value.includes('常穿衬衫'))
})

test('只有其他衣物且实穿记录仅含其他时，月报跳过且不消耗额度', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [{ ...item('misc', 'u1', '摆件', '2025-01-01'), category: '其他' }],
    wear_records: [wear('only-misc', 'u1', '2026-10-01', ['misc'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.equal(cloud.sentMessages.length, 0)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 's1').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
})

test('闲置候选只含其他时月报跳过，原始实穿记录完整保留', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [
      item('new-shirt', 'u1', '新衬衫', '2026-09-01'),
      { ...item('idle-misc', 'u1', '闲置摆件', '2025-01-01'), category: '其他' }
    ],
    wear_records: [wear('recent', 'u1', '2026-10-01', ['new-shirt', 'idle-misc'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.deepEqual(Array.from(cloud.records.wear_records[0].itemIds), ['new-shirt', 'idle-misc'])
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
})

test('购买日期缺失或无效时回退入库时间，两者均不可用不判定闲置', async () => {
  const createdOld = new Date('2026-01-01T00:00:00.000Z')
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [
      { ...item('no-date', 'u1', '无购买日期旧衣', ''), createdAt: createdOld },
      { ...item('bad-date', 'u1', '日期无效旧衣', 'not-a-date'), createdAt: createdOld },
      { ...item('no-info', 'u1', '无日期信息', '') }
    ],
    wear_records: [wear('recent', 'u1', '2026-10-01', ['deleted'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.data.number16.value, 2)
  assert.ok(message.data.thing29.value.includes('无购买日期旧衣'))
  assert.ok(message.data.thing29.value.includes('日期无效旧衣'))
  assert.ok(!message.data.thing29.value.includes('无日期信息'))
})

test('恰好满 90 天的衣物计入闲置，截止日当天穿着视为近期', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [
      item('exact-90', 'u1', '恰好满90天', '2026-07-11'),
      item('worn-cutoff', 'u1', '截止日穿着', '2026-07-11'),
      item('worn-after', 'u1', '截止日后穿着', '2026-07-11')
    ],
    wear_records: [
      wear('r1', 'u1', '2026-07-11', ['worn-cutoff']),
      wear('r2', 'u1', '2026-08-01', ['worn-after'])
    ]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.data.number16.value, 1)
  assert.ok(message.data.thing29.value.includes('恰好满90天'))
})

test('近 90 天新建搭配引用使衣物不判闲置，早于截止日的搭配不改变闲置判定', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [
      item('by-new-outfit', 'u1', '新搭配护衣', '2025-01-01'),
      item('by-old-outfit', 'u1', '旧搭配衣', '2025-01-01')
    ],
    outfits: [
      outfit('o-new', 'u1', '2026-10-01', ['by-new-outfit']),
      outfit('o-old', 'u1', '2026-01-01', ['by-old-outfit'])
    ],
    wear_records: [wear('recent', 'u1', '2026-10-01', ['deleted'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.data.number16.value, 1)
  assert.ok(message.data.thing29.value.includes('旧搭配衣'))
  assert.ok(!message.data.thing29.value.includes('新搭配护衣'))
  assert.equal(message.data.thing4.value, '近90天未穿也未搭配')
})

test('截止日当天新建的搭配视为近期活动，单独即可免除跳过', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [
      item('cutoff-protected', 'u1', '截止日搭配护衣', '2025-01-01'),
      item('plain-idle', 'u1', '普通闲置衣', '2025-01-01')
    ],
    outfits: [outfit('o-cutoff', 'u1', '2026-07-11', ['cutoff-protected'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.data.number16.value, 1)
  assert.ok(message.data.thing29.value.includes('普通闲置衣'))
  assert.ok(!message.data.thing29.value.includes('截止日搭配护衣'))
})

test('近 90 天既无实穿也无新建搭配时月报跳过且不消耗额度', async () => {
  const cloud = loadCloud({
    subscriptions: [subscription('s1', 'u1'), quota('u1', 1)],
    clothes: [item('dormant', 'u1', '沉寂旧衣', '2025-01-01')],
    outfits: [outfit('o-stale', 'u1', '2026-01-01', ['dormant'])],
    wear_records: [wear('w-stale', 'u1', '2026-01-01', ['dormant'])]
  })
  const result = await report.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now: NOW })
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.equal(cloud.sentMessages.length, 0)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 's1').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 1)
})
