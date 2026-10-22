const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadPage } = require('./support/page')
const streak = require('../utils/streak')

let page
global.Page = definition => { page = definition }
require('../pages/profile/profile')

const WEATHER_TEMPLATE_ID = 'gecbz6HZQxVtg7x5eMAY7ugCWXgeIQsuWK9ELJR4Xe0'
const REPORT_TEMPLATE_ID = 'CeSjEXCpR71PZvGbIoqCDgO0H0CSHSwGbo_7o7ZgLIE'
const pad = n => String(n).padStart(2, '0')
const fmt = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const daysAgo = n => { const date = new Date(); date.setDate(date.getDate() - n); return fmt(date) }

test('最贵衣物按数值价格计算', () => {
  const result = page.findMostExpensive([
    { name: '外套', price: '399.9', imageFileID: 'cloud://coat' },
    { name: '衬衫', price: 199 }
  ])

  assert.deepEqual(result, { name: '外套', price: 399.9, imageFileID: 'cloud://coat' })
})

test('最常用品牌按衣物件数计算并忽略空品牌', () => {
  const result = page.findFavoriteBrand([
    { brand: '品牌 A' },
    { brand: '品牌 B' },
    { brand: '品牌 A' },
    { brand: '  ' }
  ])

  assert.deepEqual(result, { name: '品牌 A', count: 2, initial: '品' })
})

test('空衣橱返回空偏好', () => {
  assert.equal(page.findMostExpensive([]), null)
  assert.equal(page.findFavoriteBrand([]), null)
})

// ---------- 连续打卡（W3） ----------

test('连续打卡跨月连续计数，今天缺卡不断签，昨天起断签归零', () => {
  const record = date => ({ date })
  assert.equal(streak.streakDays([record('2026-01-30'), record('2026-01-31'), record('2026-02-01')], '2026-02-01'), 3)
  assert.equal(streak.streakDays([record('2026-01-30'), record('2026-01-31')], '2026-02-01'), 2) // 今天未打卡不断签
  assert.equal(streak.streakDays([record('2026-01-29'), record('2026-01-31'), record('2026-02-01')], '2026-02-01'), 2) // 中间有缺断
  assert.equal(streak.streakDays([record('2026-01-29')], '2026-02-01'), 0)                          // 昨天已断签
  assert.equal(streak.streakDays([], '2026-02-01'), 0)
})

test('打卡统计忽略非法日期、未来日期并去重', () => {
  const records = [
    { date: '2026-02-01' }, { date: '2026-02-01' }, { date: '2026-13-01' },
    { date: '2031-01-01' }, { date: '2026-02-02' }, { date: '2026-01-31' }, {}
  ]
  assert.equal(streak.streakDays(records, '2026-02-01'), 2)
  assert.equal(streak.monthDays(records, '2026-02-01'), 1) // 本月仅 02-01 一天
})

test('个人页加载展示连续打卡卡片与城市', async () => {
  const today = daysAgo(0), yesterday = daysAgo(1)
  const records = [{ date: today }, { date: yesterday }, { date: yesterday }]
  const profile = loadPage('profile', {
    listItems: async () => [],
    listWearRecords: async () => records,
    cleanupStatus: async () => ({ pendingCleanup: false })
  }, {}, { profile: async () => ({ username: 'alice', cityName: '上海' }) })
  await profile.loadData()
  const month = today.slice(0, 7)
  const expectedMonthDays = new Set([today, yesterday].filter(date => date.startsWith(month))).size
  assert.equal(profile.data.cityName, '上海')
  assert.equal(profile.data.hasWearRecords, true)
  assert.equal(profile.data.streakDays, 2)
  assert.equal(profile.data.monthCheckins, expectedMonthDays)
})

test('个人页全量偏好包含十八类与其他，手工穿着打卡保留原引用', async () => {
  const { CATEGORIES } = require('../cloudfunctions/auth/categories')
  const items = CATEGORIES.map((category, index) => ({
    _id: `item-${category}`, category, name: category, brand: '全量品牌', price: index + 1,
    subcategory: category === '配饰' ? '袜子' : ''
  }))
  const today = daysAgo(0), yesterday = daysAgo(1)
  const records = [
    { date: today, itemIds: ['item-其他', 'item-配饰'] },
    { date: yesterday, itemIds: ['item-挂件', 'item-连衣裙'] }
  ]
  const before = structuredClone({ items, records })
  const profile = loadPage('profile', {
    listItems: async () => items,
    listWearRecords: async () => records,
    cleanupStatus: async () => ({ pendingCleanup: false })
  }, {}, { profile: async () => ({ username: 'alice' }) })
  await profile.loadData()
  assert.equal(profile.data.favoriteBrand.count, 18)
  assert.equal(profile.data.mostExpensive.name, '其他')
  assert.equal(profile.data.mostExpensive.price, 18)
  assert.equal(profile.data.hasWearRecords, true)
  assert.equal(profile.data.streakDays, 2)
  assert.equal(profile.data.monthCheckins, new Set(records.map(record => record.date).filter(date => date.startsWith(today.slice(0, 7)))).size)
  assert.deepEqual({ items, records }, before)
})

