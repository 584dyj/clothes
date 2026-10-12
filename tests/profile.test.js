const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')
const streak = require('../utils/streak')

let page
global.Page = definition => { page = definition }
require('../pages/profile/profile')

const WEATHER_TEMPLATE_ID = 'gecbz6HZQxVtg7x5eMAY7ugCWXgeIQsuWK9ELJR4Xe0'
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
  await profile.onSubscribeWeather()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已增加一次提醒额度，剩余可订 11 次')
  state = 'reject'
  await profile.onSubscribeWeather()
  assert.equal(subscribed, 1)
  assert.equal(toasts.at(-1), '已取消订阅')
  state = 'ban'
  await profile.onSubscribeWeather()
  assert.equal(toasts.at(-1), '请在设置中开启订阅消息')
  assert.equal(profile.data.subscribingWeather, false)
})

test('天气提醒授权状态读取：免询问与已拒绝', () => {
  const profile = loadPage('profile', {}, {
    getSetting({ success }) {
      success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { [WEATHER_TEMPLATE_ID]: 'accept' } } })
    }
  })
  profile.refreshWeatherState()
  assert.equal(profile.data.weatherStateText, '已开启免询问，点击增加一次提醒额度')
  const rejected = loadPage('profile', {}, {
    getSetting({ success }) {
      success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { [WEATHER_TEMPLATE_ID]: 'reject' } } })
    }
  })
  rejected.refreshWeatherState()
  assert.equal(rejected.data.weatherStateText, '已拒绝提醒，点击重新订阅')
})

test('城市设置：确认后调用云端并回显，失败提示原因', async () => {
  const toasts = []
  let called = ''
  const profile = loadPage('profile', {
    setCity: async name => { called = name; return { success: true, cityId: '101020100', cityName: '上海' } }
  }, {
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
    showModal: options => options.success({ confirm: true, content: '火星' }),
    showToast: options => toasts.push(options.title)
  })
  failing.onCityTap()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(toasts.at(-1), '未找到该城市，请检查名称')
})
