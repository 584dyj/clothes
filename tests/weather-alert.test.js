const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const alert = require('../cloudfunctions/weather-alert/alert')

const TEMPLATE_ID = 'gecbz6HZQxVtg7x5eMAY7ugCWXgeIQsuWK9ELJR4Xe0'
const NOW = new Date('2026-10-09T13:30:00.000Z') // 上海时间 2026-10-09 21:30
const ENV = { WEATHER_API_KEY: 'test-key' }
const CITY = '500156' // 武隆区 adcode

const sub = (id, openid, patch = {}) => ({ _id: id, _openid: openid, scene: 'weather-alert', createdAt: NOW, ...patch })
const quota = (openid, patch = {}) => ({ _id: alert.quotaId(openid), _openid: openid, scene: 'weather-alert-quota', unused: 1, createdAt: NOW, ...patch })
const cityUser = (openid, patch = {}) => ({ _id: 'user-' + openid, openid, username: openid, autoLoginEnabled: true, cityId: CITY, cityName: '重庆市武隆区', ...patch })
const item = (id, openid, name, patch = {}) => ({ _id: id, _openid: openid, name, ...patch })
// 高德 casts 项：夜间温度作最低、白天温度作最高
const cast = (tempMin, tempMax, text) => ({ date: '2026-10-09', dayweather: text, nightweather: text, daytemp: String(tempMax), nighttemp: String(tempMin) })
const forecast = (today, tomorrow) => ({ status: '1', forecasts: [{ casts: [today, tomorrow] }] })
// 归一化后的日形状（evaluate 的输入）
const nday = (tempMin, tempMax, textDay) => ({ tempMin: String(tempMin), tempMax: String(tempMax), textDay })
// 降温 8°C 且无降水（不触发其他规则）
const DROP_FORECAST = forecast(cast(20, 28, '多云'), cast(12, 22, '阴'))
const NORMAL_FORECAST = forecast(cast(20, 28, '多云'), cast(19, 27, '多云'))

// 按请求路径中的关键字分发响应；calls 记录调用路径
function stubWeather(map, calls = []) {
  return async ({ host, path }) => {
    calls.push(path)
    for (const [key, value] of Object.entries(map)) {
      if (path.includes(key)) {
        if (value instanceof Error) throw value
        return value
      }
    }
    throw new Error('未预期的天气请求: ' + path)
  }
}

function run(cloud, request, now = NOW) {
  return alert.handle({ db: cloud.db, cloud: cloud.cloudService, templateId: TEMPLATE_ID, now, request, env: ENV })
}

test('天气提醒每日21:30、闲置月报每月1日09:00的定时配置', () => {
  assert.deepEqual(require('../cloudfunctions/weather-alert/config.json').triggers, [
    { name: 'weather-alert', type: 'timer', config: '0 30 21 * * * *' }
  ])
  assert.deepEqual(require('../cloudfunctions/monthly-report/config.json').triggers, [
    { name: 'monthly-report', type: 'timer', config: '0 0 9 1 * * *' }
  ])
})

// ---------- 触发规则 ----------

test('特殊天气规则边界与优先级', () => {
  const evaluate = (t1, t2) => alert.evaluate(nday(...t1), nday(...t2))
  assert.deepEqual(evaluate([20, 28, '多云'], [14, 26, '多云']), { type: 'drop', delta: 6 }) // 恰好降 6°C 触发
  assert.equal(evaluate([20, 28, '多云'], [15, 26, '多云']), null)                          // 降 5°C 不触发
  assert.deepEqual(evaluate([20, 28, '晴'], [20, 26, '雷阵雨']), { type: 'rain' })
  assert.equal(evaluate([20, 28, '小雨'], [20, 26, '大雨']), null)                          // 今天已有雨不进入特殊降水规则
  assert.deepEqual(evaluate([20, 34, '多云'], [25, 35, '晴']), { type: 'hot', temp: 35 })   // 恰好 35°C 触发
  assert.equal(evaluate([20, 35, '多云'], [25, 36, '晴']), null)                            // 今天已高温不进入特殊高温规则
  assert.deepEqual(evaluate([10, 20, '多云'], [12, 26, '多云']), { type: 'rise', delta: 6 })
  assert.equal(evaluate([10, 20, '多云'], [12, 25, '多云']), null)
  assert.deepEqual(evaluate([20, 28, '多云'], [12, 22, '小雨']), { type: 'drop', delta: 8 }) // 降温优先于降水
  assert.equal(alert.evaluate(nday(20, 28, '多云'), { tempMin: 'x', tempMax: '22', textDay: '阴' }), null) // 温度无效不触发
})

