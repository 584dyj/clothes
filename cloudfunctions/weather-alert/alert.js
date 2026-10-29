// 明日天气与穿搭提醒：有授权额度时每日发送一条，特殊天气调整建议重点。
// 额度、幂等与失败恢复沿用 monthly-report 的 subscriptions 模式，
// scene 完全独立。本文件不 require wx-server-sdk，db/cloud/天气请求均由入口或测试注入。
const crypto = require('crypto')
const https = require('https')
const { buildRecommendation, replaceItem, RULE_VERSION } = require('./outfit')

const PAGE_SIZE = 100
const SCENE = 'weather-alert'
const QUOTA_SCENE = 'weather-alert-quota'
const SENT_SCENE = 'weather-alert-sent'
const TEXT_LIMIT = 20
const TEMP_DROP = 6            // 降温阈值（°C，最低温）
const TEMP_RISE = 6            // 升温阈值（°C，最高温）
const TEMP_HOT = 35            // 高温阈值（°C，最高温）

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const quotaId = openid => 'quota-weather-alert-' + sha256(openid)
// 账号+日期的持久幂等标记：同日重跑、触发器重试或并发执行都只发送一次
const sentId = (openid, day) => `wsent-${openid}-${day}`
// 每日推荐落库位置：复用 ai_cache 集合（keyed 文档存储），按 openid+日期取确定性 ID，幂等覆盖。
const recommendationId = (openid, date) => 'weather-reco-' + crypto.createHash('sha256').update(openid + ':' + date).digest('hex')

// ---------- 时间与文本（与 monthly-report 同款，云函数保持自包含） ----------
function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour12: false, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
}

function shanghaiDate(date) {
  const value = shanghaiParts(date)
  return `${value.year}-${value.month}-${value.day}`
}