// ---------- 天气提醒订阅入口（W2） ----------

test('天气提醒订阅：接受积累额度，拒绝与禁用分别提示', async () => {
  let state = 'accept', subscribed = 0
  const toasts = []
  const profile = loadPage('profile', {
    subscribeWeather: async () => { subscribed++; return { success: true, remaining: 11 } }
  }, {
    requestSubscribeMessage({ tmplIds, success }) {
      assert.deepEqual(Array.from(tmplIds), [WEATHER_TEMPLATE_ID])
      success({ [WEATHER_TEMPLATE_ID]: state })
    },
    showToast: options => toasts.push(options.title)
  })
  profile.setData({ reportUnused: 7 })
  await profile.onSubscribeWeather()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已增加1次，剩余 1 次')
  assert.equal(profile.data.weatherUnused, 1)
  assert.equal(profile.data.reportUnused, 7)
  state = 'reject'
  await profile.onSubscribeWeather()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已取消订阅')
  state = 'ban'
  await profile.onSubscribeWeather()
  assert.equal(toasts.at(-1), '请在设置中开启订阅消息')
  assert.equal(profile.data.subscribingWeather, false)
})

test('个人页月报授权沿点击链触发，仅接受时更新月报次数且不改变天气次数', async () => {
  let state = 'accept', requested = 0, subscribed = 0, weatherSubscribed = 0
  const toasts = []
  const profile = loadPage('profile', {
    subscribeReport: async () => { subscribed++; return { unused: 3 } },
    subscribeWeather: async () => { weatherSubscribed++ }
  }, {
    requestSubscribeMessage({ tmplIds, success }) {
      requested++
      assert.deepEqual(Array.from(tmplIds), [REPORT_TEMPLATE_ID])
      success({ [REPORT_TEMPLATE_ID]: state })
    },
    showToast: options => toasts.push(options.title)
  })
  profile.setData({ weatherUnused: 5, reportUnused: 2, weatherQuotaLoading: false, reportQuotaLoading: false })
  const pending = profile.onSubscribeReport()
  assert.equal(requested, 1)
  await pending
  assert.equal(subscribed, 1)
  assert.equal(profile.data.reportUnused, 3)
  assert.equal(profile.data.weatherUnused, 5)
  assert.equal(toasts.at(-1), '已增加1次，剩余 3 次')
  state = 'reject'
  await profile.onSubscribeReport()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已取消订阅')
  state = 'ban'
  await profile.onSubscribeReport()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '请在设置中开启订阅消息')
  assert.equal(weatherSubscribed, 0)
  assert.equal(profile.data.weatherUnused, 5)
  assert.equal(profile.data.reportUnused, 3)
  assert.equal(profile.data.subscribingReport, false)
})

test('天气提醒授权偏好不作为剩余次数，读取不会自动新增订阅', () => {
  let subscribed = 0, requested = 0
  const profile = loadPage('profile', { subscribeWeather: () => { subscribed++ } }, {
    requestSubscribeMessage() { requested++ },
    getSetting({ success }) {
      success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { [WEATHER_TEMPLATE_ID]: 'accept' } } })
    }
  })
  profile.refreshWeatherState()
  assert.equal(profile.data.weatherStateText, '')
  assert.equal(profile.data.weatherUnused, null)
  assert.equal(subscribed, 0)
  assert.equal(requested, 0)
  const rejected = loadPage('profile', {}, {
    getSetting({ success }) {
      success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { [WEATHER_TEMPLATE_ID]: 'reject' } } })
    }
  })
  rejected.refreshWeatherState()
  assert.equal(rejected.data.weatherStateText, '你已拒绝订阅，可重新授权')
})