test('高德预报归一化：夜间温度作最低温，昼夜现象不同合并', async () => {
  const res = forecast(cast(20, 28, '多云'), { date: '2026-10-10', dayweather: '多云', nightweather: '小雨', daytemp: '26', nighttemp: '14' })
  const parsed = await alert.fetchForecast({ request: stubWeather({ weatherInfo: res }), host: 'https://restapi.amap.com', key: 'k', cityId: CITY })
  assert.deepEqual(parsed.tomorrow, { tempMin: '14', tempMax: '26', textDay: '多云转小雨' })
  await assert.rejects(
    alert.fetchForecast({ request: stubWeather({ weatherInfo: { status: '0', info: 'INVALID_USER_KEY' } }), host: 'h', key: 'k', cityId: CITY }),
    /天气预报数据无效/)
})

// ---------- 内容生成 ----------

test('推送摘要不超过二十字，空衣橱有提示，雨天完整说明仍提醒带伞', () => {
  for (const weather of [nday(14, 20, '多云'), nday(2, 8, '阴'), nday(26, 36, '晴'), nday(18, 25, '小雨')]) {
    const rec = alert.buildRecommendation(weather, [], { trigger: { type: 'drop', delta: 8 } })
    assert.ok(Array.from(rec.advice).length <= 20)
    assert.match(rec.advice, /暂无适温衣物/)
    if (weather.textDay === '小雨') assert.match(rec.reason, /带伞/)
  }
})

test('buildRecommendation 返回文案、具体衣物 ID 与展示快照', () => {
  const items = [
    item('i1', 'u', '羽绒服', { seasons: ['冬'], category: '羽绒服', imageFileID: 'cloud://x/wardrobe/1.jpg' }),
    item('i2', 'u', '毛衣', { seasons: ['冬', '春秋'], category: '毛衣' }),
    item('i3', 'u', '短袖', { seasons: ['夏'], category: '短袖' })
  ]
  const rec = alert.buildRecommendation(nday(2, 8, '阴'), items)
  assert.equal(rec.advice, '明日偏冷，注意保暖')
  assert.deepEqual(rec.itemIds, ['i2', 'i1'])
  assert.deepEqual(rec.items, [
    { _id: 'i2', name: '毛衣', category: '毛衣', subcategory: '', imageFileID: '' },
    { _id: 'i1', name: '羽绒服', category: '羽绒服', subcategory: '', imageFileID: 'cloud://x/wardrobe/1.jpg' }
  ])
  // 空候选：advice 回退固定文案，itemIds/items 为空
  const empty = alert.buildRecommendation(nday(14, 20, '阴'), [])
  assert.equal(empty.advice, '暂无适温衣物，请自行搭配')
  assert.deepEqual(empty.itemIds, [])
  assert.deepEqual(empty.items, [])
})

// ---------- 发送主流程 ----------

test('命中降温发送一条，额度与模板字段正确', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1')],
    clothes: [item('i1', 'u1', '羽绒服', { seasons: ['冬'] })]
  })
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(summary.sent, 1)
  assert.equal(cloud.sentMessages.length, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.touser, 'u1')
  assert.equal(message.templateId, TEMPLATE_ID)
  assert.equal(message.page, 'pages/weather-outfit/weather-outfit?date=2026-10-10')
  assert.equal(message.data.thing12.value, '阴')
  assert.equal(message.data.character_string41.value, '12~22℃')
  assert.equal(message.data.thing2.value, '暂无适温衣物，请自行搭配')
  assert.equal(message.data.date4.value, '2026年10月10日')
  const quotaRow = cloud.records.subscriptions.find(row => row.scene === 'weather-alert-quota')
  assert.equal(quotaRow.unused, 0)
  // 同日重跑：授权已消耗且幂等标记存在，不再发送
  const again = await run(cloud, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(again.sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
})

test('发送成功后把每日推荐落库到 ai_cache，落地页可按日期读取', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1')],
    clothes: [
      item('down', 'u1', '羽绒服', { seasons: ['冬'], category: '羽绒服', imageFileID: 'cloud://x/down.jpg' }),
      item('tee', 'u1', '短袖', { seasons: ['夏'], category: '短袖' }),
      item('shirt', 'u1', '衬衫', { seasons: ['春秋'], category: '衬衫' })
    ]
  })
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(summary.sent, 1)
  const id = alert.recommendationId('u1', '2026-10-10')
  const rec = cloud.records.ai_cache.find(row => row._id === id)
  assert.ok(rec, '推荐文档已落库')
  assert.equal(rec._openid, 'u1')
  assert.equal(rec.date, '2026-10-10')
  assert.equal(rec.advice, '降温8度，按明日温度搭配')
  assert.deepEqual(rec.itemIds, ['shirt'])
  assert.equal(rec.items.length, 1)
  assert.equal(rec.items[0]._id, 'shirt')
  assert.equal(rec.status, 'sent')
  assert.match(rec.reason, /12～22℃/)
  assert.ok(rec.missing.includes('下装'))
  assert.equal(rec.weather.textDay, '阴')
})

test('幂等标记存在时同账号同日只发一次且不消耗额度', async () => {
  const marker = { _id: alert.sentId('u1', '2026-10-09'), _openid: 'u1', scene: 'weather-alert-sent', day: '2026-10-09', createdAt: NOW }
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1'), marker]
  })
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(summary.sent, 0)
  assert.equal(cloud.sentMessages.length, 0)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'w1').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'weather-alert-quota').unused, 1)
})

