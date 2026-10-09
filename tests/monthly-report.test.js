const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')
const report = require('../cloudfunctions/monthly-report/report')

const TEMPLATE_ID = 'CeSjEXCpR71PZvGbIoqCDgO0H0CSHSwGbo_7o7ZgLIE'
const NOW = new Date('2026-10-09T01:00:00.000Z')
const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
const subscription = (id, openid, patch = {}) => ({ _id: id, _openid: openid, scene: 'idle-monthly', createdAt: NOW, ...patch })
const quota = (openid, unused) => ({ _id: require('../cloudfunctions/auth/subscription').quotaId(openid), _openid: openid, scene: 'idle-monthly-quota', unused, createdAt: NOW })
const item = (id, openid, name, purchaseDate) => ({ _id: id, _openid: openid, name, purchaseDate })
const wear = (id, openid, date, itemIds = []) => ({ _id: id, _openid: openid, date, itemIds })

test('统计页仅在用户接受后登记一次月报额度', async () => {
  let state = 'accept', subscribed = 0
  const toasts = []
  const page = loadPage('stats', { subscribeReport: async () => { subscribed++ } }, {
    requestSubscribeMessage({ tmplIds, success }) {
      assert.deepEqual(Array.from(tmplIds), [TEMPLATE_ID])
      success({ [TEMPLATE_ID]: state })
    },
    showToast: options => toasts.push(options.title)
  })
  await page.onSubscribeReport()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已增加一次月报额度')
  state = 'reject'
  await page.onSubscribeReport()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已取消订阅')
  state = 'ban'
  await page.onSubscribeReport()
  assert.equal(toasts.at(-1), '请在设置中开启订阅消息')
  assert.equal(page.data.subscribing, false)
})

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