test('订阅成功反馈实际可接收次数，兼容旧响应并优先使用服务端实际次数', async () => {
  const toasts = []
  for (const [response, expected] of [
    [{ remaining: 11 }, 1],
    [{ remaining: 0 }, 12],
    [{ unused: 3 }, 3]
  ]) {
    const profile = loadPage('profile', { subscribeWeather: async () => response }, {
      requestSubscribeMessage: ({ success }) => success({ [WEATHER_TEMPLATE_ID]: 'accept' }),
      showToast: options => toasts.push(options.title)
    })
    await profile.onSubscribeWeather()
    assert.equal(toasts.at(-1), `已增加1次，剩余 ${expected} 次`)
    assert.equal(profile.data.weatherUnused, expected)
  }
})

test('每次进入个人页或下拉刷新单次查询更新两类剩余次数，包含零次', async () => {
  let weatherUnused = 3, reportUnused = 8, reads = 0, stopped = 0
  const profile = loadPage('profile', {
    listItems: async () => [], listWearRecords: async () => [],
    cleanupStatus: async () => ({ pendingCleanup: false }),
    getSubscriptionStatus: async () => { reads++; return { weatherUnused, reportUnused } }
  }, { stopPullDownRefresh() { stopped++ } }, { profile: async () => ({ username: 'alice' }) })
  await profile.onShow()
  assert.equal(profile.data.weatherUnused, 3)
  assert.equal(profile.data.reportUnused, 8)
  weatherUnused = 2
  reportUnused = 7
  await profile.onShow()
  assert.equal(profile.data.weatherUnused, 2)
  assert.equal(profile.data.reportUnused, 7)
  weatherUnused = 0
  reportUnused = 0
  await profile.onPullDownRefresh()
  assert.equal(profile.data.weatherUnused, 0)
  assert.equal(profile.data.reportUnused, 0)
  assert.equal(profile.data.weatherQuotaError, false)
  assert.equal(profile.data.weatherQuotaLoading, false)
  assert.equal(profile.data.reportQuotaError, false)
  assert.equal(profile.data.reportQuotaLoading, false)
  assert.equal(reads, 3)
  assert.equal(stopped, 1)
})

test('两类次数读取失败显示未知并可重试，恢复为零时不影响个人资料', async () => {
  let failed = true
  const profile = loadPage('profile', {
    listItems: async () => [], listWearRecords: async () => [],
    cleanupStatus: async () => ({ pendingCleanup: false }),
    getSubscriptionStatus: async () => {
      if (failed) throw new Error('offline')
      return { weatherUnused: 0, reportUnused: 0 }
    }
  }, {}, { profile: async () => ({ username: 'alice' }) })
  profile.setData({ weatherUnused: 4, reportUnused: 6 })
  await profile.onShow()
  assert.equal(profile.data.username, 'alice')
  assert.equal(profile.data.loadError, '')
  assert.equal(profile.data.weatherUnused, null)
  assert.equal(profile.data.weatherQuotaError, true)
  assert.equal(profile.data.weatherQuotaLoading, false)
  assert.equal(profile.data.reportUnused, null)
  assert.equal(profile.data.reportQuotaError, true)
  assert.equal(profile.data.reportQuotaLoading, false)
  failed = false
  await profile.loadSubscriptionStatus()
  assert.equal(profile.data.weatherUnused, 0)
  assert.equal(profile.data.weatherQuotaError, false)
  assert.equal(profile.data.reportUnused, 0)
  assert.equal(profile.data.reportQuotaError, false)
})

test('个人页旧查询与天气或月报订阅交错，各自保留新次数且不悬挂另一类加载', async () => {
  for (const kinds of [['weather'], ['report'], ['weather', 'report']]) {
    let finish
    const profile = loadPage('profile', {
      getSubscriptionStatus: () => new Promise(resolve => { finish = resolve }),
      subscribeWeather: async () => ({ unused: 3 }),
      subscribeReport: async () => ({ unused: 9 })
    }, {
      requestSubscribeMessage: ({ tmplIds, success }) => success({ [tmplIds[0]]: 'accept' })
    })
    const reading = profile.loadSubscriptionStatus()
    assert.equal(profile.data.weatherQuotaLoading, true)
    assert.equal(profile.data.reportQuotaLoading, true)
    if (kinds.includes('weather')) await profile.onSubscribeWeather()
    if (kinds.includes('report')) await profile.onSubscribeReport()
    finish({ weatherUnused: 2, reportUnused: 8 })
    await reading
    assert.equal(profile.data.weatherUnused, kinds.includes('weather') ? 3 : 2)
    assert.equal(profile.data.reportUnused, kinds.includes('report') ? 9 : 8)
    assert.equal(profile.data.weatherQuotaLoading, false)
    assert.equal(profile.data.weatherQuotaError, false)
    assert.equal(profile.data.reportQuotaLoading, false)
    assert.equal(profile.data.reportQuotaError, false)
  }
})