test('SDK 缺文档抛错时首次发送成功，同日重跑仍按标记去重', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), sub('w2', 'u1'), quota('u1', { unused: 2 })]
  })
  cloud.faults.before = (name, operation, id) => {
    if (name === 'subscriptions' && operation === 'doc.get' && !cloud.records.subscriptions.some(row => row._id === id)) {
      throw new Error(`document.get:fail document with _id ${id} does not exist`)
    }
  }
  const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
  const first = await run(cloud, request)
  assert.equal(first.failed, 0)
  assert.equal(first.sent, 1)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 1)
  assert.ok(cloud.records.subscriptions.some(row => row._id === alert.sentId('u1', '2026-10-09')))

  const again = await run(cloud, request)
  assert.equal(again.failed, 0)
  assert.equal(again.sent, 0)
  assert.equal(again.skipped, 1)
  assert.equal(again.claimSkipped, 1) // 当日已发送，认领失败
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 1)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && row.consumedAt).length, 1)
})

test('数据库读取异常保留为失败，不发送也不消耗授权', async () => {
  for (const message of ['document.get:fail permission denied', 'document.get:fail network timeout']) {
    const cloud = loadCloud({ users: [cityUser('u1')], subscriptions: [sub('w1', 'u1'), quota('u1')] })
    const before = structuredClone(cloud.records.subscriptions)
    cloud.faults.before = (name, operation, id) => {
      if (name === 'subscriptions' && operation === 'doc.get' && id === alert.sentId('u1', '2026-10-09')) throw new Error(message)
    }
    const summary = await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }))
    assert.equal(summary.failed, 1)
    assert.equal(summary.sent, 0)
    assert.equal(cloud.sentMessages.length, 0)
    assert.deepEqual(cloud.records.subscriptions, before)
  }
})

test('普通天气发送，未设城市与天气接口失败不发送也不消耗额度', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1'), cityUser('u2', { cityId: '', cityName: '' }), cityUser('u3', { cityId: 'bad-city' })],
    subscriptions: [sub('w1', 'u1'), quota('u1'), sub('w2', 'u2'), quota('u2'), sub('w3', 'u3'), quota('u3')]
  })
  const calls = []
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST, 'city=bad-city': new Error('天气服务不可用') }, calls))
  assert.equal(summary.sent, 1)
  assert.equal(summary.skipped, 2)
  assert.equal(summary.noCity, 1)        // u2 未设城市
  assert.equal(summary.weatherFailed, 1) // u3 城市天气接口失败
  assert.equal(cloud.sentMessages[0].touser, 'u1')
  assert.ok(cloud.sentMessages[0].data.thing2.value)
  assert.ok(cloud.records.subscriptions.find(row => row._id === 'w1').consumedAt)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 0)
  assert.deepEqual(calls.length, 2) // u2 未设城市不发起请求
  for (const openid of ['u2', 'u3']) {
    assert.equal(cloud.records.subscriptions.find(row => row._openid === openid && row.scene === 'weather-alert').consumedAt, undefined)
    assert.equal(cloud.records.subscriptions.find(row => row._openid === openid && row.scene === 'weather-alert-quota').unused, 1)
  }
})

test('天气接口温度非法或天气文本为空时跳过且不消耗授权', async () => {
  for (const patch of [{ nighttemp: '' }, { daytemp: 'x' }, { nighttemp: null }, { daytemp: '   ' }, { dayweather: '', nightweather: '' }]) {
    const cloud = loadCloud({ users: [cityUser('u1')], subscriptions: [sub('w1', 'u1'), quota('u1')] })
    const before = structuredClone(cloud.records.subscriptions)
    const invalid = forecast(cast(20, 28, '多云'), { ...cast(19, 27, '多云'), ...patch })
    const summary = await run(cloud, stubWeather({ ['city=' + CITY]: invalid }))
    assert.equal(summary.sent, 0)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.weatherFailed, 1) // 预报数据非法按天气接口失败归类
    assert.equal(cloud.sentMessages.length, 0)
    assert.deepEqual(cloud.records.subscriptions, before)
  }
})

test('旧数据月度计数达到八条仍可发送，旧字段保持不变', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1', { month: '2026-10', monthSent: 8 })]
  })
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }))
  assert.equal(summary.sent, 1)
  assert.equal(cloud.sentMessages.length, 1)
  assert.ok(cloud.records.subscriptions.find(row => row._id === 'w1').consumedAt)
  const quotaRow = cloud.records.subscriptions.find(row => row.scene === 'weather-alert-quota')
  assert.equal(quotaRow.unused, 0)
  assert.equal(quotaRow.month, '2026-10')
  assert.equal(quotaRow.monthSent, 8)
})