function shiftDate(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// date.DATA 要求中文日期格式，如「2026年10月13日」
function dateCn(dateStr) {
  const [year, month, day] = dateStr.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

function trimText(value, limit = TEXT_LIMIT) {
  return Array.from(String(value || '')).slice(0, limit).join('')
}

// 名称摘要：「甲、乙、丙等N件」，整体（含前缀）不超过 limit 字符
function summarize(names, limit = TEXT_LIMIT) {
  const total = names.length
  if (!total) return ''
  let take = Math.min(3, total)
  const suffix = () => total > take ? `等${total}件` : ''
  const build = () => names.slice(0, take).join('、') + suffix()
  while (take > 1 && Array.from(build()).length > limit) take--
  const tail = suffix()
  return trimText(names.slice(0, take).join('、'), limit - Array.from(tail).length) + tail
}

async function listAll(db, collection, where) {
  const result = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await db.collection(collection).where(where).skip(offset).limit(PAGE_SIZE).get()
    result.push(...res.data)
    if (res.data.length < PAGE_SIZE) return result
  }
}

async function readDoc(ref) {
  try {
    const res = await ref.get()
    return Array.isArray(res.data)
      ? res.data[0] || null
      : res.data || null
  } catch (error) {
    const message = String(
      error.errMsg || error.message || ''
    )
    // 兼容微信云数据库文档不存在的错误
    if (
      /does not exist|not found|not exist|文档不存在/i.test(message)
    ) {
      return null
    }
    // 其他错误继续抛出
    throw error
  }
}

// ---------- 天气接口（高德 Web 服务） ----------
function requestWeather({ host, path }) {
  return new Promise((resolve, reject) => {
    const req = https.request(host.replace(/\/+$/, '') + path, { method: 'GET' }, res => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { out += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(out)) } catch (e) { reject(new Error('天气接口响应无效')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('天气接口请求超时')))
    req.end()
  })
}

// 高德 casts 项 → 内部归一形状：夜间温度作最低、白天温度作最高，天气现象合并昼夜
function castToDay(cast) {
  const day = String(cast.dayweather || '')
  const night = String(cast.nightweather || '')
  return {
    tempMin: cast.nighttemp,
    tempMax: cast.daytemp,
    textDay: night && night !== day ? `${day}转${night}` : day
  }
}

// 返回 { today, tomorrow }，各自 { tempMin, tempMax, textDay }
async function fetchForecast({ request, host, key, cityId }) {
  const res = await request({ host, path: `/v3/weather/weatherInfo?city=${encodeURIComponent(cityId)}&key=${encodeURIComponent(key)}&extensions=all&output=JSON` })
  const casts = res.status === '1' && res.forecasts && res.forecasts[0] && res.forecasts[0].casts
  if (!Array.isArray(casts) || casts.length < 2) throw new Error('天气预报数据无效')
  const forecast = { today: castToDay(casts[0]), tomorrow: castToDay(casts[1]) }
  for (const day of [forecast.today, forecast.tomorrow]) {
    if (!day.textDay.trim() || [day.tempMin, day.tempMax].some(value =>
      value == null || !String(value).trim() || !Number.isFinite(Number(value)))) {
      throw new Error('天气预报数据无效')
    }
  }
  return forecast
}

// 特殊天气只决定提示重点，普通天气仍提供明日穿搭建议。
const isWet = text => /[雨雪雷]/.test(text || '')

function evaluate(today, tomorrow) {
  const tMin1 = Number(today.tempMin), tMin2 = Number(tomorrow.tempMin)
  const tMax1 = Number(today.tempMax), tMax2 = Number(tomorrow.tempMax)
  if (![tMin1, tMin2, tMax1, tMax2].every(Number.isFinite)) return null
  if (tMin2 <= tMin1 - TEMP_DROP) return { type: 'drop', delta: tMin1 - tMin2 }
  if (isWet(tomorrow.textDay) && !isWet(today.textDay)) return { type: 'rain' }
  if (tMax2 >= TEMP_HOT && tMax1 < TEMP_HOT) return { type: 'hot', temp: tMax2 }
  if (tMax2 >= tMax1 + TEMP_RISE) return { type: 'rise', delta: tMax2 - tMax1 }
  return null
}

// ---------- 推荐上下文：日期逐条读历史，不引入新集合或复合查询索引 ----------
async function recommendationContext(db, openid, date) {
  const [items, wearRecords, previous] = await Promise.all([
    listAll(db, 'clothes', { _openid: openid }),
    listAll(db, 'wear_records', { _openid: openid, date: db.command.gte(shiftDate(date, -7)) }),
    Promise.all(Array.from({ length: 7 }, async (_, index) => {
      const id = recommendationId(openid, shiftDate(date, -index - 1))
      const daily = await readDoc(db.collection('ai_cache').doc(id + '-daily'))
      return daily && daily._openid === openid && daily.status === 'daily'
        ? daily : readDoc(db.collection('ai_cache').doc(id))
    }))
  ])
  const history = []
  for (const row of previous) {
    if (!row || row._openid !== openid) continue
    // 站内已生成方案和成功推送参与轮换；预览及失败文档不参与。
    if (!['sent', 'daily'].includes(row.status) && (row.status || !await readDoc(db.collection('subscriptions').doc(sentId(openid, shiftDate(row.date, -1)))))) continue
    const bodyIds = (row.items || []).filter(item => ['短袖', '长袖', '衬衫', '毛衣', '长裙', '短裙', '长裤', '短裤', '连衣裙'].includes(item.category)).map(item => item._id)
    history.push({ ...row, bodyKey: row.bodyKey || bodyIds.sort().join('|') })
  }
  return { items, history, wearRecords }
}

function buildAdvice(weather, items, options) {
  return buildRecommendation(weather, items, options).advice
}

// ---------- 额度认领 / 恢复（与 monthly-report 同构，scene 独立） ----------
async function claim(db, id, now) {
  const day = shanghaiDate(now)
  return db.runTransaction(async tx => {
    const ref = tx.collection('subscriptions').doc(id)
    const row = await readDoc(ref)
    if (!row || row.consumedAt) return false
    const markerRef = tx.collection('subscriptions').doc(sentId(row._openid, day))
    if (await readDoc(markerRef)) return false
    const quotaRef = tx.collection('subscriptions').doc(quotaId(row._openid))
    const quota = await readDoc(quotaRef)
    if (!quota || quota.scene !== QUOTA_SCENE || !Number.isInteger(quota.unused) || quota.unused <= 0) return false
    if ((row.generation || 0) !== (quota.generation || 0)) return false
    await ref.update({ data: { consumedAt: now } })
    await markerRef.set({ data: { _openid: row._openid, scene: SENT_SCENE, day, createdAt: now } })
    await quotaRef.update({ data: { unused: quota.unused - 1, updatedAt: now } })
    return true
  })
}

async function restoreClaim(db, id, now) {
  const day = shanghaiDate(now)
  return db.runTransaction(async tx => {
    const ref = tx.collection('subscriptions').doc(id)
    const row = await readDoc(ref)
    if (!row || !row.consumedAt) return
    const quotaRef = tx.collection('subscriptions').doc(quotaId(row._openid))
    const quota = await readDoc(quotaRef)
    await ref.update({ data: { consumedAt: db.command.remove() } })
    // 删除当日幂等标记，同日重跑可再次尝试发送
    await tx.collection('subscriptions').doc(sentId(row._openid, day)).remove()
    if (quota && quota.scene === QUOTA_SCENE && (row.generation || 0) === (quota.generation || 0)) {
      const unused = Number.isInteger(quota.unused) ? quota.unused : 0
      // 发送在途时可能又接受了订阅，恢复须保留所有已获授权。
      await quotaRef.update({ data: { unused: unused + 1, updatedAt: now } })
    }
  })
}

function errorCode(error) {
  const message = String(error && (error.message || error.errMsg) || '')
  if (message.includes('43101')) return 43101
  return Number(error && (error.errCode || error.errcode || error.code))
}

// 发送前准备页面数据，成功后标记 sent；预览另存，避免覆盖已送达的推荐。
async function saveRecommendation(db, openid, date, recommendation, preview = false) {
  await db.collection('ai_cache').doc(recommendationId(openid, date) + (preview ? '-preview' : '')).set({
    data: { _openid: openid, date, ...recommendation, createdAt: new Date() }
  })
}

async function sendAlert({ db, cloud, subscription, trigger, forecast, tomorrow, templateId, now }) {
  const openid = subscription._openid
  const { items, ...context } = await recommendationContext(db, openid, tomorrow)
  const recommendation = buildRecommendation(forecast.tomorrow, items, { ...context, trigger, date: tomorrow, openid })
  if (!await claim(db, subscription._id, now)) return 'claimed'
  try {
    await saveRecommendation(db, openid, tomorrow, { trigger, weather: forecast.tomorrow, ...recommendation, status: 'prepared' })
    const result = await cloud.openapi.subscribeMessage.send({
      touser: subscription._openid,
      templateId,
      page: `pages/weather-outfit/weather-outfit?date=${tomorrow}`,
      data: {
        thing12: { value: trimText(forecast.tomorrow.textDay) },
        character_string41: { value: `${forecast.tomorrow.tempMin}~${forecast.tomorrow.tempMax}℃` },
        thing2: { value: recommendation.advice },
        date4: { value: dateCn(tomorrow) }
      }
    })
    if (result && Number(result.errCode || result.errcode || 0)) {
      const error = new Error(result.errMsg || result.errmsg || '订阅消息发送失败')
      error.errCode = result.errCode || result.errcode
      throw error
    }
  } catch (error) {
    if (errorCode(error) === 43101) {
      await db.collection('subscriptions').doc(subscription._id).remove()
      return 'expired'
    }
    await restoreClaim(db, subscription._id, now)
    throw error
  }
  // 已送达后，历史标记失败也不能恢复额度或触发重复推送。
  try {
    await db.collection('ai_cache').doc(recommendationId(openid, tomorrow)).update({ data: { status: 'sent', sentAt: now } })
  } catch (error) {
    console.error('天气推荐已发送，历史标记失败', openid, error)
  }
  return 'sent'
}

// ---------- 定时扫描主流程 ----------
async function handle({ db, cloud, templateId, now = new Date(), request = requestWeather, env = process.env }) {
  if (!templateId) throw new Error('WEATHER_TMPL_ID 未配置')
  const key = env.WEATHER_API_KEY
  if (!key) throw new Error('WEATHER_API_KEY 未配置')
  const host = env.WEATHER_API_HOST || 'https://restapi.amap.com'
  // skipped 的细分原因：noCity 未设城市；weatherFailed 天气接口失败；claimSkipped 当日已发送或额度不可用
  const summary = { success: true, scanned: 0, sent: 0, skipped: 0, expired: 0, failed: 0,
    noCity: 0, weatherFailed: 0, claimSkipped: 0 }

  // 1. 收集候选授权记录（同账号一次运行只处理一条）
  const candidates = []
  const seen = new Set()
  const quotas = new Map()
  let cursor = ''
  for (;;) {
    const where = cursor ? { _id: db.command.gt(cursor) } : {}
    const res = await db.collection('subscriptions').where(where).orderBy('_id', 'asc').limit(PAGE_SIZE).get()
    for (const subscription of res.data) {
      if (subscription.scene !== SCENE) continue
      summary.scanned++
      if (subscription.consumedAt || !subscription._openid || seen.has(subscription._openid)) continue
      try {
        if (!quotas.has(subscription._openid)) {
          quotas.set(subscription._openid, await readDoc(db.collection('subscriptions').doc(quotaId(subscription._openid))))
        }
        const quota = quotas.get(subscription._openid)
        if ((subscription.generation || 0) !== (quota && quota.generation || 0)) continue
        seen.add(subscription._openid)
        candidates.push(subscription)
      } catch (error) {
        seen.add(subscription._openid)
        summary.failed++
        console.error('天气提醒额度读取失败', subscription._openid, error)
      }
    }
    if (res.data.length < PAGE_SIZE) break
    cursor = res.data[res.data.length - 1]._id
  }
  if (!candidates.length) return summary

  // 2. 批量读账号，过滤未设置城市的
  const users = new Map()
  for (let offset = 0; offset < candidates.length; offset += 20) {
    const openids = candidates.slice(offset, offset + 20).map(subscription => subscription._openid)
    const res = await db.collection('users').where({ openid: db.command.in(openids) }).limit(20).get()
    for (const user of res.data) users.set(user.openid, user)
  }
  const ready = candidates.filter(subscription => {
    const user = users.get(subscription._openid)
    return user && user.cityId
  })
  summary.noCity += candidates.length - ready.length
  summary.skipped += candidates.length - ready.length

  // 3. 每城市取一次预报，有额度的账号每天发送一条，特殊天气调整文案。
  const forecasts = new Map()
  const failedCities = new Set()
  const tomorrow = shiftDate(shanghaiDate(now), 1)
  for (const subscription of ready) {
    const cityId = users.get(subscription._openid).cityId
    if (failedCities.has(cityId)) { summary.skipped++; summary.weatherFailed++; continue }
    if (!forecasts.has(cityId)) {
      try {
        forecasts.set(cityId, await fetchForecast({ request, host, key, cityId }))
      } catch (error) {
        failedCities.add(cityId)
        console.error('天气接口调用失败', cityId, error)
        summary.skipped++
        summary.weatherFailed++
        continue
      }
    }
    const forecast = forecasts.get(cityId)
    const trigger = evaluate(forecast.today, forecast.tomorrow) || { type: 'normal', ...forecast.tomorrow }
    try {
      const state = await sendAlert({ db, cloud, subscription, trigger, forecast, tomorrow, templateId, now })
      if (state === 'sent') summary.sent++
      else if (state === 'expired') summary.expired++
      else { summary.skipped++; summary.claimSkipped++ }
    } catch (error) {
      summary.failed++
      console.error('天气提醒发送失败', subscription._openid, error)
    }
  }
  return summary
}

// 城市设置的共用账号校验：登录态有效且 openid 绑定唯一
async function activeCityUser(db, openid) {
  const res = await db.collection('users').where({ openid }).limit(2).get()
  if (res.data.length > 1) {
    console.error('检测到重复 OpenID 绑定', openid)
    throw new Error('账号绑定数据异常，请联系管理员')
  }
  const user = res.data[0]
  if (!user || user.autoLoginEnabled === false) throw new Error('登录状态已失效')
  return user
}

// ---------- 设置城市（客户端调用入口）：高德地理编码把城市名解析为 adcode ----------
async function setCity({ db, openid, name, request = requestWeather, env = process.env }) {
  const key = env.WEATHER_API_KEY
  if (!key) throw new Error('WEATHER_API_KEY 未配置')
  const host = env.WEATHER_API_HOST || 'https://restapi.amap.com'
  const cityName = String(name || '').trim()
  if (!cityName || Array.from(cityName).length > 20) throw new Error('请输入城市名')
  const user = await activeCityUser(db, openid)
  const geo = await request({ host, path: `/v3/geocode/geo?address=${encodeURIComponent(cityName)}&key=${encodeURIComponent(key)}&output=JSON` })
  const top = geo.status === '1' && Array.isArray(geo.geocodes) && geo.geocodes[0]
  if (!top || !top.adcode) throw new Error('未找到该城市，请检查名称')
  const display = trimText(top.formatted_address || cityName)
  await db.collection('users').doc(user._id).update({ data: { cityId: String(top.adcode), cityName: display } })
  return { success: true, cityId: String(top.adcode), cityName: display }
}

// ---------- 定位设置城市：高德逆地理编码把经纬度解析为区县 adcode ----------
// 高德 regeo 空字段返回 [] 而非空字符串，统一归一为字符串
const geoText = value => Array.isArray(value) ? '' : String(value || '')

async function setCityByLocation({ db, openid, longitude, latitude, request = requestWeather, env = process.env }) {
  const key = env.WEATHER_API_KEY
  if (!key) throw new Error('WEATHER_API_KEY 未配置')
  const host = env.WEATHER_API_HOST || 'https://restapi.amap.com'
  const lng = Number(longitude)
  const lat = Number(latitude)
  if (!Number.isFinite(lng) || lng < -180 || lng > 180 ||
      !Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('定位坐标无效')
  const user = await activeCityUser(db, openid)
  const geo = await request({ host, path: `/v3/geocode/regeo?location=${lng},${lat}&key=${encodeURIComponent(key)}&output=JSON&extensions=base&radius=1000` })
  const ac = geo.status === '1' && geo.regeocode && geo.regeocode.addressComponent
  const adcode = ac && geoText(ac.adcode)
  if (!adcode) throw new Error('未找到该位置，请手动输入城市')
  // 直辖市的 city 字段为空，回退用省名；区县的 adcode 即天气接口所需精度
  const display = trimText((geoText(ac.city) || geoText(ac.province)) + geoText(ac.district) || geoText(geo.regeocode.formatted_address))
  if (!display) throw new Error('未找到该位置，请手动输入城市')
  await db.collection('users').doc(user._id).update({ data: { cityId: adcode, cityName: display } })
  return { success: true, cityId: adcode, cityName: display }
}

// ---------- 预览推荐（客户端测试入口）：按当前登录用户生成并落库一份推荐 ----------
// 只写 ai_cache、不查额度/幂等、不真正发消息，专供落地页联调。
// 日期仅允许明天，避免把同一份预报错误保存到其他日期。
async function previewRecommendation({ db, openid, now = new Date(), request = requestWeather, env = process.env, date }) {
  const tomorrow = shiftDate(shanghaiDate(now), 1)
  if (date && date !== tomorrow) throw new Error('只能预览明日穿搭')
  const key = env.WEATHER_API_KEY
  if (!key) throw new Error('WEATHER_API_KEY 未配置')
  const host = env.WEATHER_API_HOST || 'https://restapi.amap.com'
  const user = await activeCityUser(db, openid)
  if (!user.cityId) throw new Error('请先在「我的」页设置城市')
  const forecast = await fetchForecast({ request, host, key, cityId: user.cityId })
  const trigger = evaluate(forecast.today, forecast.tomorrow) || { type: 'normal', ...forecast.tomorrow }
  const { items, ...context } = await recommendationContext(db, openid, tomorrow)
  const recommendation = buildRecommendation(forecast.tomorrow, items, { ...context, trigger, date: tomorrow, openid })
  await saveRecommendation(db, openid, tomorrow, { trigger, weather: forecast.tomorrow, ...recommendation, status: 'preview' }, true)
  return { success: true, date: tomorrow, advice: recommendation.advice, weather: forecast.tomorrow,
    reason: recommendation.reason, missing: recommendation.missing, itemIds: recommendation.itemIds, count: recommendation.items.length }
}

// 站内日常推荐独立保存，调整不会覆盖订阅消息或调试预览。
async function dailyRecommendation({ db, openid, operation = 'get', date, revision, replaceId,
  now = new Date(), request = requestWeather, env = process.env }) {
  if (!['get', 'change', 'replace'].includes(operation)) throw new Error('推荐操作无效')
  const tomorrow = shiftDate(shanghaiDate(now), 1)
  if ((date && date !== tomorrow) || (operation !== 'get' && date !== tomorrow)) throw new Error('日期已变化，请刷新明日推荐')
  if (operation !== 'get' && (!Number.isInteger(revision) || revision < 1)) throw new Error('推荐版本无效，请刷新')
  if (operation === 'replace' && (typeof replaceId !== 'string' || !replaceId || replaceId.length > 100)) throw new Error('衣物无效')
  const user = await activeCityUser(db, openid)
  if (!user.cityId) throw new Error('请先在「我的」页设置城市')
  if (!env.WEATHER_API_KEY) throw new Error('天气服务尚未配置，请稍后重试')
  const [forecast, context] = await Promise.all([
    fetchForecast({ request, host: env.WEATHER_API_HOST || 'https://restapi.amap.com', key: env.WEATHER_API_KEY, cityId: user.cityId }),
    recommendationContext(db, openid, tomorrow)
  ])
  const weather = forecast.tomorrow
  const options = { ...context, date: tomorrow, openid, trigger: evaluate(forecast.today, weather) || {} }
  const signature = JSON.stringify([RULE_VERSION, user.cityId, weather])
  const inventoryHash = sha256(JSON.stringify(context.items.slice().sort((a, b) => a._id.localeCompare(b._id))))
  return db.runTransaction(async tx => {
    const active = await readDoc(tx.collection('users').doc(user._id))
    if (!active || active.openid !== openid || active.autoLoginEnabled === false) throw new Error('登录状态已失效')
    if (active.cityId !== user.cityId) throw new Error('城市已变化，请刷新')
    const ref = tx.collection('ai_cache').doc(recommendationId(openid, tomorrow) + '-daily')
    const current = await readDoc(ref)
    if (current && current._openid !== openid) throw new Error('无权访问推荐')
    if (operation !== 'get' && (!current || current.revision !== revision)) throw new Error('推荐已更新，请刷新后再调整')
    const valid = current && current.signature === signature && current.inventoryHash === inventoryHash
    if (valid && operation === 'get') return { success: true, recommendation: current, message: '' }
    let next, message = '', seenBodyKeys = valid ? current.seenBodyKeys : []
    if (!valid) {
      next = buildRecommendation(weather, context.items, options)
      if (current) message = '推荐规则、天气或衣橱已更新，已重新匹配搭配'
    } else if (operation === 'change') {
      // ponytail: 每日最多记住 100 组已看主体，避免缓存随连点无限增长。
      next = current.bodyKey && seenBodyKeys.length < 100
        ? buildRecommendation(weather, context.items, { ...options, excludeBodyKeys: seenBodyKeys }) : null
      if (!next) message = current.bodyKey ? '当前可换的适温主体已看过，已保留这套；也可替换单件' : '当前缺少完整主体，请先补齐适温衣物'
    } else {
      next = replaceItem(weather, context.items, current, replaceId, options)
      if (!next) message = '暂无同位置的适温替代衣物，已保留当前搭配'
    }
    if (!next) return { success: true, recommendation: current, message }
    seenBodyKeys = [...new Set([...seenBodyKeys, next.bodyKey].filter(Boolean))].slice(-100)
    const recommendation = { ...next, _openid: openid, date: tomorrow, weather, cityName: user.cityName || '',
      status: 'daily', signature, inventoryHash, seenBodyKeys,
      revision: (current?.revision || 0) + 1, updatedAt: now }
    await ref.set({ data: recommendation })
    return { success: true, recommendation, message }
  })
}

module.exports = { handle, setCity, setCityByLocation, previewRecommendation, dailyRecommendation, evaluate, buildAdvice, buildRecommendation, fetchForecast, quotaId, sentId, recommendationId,
  SCENE, QUOTA_SCENE, SENT_SCENE, shanghaiDate, shiftDate, dateCn, summarize }