test('天气和月报剩余次数达到或超过十二次时均不再请求授权', async () => {
  let requested = 0, subscribed = 0
  const profile = loadPage('profile', {
    subscribeWeather: async () => { subscribed++ }, subscribeReport: async () => { subscribed++ }
  }, {
    requestSubscribeMessage: () => { requested++ }
  })
  for (const unused of [12, 13]) {
    profile.setData({ weatherUnused: unused, reportUnused: unused })
    await profile.onSubscribeWeather()
    await profile.onSubscribeReport()
    assert.equal(profile.data.weatherUnused, unused)
    assert.equal(profile.data.reportUnused, unused)
  }
  assert.equal(requested, 0)
  assert.equal(subscribed, 0)
})

test('天气授权请求失败不会新增订阅，解除提交状态并允许重试', async () => {
  let subscribed = 0, failed = true
  const toasts = []
  const profile = loadPage('profile', {
    subscribeWeather: async () => { subscribed++; return { unused: 1 } }
  }, {
    requestSubscribeMessage({ success, fail }) {
      if (failed) fail(new Error('授权请求失败'))
      else success({ [WEATHER_TEMPLATE_ID]: 'accept' })
    },
    showToast: options => toasts.push(options.title)
  })
  await profile.onSubscribeWeather()
  assert.equal(subscribed, 0)
  assert.equal(profile.data.subscribingWeather, false)
  assert.equal(toasts.at(-1), '授权请求失败')
  failed = false
  await profile.onSubscribeWeather()
  assert.equal(subscribed, 1)
  assert.equal(profile.data.subscribingWeather, false)
})

test('取消对应提醒清零次数，旧查询不会覆盖取消结果且另一类正常结束加载', async () => {
  for (const scene of ['weather', 'report']) {
    const kind = scene === 'weather' ? 'Weather' : 'Report'
    let finishCancel, finishQuery, cancelled = 0
    const profile = loadPage('profile', {
      [`cancel${kind}`]: () => { cancelled++; return new Promise(resolve => { finishCancel = resolve }) },
      getSubscriptionStatus: () => new Promise(resolve => { finishQuery = resolve })
    })
    profile.setData({ weatherUnused: 4, reportUnused: 6, weatherQuotaLoading: false, reportQuotaLoading: false })
    const pending = profile.onCancelReminder({ currentTarget: { dataset: { scene } } })
    assert.equal(cancelled, 1)
    assert.equal(profile.data[`canceling${kind}`], true)
    assert.equal(profile.data[`${scene}Unused`], scene === 'weather' ? 4 : 6)
    const reading = profile.loadSubscriptionStatus()
    finishCancel({ success: true, unused: 0 })
    await pending
    finishQuery({ weatherUnused: 4, reportUnused: 6 })
    await reading
    assert.equal(profile.data.weatherUnused, scene === 'weather' ? 0 : 4)
    assert.equal(profile.data.reportUnused, scene === 'report' ? 0 : 6)
    assert.equal(profile.data[`canceling${kind}`], false)
    assert.equal(profile.data.weatherQuotaLoading, false)
    assert.equal(profile.data.reportQuotaLoading, false)
    assert.equal(profile.data.weatherQuotaError, false)
    assert.equal(profile.data.reportQuotaError, false)
  }
})