test('额度为零或无效、额度记录缺失或场景不匹配均不发送且不修改授权', async () => {
  for (const patch of [{ unused: 0 }, { unused: -1 }, { unused: 0.5 }, { unused: '1' }, { scene: 'idle-monthly-quota' }, null]) {
    const subscriptions = [sub('w1', 'u1')]
    if (patch) subscriptions.push(quota('u1', patch))
    const cloud = loadCloud({ users: [cityUser('u1')], subscriptions })
    const before = structuredClone(cloud.records.subscriptions)
    const summary = await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }))
    assert.equal(summary.sent, 0)
    assert.equal(cloud.sentMessages.length, 0)
    assert.deepEqual(cloud.records.subscriptions, before)
  }
})

test('连续两天普通天气各发一条，同日重跑不重复且每天只消耗一次额度', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), sub('w2', 'u1'), quota('u1', { unused: 2 })],
    clothes: [item('i1', 'u1', '卫衣', { seasons: ['春秋'], category: '长袖' })]
  })
  const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
  assert.equal((await run(cloud, request)).sent, 1)
  const message = cloud.sentMessages[0]
  assert.equal(message.data.thing12.value, '多云')
  assert.equal(message.data.character_string41.value, '19~27℃')
  assert.deepEqual(cloud.records.ai_cache.find(row => row.date === '2026-10-10').itemIds, ['i1'])
  assert.equal(message.data.date4.value, '2026年10月10日')
  assert.equal((await run(cloud, request)).sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 1)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && row.consumedAt).length, 1)

  const nextDay = new Date(NOW.getTime() + 86400000)
  assert.equal((await run(cloud, request, nextDay)).sent, 1)
  assert.equal(cloud.sentMessages[1].data.date4.value, '2026年10月11日')
  assert.equal((await run(cloud, request, nextDay)).sent, 0)
  assert.equal(cloud.sentMessages.length, 2)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 0)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && row.consumedAt).length, 2)
})

test('43101 删除授权记录且当天不再尝试，其他失败恢复额度', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1'), cityUser('u2')],
    subscriptions: [sub('w1', 'u1'), quota('u1'), sub('w2', 'u2'), quota('u2')],
    clothes: []
  })
  cloud.faults.send = data => { throw new Error(data.touser === 'u1' ? '43101 user refuse to accept' : '50031 system busy') }
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(summary.expired, 1)
  assert.equal(summary.failed, 1)
  assert.equal(cloud.records.subscriptions.some(row => row._id === 'w1'), false) // 43101 删除授权记录
  const quota1 = cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1'))
  assert.equal(quota1.unused, 0) // 43101 不恢复额度，与月报一致
  // 临时失败：额度恢复，幂等标记删除
  const quota2 = cloud.records.subscriptions.find(row => row._id === alert.quotaId('u2'))
  assert.equal(quota2.unused, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'w2').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.some(row => row._id === alert.sentId('u2', '2026-10-09')), false)
  // 恢复后同日重跑可成功发送
  cloud.faults.send = null
  const retry = await run(cloud, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(retry.sent, 1)
  assert.equal(cloud.sentMessages.at(-1).touser, 'u2')
})

test('发送在途新增订阅后失败，恢复全部已接受额度并限制继续订阅', async () => {
  const openid = 'openid-1'
  const cloud = loadCloud({
    users: [cityUser(openid)],
    subscriptions: [quota(openid, { unused: 12 }), ...Array.from({ length: 12 }, (_, i) => sub('w' + i, openid))]
  })
  const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
  cloud.faults.send = async () => {
    const subscribed = await cloud.main({ action: 'subscribeWeather' })
    assert.equal(subscribed.success, true)
    assert.equal(subscribed.unused, 12)
    throw new Error('50031 system busy')
  }
  assert.equal((await run(cloud, request)).failed, 1)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && !row.consumedAt).length, 13)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 13)
  assert.equal(cloud.records.subscriptions.some(row => row._id === alert.sentId(openid, '2026-10-09')), false)

  const rejected = await cloud.main({ action: 'subscribeWeather' })
  assert.equal(rejected.success, false)
  assert.match(rejected.error, /提醒额度已充足/)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && !row.consumedAt).length, 13)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 13)

  cloud.faults.send = null
  assert.equal((await run(cloud, request)).sent, 1)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && !row.consumedAt).length, 12)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 12)
  assert.equal(cloud.records.subscriptions.some(row => row._id === alert.sentId(openid, '2026-10-09')), true)
})

test('取消天气后旧授权不发送，重新订阅的新代可发送且耗尽后旧授权不复活', async () => {
  const openid = 'openid-1'
  const cloud = loadCloud({
    users: [cityUser(openid)],
    subscriptions: [sub('000-old-1', openid), sub('001-old-2', openid), quota(openid, { unused: 2 })]
  })
  const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
  assert.equal((await cloud.main({ action: 'cancelWeather' })).success, true)
  assert.equal((await run(cloud, request)).sent, 0)
  assert.equal(cloud.sentMessages.length, 0)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 0)

  assert.equal((await cloud.main({ action: 'subscribeWeather' })).unused, 1)
  const grant = cloud.records.subscriptions.find(row => row.scene === 'weather-alert' && row.generation === 1)
  assert.ok(grant)
  assert.equal((await run(cloud, request)).sent, 1)
  assert.ok(cloud.records.subscriptions.find(row => row._id === grant._id).consumedAt)
  assert.ok(cloud.records.subscriptions.filter(row => row._id.startsWith('00')).every(row => !row.consumedAt))
  assert.equal((await run(cloud, request, new Date(NOW.getTime() + 86400000))).sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 0)
})

test('天气发送在途取消后失败，旧代恢复不增加取消后或重新订阅的额度', async () => {
  for (const resubscribe of [false, true]) {
    const openid = 'openid-1'
    const cloud = loadCloud({
      users: [cityUser(openid)],
      subscriptions: [sub('000-old-claim', openid), sub('001-old-unused', openid), quota(openid, { unused: 2 })]
    })
    const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
    cloud.faults.send = async () => {
      assert.equal((await cloud.main({ action: 'cancelWeather' })).success, true)
      if (resubscribe) assert.equal((await cloud.main({ action: 'subscribeWeather' })).unused, 1)
      throw new Error('50031 system busy')
    }
    const failed = await run(cloud, request)
    assert.equal(failed.sent, 0)
    assert.equal(failed.failed, 1)
    const quotaRow = cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid))
    assert.equal(quotaRow.unused, resubscribe ? 1 : 0)
    assert.equal(quotaRow.generation, 1)
    assert.equal(cloud.records.subscriptions.some(row => row._id === alert.sentId(openid, '2026-10-09')), false)

    cloud.faults.send = null
    const retry = await run(cloud, request)
    assert.equal(retry.failed, 0)
    assert.equal(retry.sent, resubscribe ? 1 : 0)
    assert.equal(cloud.sentMessages.length, resubscribe ? 1 : 0)
    assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 0)
    if (resubscribe) assert.ok(cloud.records.subscriptions.some(row => row.scene === 'weather-alert' && row.generation === 1 && row.consumedAt))
    assert.equal((await run(cloud, request, new Date(NOW.getTime() + 86400000))).sent, 0)
  }
})

test('天气成功发送后取消和重新订阅保留当日标记，不重复发送', async () => {
  const openid = 'openid-1'
  const cloud = loadCloud({
    users: [cityUser(openid)],
    subscriptions: [sub('000-old-1', openid), sub('001-old-2', openid), quota(openid, { unused: 2 })]
  })
  const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
  assert.equal((await run(cloud, request)).sent, 1)
  const markerId = alert.sentId(openid, '2026-10-09')
  const marker = structuredClone(cloud.records.subscriptions.find(row => row._id === markerId))
  assert.ok(marker)
  assert.equal((await cloud.main({ action: 'cancelWeather' })).success, true)
  assert.deepEqual(cloud.records.subscriptions.find(row => row._id === markerId), marker)
  assert.equal((await cloud.main({ action: 'subscribeWeather' })).unused, 1)
  assert.equal((await run(cloud, request)).sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 1)
  assert.equal((await run(cloud, request, new Date(NOW.getTime() + 86400000))).sent, 1)
  assert.equal(cloud.sentMessages.length, 2)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId(openid)).unused, 0)
})

test('同城多账号只请求一次预报并各发一条', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1'), cityUser('u2')],
    subscriptions: [sub('w1', 'u1'), quota('u1'), sub('w2', 'u2'), quota('u2')]
  })
  const calls = []
  const summary = await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }, calls))
  assert.equal(summary.sent, 2)
  assert.equal(calls.filter(path => path.includes('city=' + CITY)).length, 1)
})

// ---------- subscribeWeather（auth 动作） ----------

test('subscribeWeather 需要登录、写独立场景额度、与月报互不影响', async () => {
  const authUser = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
  const monthlyQuota = { _id: require('../cloudfunctions/auth/subscription').quotaId('openid-1'), _openid: 'openid-1', scene: 'idle-monthly-quota', unused: 3, createdAt: NOW }
  const cloud = loadCloud({ users: [authUser()], subscriptions: [monthlyQuota] })
  const results = await Promise.all([
    cloud.main({ action: 'subscribeWeather' }),
    cloud.main({ action: 'subscribeWeather' })
  ])
  assert.ok(results.every(result => result.success))
  assert.deepEqual(results.map(result => result.unused).sort((a, b) => a - b), [1, 2])
  const rows = cloud.records.subscriptions.filter(row => row.scene === 'weather-alert')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row._id.startsWith('walert-')))
  const quotaRow = cloud.records.subscriptions.find(row => row.scene === 'weather-alert-quota')
  assert.equal(quotaRow._id, alert.quotaId('openid-1'))
  assert.equal(quotaRow.unused, 2)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'idle-monthly-quota').unused, 3) // 月报额度不动
  await cloud.main({ action: 'logout' })
  assert.match((await cloud.main({ action: 'subscribeWeather' })).error, /登录状态已失效/)
})