test('取消失败保留次数可重试，零次和未知状态不可取消，同类操作互斥且另一类独立', async () => {
  for (const scene of ['weather', 'report']) {
    const kind = scene === 'weather' ? 'Weather' : 'Report'
    const otherKind = scene === 'weather' ? 'Report' : 'Weather'
    const templateId = scene === 'weather' ? WEATHER_TEMPLATE_ID : REPORT_TEMPLATE_ID
    const event = { currentTarget: { dataset: { scene } } }
    let rejectCancel, finishAuthorization, cancelled = 0, requested = 0, retry = false, holdAuthorization = false
    const toasts = []
    const profile = loadPage('profile', {
      [`cancel${kind}`]: () => {
        cancelled++
        return retry ? Promise.resolve({ success: true, unused: 0 }) : new Promise((resolve, reject) => { rejectCancel = reject })
      },
      subscribeWeather: async () => ({ unused: 5 }),
      subscribeReport: async () => ({ unused: 7 })
    }, {
      requestSubscribeMessage({ tmplIds, success }) {
        requested++
        if (holdAuthorization && tmplIds[0] === templateId) finishAuthorization = () => success({ [templateId]: 'accept' })
        else success({ [tmplIds[0]]: 'accept' })
      },
      showToast: options => toasts.push(options.title)
    })
    for (const state of [
      { unused: 0, loading: false, error: false },
      { unused: null, loading: false, error: false },
      { unused: 4, loading: true, error: false },
      { unused: 4, loading: false, error: true }
    ]) {
      profile.setData({ [`${scene}Unused`]: state.unused, [`${scene}QuotaLoading`]: state.loading, [`${scene}QuotaError`]: state.error })
      await profile.onCancelReminder(event)
    }
    assert.equal(cancelled, 0)
    profile.setData({ weatherUnused: 4, reportUnused: 6, weatherQuotaLoading: false, reportQuotaLoading: false,
      weatherQuotaError: false, reportQuotaError: false })
    const pending = profile.onCancelReminder(event)
    await profile.onCancelReminder(event)
    await profile[`onSubscribe${kind}`]()
    assert.equal(cancelled, 1)
    assert.equal(requested, 0)
    await profile[`onSubscribe${otherKind}`]()
    assert.equal(requested, 1)
    rejectCancel(new Error('取消失败，请重试'))
    await pending
    assert.equal(profile.data[`${scene}Unused`], scene === 'weather' ? 4 : 6)
    assert.equal(profile.data[`canceling${kind}`], false)
    assert.equal(toasts.at(-1), '取消失败，请重试')
    holdAuthorization = true
    const subscribing = profile[`onSubscribe${kind}`]()
    await profile.onCancelReminder(event)
    assert.equal(cancelled, 1)
    finishAuthorization()
    await subscribing
    retry = true
    await profile.onCancelReminder(event)
    assert.equal(cancelled, 2)
    assert.equal(profile.data[`${scene}Unused`], 0)
    assert.equal(profile.data[`${scene === 'weather' ? 'report' : 'weather'}Unused`], scene === 'weather' ? 7 : 5)
    assert.equal(profile.data[`canceling${kind}`], false)
  }
})

test('城市设置：确认后调用云端并回显，失败提示原因', async () => {
  const toasts = []
  let called = ''
  const profile = loadPage('profile', {
    setCity: async name => { called = name; return { success: true, cityId: '101020100', cityName: '上海' } }
  }, {
    showActionSheet: options => options.success({ tapIndex: 1 }),
    showModal: options => options.success({ confirm: true, content: ' 上海 ' }),
    showToast: options => toasts.push(options.title)
  })
  profile.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(called, '上海')
  assert.equal(profile.data.cityName, '上海')
  assert.equal(toasts.at(-1), '已设置为 上海')
  const failing = loadPage('profile', {
    setCity: async () => { throw new Error('未找到该城市，请检查名称') }
  }, {
    showActionSheet: options => options.success({ tapIndex: 1 }),
    showModal: options => options.success({ confirm: true, content: '火星' }),
    showToast: options => toasts.push(options.title)
  })
  failing.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(toasts.at(-1), '未找到该城市，请检查名称')
})