test('subscribeWeather 并发写入不会超过十二条未消耗额度', async () => {
  const authUser = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
  const cloud = loadCloud({
    users: [authUser()],
    subscriptions: [quota('openid-1', { unused: 12 }), ...Array.from({ length: 12 }, (_, i) => sub(`w${i}`, 'openid-1'))]
  })
  const results = await Promise.all([
    cloud.main({ action: 'subscribeWeather' }),
    cloud.main({ action: 'subscribeWeather' })
  ])
  assert.equal(results.filter(result => result.success).length, 0) // 已达 12 条上限，两次都拒绝
  assert.ok(results.every(result => /提醒额度已充足/.test(result.error || '')))
  assert.equal(cloud.records.subscriptions.filter(row => row.scene === 'weather-alert' && !row.consumedAt).length, 12)
})

// ---------- setCity（高德地理编码） ----------

test('setCity 校验登录态、解析成功写入、解析失败不落库', async () => {
  const geo = { status: '1', geocodes: [{ adcode: CITY, formatted_address: '重庆市武隆区' }] }
  const cloud = loadCloud({ users: [{ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true }] })
  const ok = await alert.setCity({ db: cloud.db, openid: 'openid-1', name: ' 武隆 ', request: stubWeather({ geocode: geo }), env: ENV })
  assert.deepEqual(ok, { success: true, cityId: CITY, cityName: '重庆市武隆区' })
  assert.equal(cloud.records.users[0].cityId, CITY)
  assert.equal(cloud.records.users[0].cityName, '重庆市武隆区')
  await assert.rejects(
    alert.setCity({ db: cloud.db, openid: 'openid-1', name: '火星', request: stubWeather({ geocode: { status: '1', geocodes: [] } }), env: ENV }),
    /未找到该城市/)
  assert.equal(cloud.records.users[0].cityId, CITY) // 解析失败不覆盖
  await assert.rejects(
    alert.setCity({ db: cloud.db, openid: 'openid-1', name: '', request: stubWeather({}), env: ENV }),
    /请输入城市名/)
  await assert.rejects(
    alert.setCity({ db: cloud.db, openid: 'stranger', name: '武隆', request: stubWeather({ geocode: geo }), env: ENV }),
    /登录状态已失效/)
})

test('setCity 拒绝已退出登录的账号', async () => {
  const cloud = loadCloud({ users: [{ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: false }] })
  await assert.rejects(
    alert.setCity({ db: cloud.db, openid: 'openid-1', name: '武隆', request: stubWeather({}), env: ENV }),
    /登录状态已失效/)
})

// ---------- setCityByLocation（高德逆地理编码） ----------

test('setCityByLocation 解析区县写入、直辖市与普通城市显示名、失败不落库', async () => {
  const pudong = { status: '1', regeocode: { formatted_address: '上海市浦东新区张江镇',
    addressComponent: { province: '上海市', city: [], district: '浦东新区', adcode: '310115' } } }
  const xihu = { status: '1', regeocode: { formatted_address: '浙江省杭州市西湖区文三路',
    addressComponent: { province: '浙江省', city: '杭州市', district: '西湖区', adcode: '330106' } } }
  const cloud = loadCloud({ users: [{ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true }] })
  // 直辖市：city 为 [] 时用省名拼接区县
  const ok = await alert.setCityByLocation({ db: cloud.db, openid: 'openid-1', longitude: 121.54, latitude: 31.22, request: stubWeather({ regeo: pudong }), env: ENV })
  assert.deepEqual(ok, { success: true, cityId: '310115', cityName: '上海市浦东新区' })
  assert.equal(cloud.records.users[0].cityId, '310115')
  assert.equal(cloud.records.users[0].cityName, '上海市浦东新区')
  // 普通城市：市 + 区
  const ok2 = await alert.setCityByLocation({ db: cloud.db, openid: 'openid-1', longitude: 120.13, latitude: 30.27, request: stubWeather({ regeo: xihu }), env: ENV })
  assert.deepEqual(ok2, { success: true, cityId: '330106', cityName: '杭州市西湖区' })
  // 无 adcode（如海外）解析失败且不覆盖已有城市
  await assert.rejects(
    alert.setCityByLocation({ db: cloud.db, openid: 'openid-1', longitude: 139.7, latitude: 35.7,
      request: stubWeather({ regeo: { status: '1', regeocode: { addressComponent: { province: [], city: [], district: [], adcode: [] } } } }), env: ENV }),
    /未找到该位置/)
  assert.equal(cloud.records.users[0].cityId, '330106')
  // 坐标非法、未登录
  await assert.rejects(
    alert.setCityByLocation({ db: cloud.db, openid: 'openid-1', longitude: 'abc', latitude: 31, request: stubWeather({}), env: ENV }),
    /定位坐标无效/)
  await assert.rejects(
    alert.setCityByLocation({ db: cloud.db, openid: 'stranger', longitude: 121.54, latitude: 31.22, request: stubWeather({ regeo: pudong }), env: ENV }),
    /登录状态已失效/)
})

test('天气候选排除一级其他、家居服及挂件，配饰子类其他可作一件点缀', async () => {
  const mixed = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1')],
    clothes: [
      item('down', 'u1', '羽绒服', { seasons: ['冬'], category: '羽绒服' }),
      item('dress', 'u1', '春秋裙', { seasons: ['春秋'], category: '连衣裙' }),
      item('misc', 'u1', '旧摆件', { seasons: ['冬'], category: '其他' }),
      item('home', 'u1', '睡衣', { seasons: ['春秋'], category: '家居服' }),
      item('charm', 'u1', '挂件', { category: '挂件' }),
      item('acc-other', 'u1', '杂件配饰', { seasons: ['冬'], category: '配饰', subcategory: '其他' })
    ]
  })
  const first = await run(mixed, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(first.sent, 1)
  const ids = mixed.records.ai_cache.find(row => row.date === '2026-10-10').itemIds
  assert.deepEqual(ids, ['dress', 'acc-other'])

  const onlyMisc = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1')],
    clothes: [item('misc', 'u1', '旧摆件', { seasons: ['冬'], category: '其他' })]
  })
  const second = await run(onlyMisc, stubWeather({ ['city=' + CITY]: DROP_FORECAST }))
  assert.equal(second.sent, 1)
  assert.equal(onlyMisc.sentMessages[0].data.thing2.value, '暂无适温衣物，请自行搭配')
})

// ---------- weatherRecommendation（auth 动作，落地页读取） ----------

test('weatherRecommendation 读取落库推荐、未命中返回空、日期与登录校验', async () => {
  const authUser = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
  const recId = require('../cloudfunctions/auth/recommend').recommendationId('openid-1', '2026-10-10')
  const cloud = loadCloud({
    users: [authUser()],
    ai_cache: [{ _id: recId, _openid: 'openid-1', date: '2026-10-10', advice: '降温8度：羽绒服',
      weather: { textDay: '阴', tempMin: '12', tempMax: '22' },
      itemIds: ['i1'], items: [{ _id: 'i1', name: '羽绒服', category: '羽绒服', subcategory: '', imageFileID: '' }] }]
  })
  const result = await cloud.main({ action: 'weatherRecommendation', date: '2026-10-10' })
  assert.equal(result.success, true)
  assert.equal(result.recommendation.advice, '降温8度：羽绒服')
  assert.deepEqual(result.recommendation.itemIds, ['i1'])
  assert.equal(result.recommendation.weather.textDay, '阴')
  // 未命中返回 null
  assert.equal((await cloud.main({ action: 'weatherRecommendation', date: '2026-10-11' })).recommendation, null)
  // 日期非法
  assert.match((await cloud.main({ action: 'weatherRecommendation', date: 'bad' })).error, /日期无效/)
  // 未登录
  await cloud.main({ action: 'logout' })
  assert.match((await cloud.main({ action: 'weatherRecommendation', date: '2026-10-10' })).error, /登录状态已失效/)
})

// ---------- previewRecommendation（测试用：只落库、不查额度幂等、不真发消息） ----------

test('previewRecommendation 生成并落库推荐，不发送消息也不消耗额度', async () => {
  const cloud = loadCloud({
    users: [cityUser('u1')],
    subscriptions: [sub('w1', 'u1'), quota('u1')],
    clothes: [item('down', 'u1', '羽绒服', { seasons: ['冬'], category: '羽绒服' })]
  })
  const result = await alert.previewRecommendation({ db: cloud.db, openid: 'u1', now: NOW,
    request: stubWeather({ ['city=' + CITY]: DROP_FORECAST }), env: ENV })
  assert.equal(result.success, true)
  assert.equal(result.date, '2026-10-10')
  assert.equal(result.advice, '暂无适温衣物，请自行搭配')
  assert.deepEqual(result.itemIds, [])
  assert.equal(result.count, 0)
  assert.equal(cloud.sentMessages.length, 0)
  const rec = cloud.records.ai_cache.find(row => row._id === alert.recommendationId('u1', '2026-10-10') + '-preview')
  assert.ok(rec, '推荐已写入 ai_cache')
  assert.equal(rec.advice, '暂无适温衣物，请自行搭配')
  assert.equal(rec.status, 'preview')
  assert.deepEqual(rec.itemIds, [])
  // 幂等/额度不受影响
  assert.equal(cloud.records.subscriptions.find(row => row._id === 'w1').consumedAt, undefined)
  assert.equal(cloud.records.subscriptions.find(row => row.scene === 'weather-alert-quota').unused, 1)
})

test('previewRecommendation 未设城市时拒绝', async () => {
  const cloud = loadCloud({ users: [cityUser('u1', { cityId: '', cityName: '' })] })
  await assert.rejects(
    alert.previewRecommendation({ db: cloud.db, openid: 'u1', now: NOW, request: stubWeather({}), env: ENV }),
    /请先在「我的」页设置城市/)
})