test('城市定位：模糊定位成功写入区县并弹确认，授权被拒提示替代方式', async () => {
  const modals = []
  let called = null
  const profile = loadPage('profile', {
    setCityByLocation: async (lng, lat) => { called = [lng, lat]; return { success: true, cityId: '310115', cityName: '上海市浦东新区' } }
  }, {
    showActionSheet: options => options.success({ tapIndex: 0 }),
    getFuzzyLocation: options => options.success({ longitude: 121.54, latitude: 31.22 }),
    showModal: options => { modals.push(options); options.success && options.success({ confirm: true }) }
  })
  profile.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(called, [121.54, 31.22])
  assert.equal(profile.data.cityName, '上海市浦东新区')
  assert.equal(profile.data.locating, false)
  assert.equal(modals.at(-1).title, '已定位到')
  assert.equal(modals.at(-1).content, '上海市浦东新区')
  // 授权被拒：提示手动输入或地图选点
  const denied = loadPage('profile', {}, {
    showActionSheet: options => options.success({ tapIndex: 0 }),
    getFuzzyLocation: options => options.fail({ errMsg: 'getFuzzyLocation:fail auth deny' }),
    showModal: options => { modals.push(options); options.success && options.success({ confirm: true }) }
  })
  denied.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(modals.at(-1).title, '定位失败')
  assert.match(modals.at(-1).content, /手动输入或地图选点/)
  assert.equal(denied.data.locating, false)
  // 云端解析失败：透传错误原因
  const failing = loadPage('profile', {
    setCityByLocation: async () => { throw new Error('未找到该位置，请手动输入城市') }
  }, {
    showActionSheet: options => options.success({ tapIndex: 0 }),
    getFuzzyLocation: options => options.success({ longitude: 139.7, latitude: 35.7 }),
    showModal: options => { modals.push(options); options.success && options.success({ confirm: true }) }
  })
  failing.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(modals.at(-1).title, '定位失败')
  assert.equal(modals.at(-1).content, '未找到该位置，请手动输入城市')
  // errno 112：位置声明未生效（隐私指引审核中），只引导手动输入
  const undeclared = loadPage('profile', {}, {
    showActionSheet: options => options.success({ tapIndex: 0 }),
    getFuzzyLocation: options => options.fail({ errMsg: 'getFuzzyLocation:fail api scope is not declared in the privacy agreement', errno: 112 }),
    showModal: options => { modals.push(options); options.success && options.success({ confirm: true }) }
  })
  undeclared.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(modals.at(-1).title, '定位失败')
  assert.match(modals.at(-1).content, /位置能力审核中/)
  assert.doesNotMatch(modals.at(-1).content, /privacy agreement/)
  // no permission：接口权限未开通（mp 后台审核中），同样引导手动输入而非弹出英文 errMsg
  const noPermission = loadPage('profile', {}, {
    showActionSheet: options => options.success({ tapIndex: 0 }),
    getFuzzyLocation: options => options.fail({ errMsg: 'getFuzzyLocation:fail no permission' }),
    showModal: options => { modals.push(options); options.success && options.success({ confirm: true }) }
  })
  noPermission.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(modals.at(-1).title, '定位失败')
  assert.match(modals.at(-1).content, /位置能力审核中/)
  assert.doesNotMatch(modals.at(-1).content, /no permission/)
})

test('城市地图选点：选点坐标走逆地理编码，取消不提示', async () => {
  const toasts = []
  let called = null
  const modals = []
  const profile = loadPage('profile', {
    setCityByLocation: async (lng, lat) => { called = [lng, lat]; return { success: true, cityId: '330106', cityName: '杭州市西湖区' } }
  }, {
    showActionSheet: options => options.success({ tapIndex: 2 }),
    chooseLocation: options => options.success({ longitude: 120.13, latitude: 30.27, address: '浙江省杭州市西湖区文三路' }),
    showModal: options => { modals.push(options); options.success && options.success({ confirm: true }) },
    showToast: options => toasts.push(options.title)
  })
  profile.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(called, [120.13, 30.27])
  assert.equal(profile.data.cityName, '杭州市西湖区')
  assert.equal(modals.at(-1).title, '已定位到')
  // 用户取消选点：静默返回，不弹提示
  const toastCount = toasts.length
  const cancelled = loadPage('profile', {}, {
    showActionSheet: options => options.success({ tapIndex: 2 }),
    chooseLocation: options => options.fail({ errMsg: 'chooseLocation:fail cancel' }),
    showToast: options => toasts.push(options.title)
  })
  cancelled.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled.data.locating, false)
  assert.equal(toasts.length, toastCount)
  // errno 112：位置声明未生效时给中文提示而非英文 errMsg
  const undeclared = loadPage('profile', {}, {
    showActionSheet: options => options.success({ tapIndex: 2 }),
    chooseLocation: options => options.fail({ errMsg: 'chooseLocation:fail api scope is not declared in the privacy agreement', errno: 112 }),
    showToast: options => toasts.push(options.title)
  })
  undeclared.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(toasts.at(-1), '选点暂不可用，请手动输入城市')
  // no permission：接口权限未开通时同样给中文提示
  const noPermission = loadPage('profile', {}, {
    showActionSheet: options => options.success({ tapIndex: 2 }),
    chooseLocation: options => options.fail({ errMsg: 'chooseLocation:fail no permission' }),
    showToast: options => toasts.push(options.title)
  })
  noPermission.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(toasts.at(-1), '选点暂不可用，请手动输入城市')
})