test('真实推送读取成功推荐及实穿记录轮换，失败和预览历史不参与，同一日预览不覆盖正式推荐', async () => {
  const clothes = [item('a', 'u1', '衬衫A', { category: '衬衫', seasons: ['春秋'] }),
    item('b', 'u1', '衬衫B', { category: '衬衫', seasons: ['春秋'] }),
    item('c', 'u1', '衬衫C', { category: '衬衫', seasons: ['春秋'] }),
    item('pants', 'u1', '长裤', { category: '长裤', seasons: ['春秋'] }),
    item('shoes', 'u1', '鞋', { category: '鞋' })]
  const first = alert.buildRecommendation(nday(19, 27, '多云'), clothes, { date: '2026-10-10', openid: 'u1' })
  const other = clothes.find(row => row.category === '衬衫' && !first.itemIds.includes(row._id))
  const cloud = loadCloud({ users: [cityUser('u1')], subscriptions: [sub('w1', 'u1'), quota('u1')], clothes,
    ai_cache: [{ ...first, _id: alert.recommendationId('u1', '2026-10-09'), _openid: 'u1', date: '2026-10-09', status: 'sent' }],
    wear_records: [ { _id: 'wear', _openid: 'u1', date: '2026-10-09', itemIds: [other._id] },
      { _id: 'foreign', _openid: 'u2', date: '2026-10-09', itemIds: clothes.map(row => row._id) } ] })
  assert.equal((await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }))).sent, 1)
  const id = alert.recommendationId('u1', '2026-10-10')
  const saved = structuredClone(cloud.records.ai_cache.find(row => row._id === id))
  assert.notEqual(saved.bodyKey, first.bodyKey)
  assert.ok(!saved.itemIds.includes(other._id))
  const preview = await alert.previewRecommendation({ db: cloud.db, openid: 'u1', now: NOW,
    request: stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }), env: ENV })
  assert.deepEqual(preview.itemIds, saved.itemIds)
  assert.deepEqual(cloud.records.ai_cache.find(row => row._id === id), saved)
  cloud.setOpenid('u1')
  const response = await cloud.main({ action: 'weatherRecommendation', date: '2026-10-10' })
  assert.equal(response.recommendation.reason, saved.reason)
  assert.deepEqual(response.recommendation.missing, saved.missing)

  for (const status of ['prepared', 'preview']) {
    const isolated = loadCloud({ users: [cityUser('u1')], clothes, ai_cache: [
      { ...first, _id: alert.recommendationId('u1', '2026-10-09'), _openid: 'u1', date: '2026-10-09', status }
    ] })
    const rec = await alert.previewRecommendation({ db: isolated.db, openid: 'u1', now: NOW,
      request: stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }), env: ENV })
    assert.deepEqual(rec.itemIds, first.itemIds, status)
    isolated.setOpenid('u1')
    const read = await isolated.main({ action: 'weatherRecommendation', date: '2026-10-10' })
    assert.deepEqual(read.recommendation.itemIds, rec.itemIds)
  }
})

test('失败推送不进入轮换，发送成功后历史标记失败也保留额度和幂等', async () => {
  const cloud = loadCloud({ users: [cityUser('u1')], subscriptions: [sub('w1', 'u1'), sub('w2', 'u1'), quota('u1', { unused: 2 })] })
  const request = stubWeather({ ['city=' + CITY]: NORMAL_FORECAST })
  cloud.faults.send = new Error('temporary')
  assert.equal((await run(cloud, request)).failed, 1)
  const id = alert.recommendationId('u1', '2026-10-10')
  assert.equal(cloud.records.ai_cache.find(row => row._id === id).status, 'prepared')
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 2)
  cloud.faults.send = null
  cloud.faults.before = (name, operation) => { if (name === 'ai_cache' && operation === 'update') throw new Error('history unavailable') }
  assert.equal((await run(cloud, request)).sent, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 1)
  assert.equal((await run(cloud, request)).sent, 0)
  assert.equal(cloud.sentMessages.length, 1)
})

test('推荐历史读取失败不消耗额度，预览拒绝把明日预报写到其他日期', async () => {
  const cloud = loadCloud({ users: [cityUser('u1')], subscriptions: [sub('w1', 'u1'), quota('u1')] })
  cloud.faults.before = (name, operation) => { if (name === 'ai_cache' && operation === 'doc.get') throw new Error('history unavailable') }
  assert.equal((await run(cloud, stubWeather({ ['city=' + CITY]: NORMAL_FORECAST }))).failed, 1)
  assert.equal(cloud.records.subscriptions.find(row => row._id === alert.quotaId('u1')).unused, 1)
  assert.equal(cloud.sentMessages.length, 0)
  await assert.rejects(alert.previewRecommendation({ db: cloud.db, openid: 'u1', now: NOW, date: '2026-10-12', env: ENV }), /只能预览明日/)
})
