// 明日天气与穿搭提醒：有授权额度时每日发送一条，特殊天气调整建议重点。
// 额度、幂等与失败恢复沿用 monthly-report 的 subscriptions 模式，
// scene 完全独立。本文件不 require wx-server-sdk，db/cloud/天气请求均由入口或测试注入。
const crypto = require('crypto')
const https = require('https')

const PAGE_SIZE = 100
const SCENE = 'weather-alert'
const QUOTA_SCENE = 'weather-alert-quota'
const SENT_SCENE = 'weather-alert-sent'
const TEXT_LIMIT = 20
const TEMP_DROP = 6            // 降温阈值（°C，最低温）
const TEMP_RISE = 6            // 升温阈值（°C，最高温）
const TEMP_HOT = 35            // 高温阈值（°C，最高温）
const TEMP_COOL = 10           // 基础建议经验值：偏冷时优先冬季衣物
const TEMP_WARM = 28           // 基础建议经验值：偏热时优先夏季衣物

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const quotaId = openid => 'quota-weather-alert-' + sha256(openid)
// 账号+日期的持久幂等标记：同日重跑、触发器重试或并发执行都只发送一次
const sentId = (openid, day) => `wsent-${openid}-${day}`

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
const seasonFor = day => Number(day.tempMin) <= TEMP_COOL ? '冬' : Number(day.tempMax) >= TEMP_WARM ? '夏' : '春秋'

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

// ---------- 内容生成（规则直出，不调用模型） ----------
const RULES = {
  drop: {
    prefix: trigger => `降温${trigger.delta}度：`,
    empty: trigger => `降温${trigger.delta}度，注意添衣`,
    pick: items => items.filter(item => (item.seasons || []).includes('冬'))
  },
  rain: {
    prefix: () => '有雨带伞，鞋选：',
    empty: () => '明天有雨，记得带伞',
    pick: items => items.filter(item => item.category === '鞋')
  },
  hot: {
    prefix: trigger => `高温${trigger.temp}度：`,
    empty: trigger => `高温${trigger.temp}度，注意防暑`,
    pick: items => items.filter(item => (item.seasons || []).includes('夏'))
  },
  rise: {
    prefix: trigger => `升温${trigger.delta}度：`,
    empty: trigger => `升温${trigger.delta}度，可以轻薄些`,
    pick: items => items.filter(item => (item.seasons || []).includes('春秋'))
  },
  normal: {
    prefix: trigger => isWet(trigger.textDay) ? '有雨带伞，可穿：' : '明日可穿：',
    empty: trigger => {
      if (isWet(trigger.textDay)) return '明日有雨，带伞穿防水鞋'
      const season = seasonFor(trigger)
      if (season === '冬') return '明日偏冷，注意保暖'
      if (season === '夏') return '明日偏热，穿轻薄衣物'
      return '长袖搭配，备件薄外套'
    },
    pick: (items, trigger) => items.filter(item => (item.seasons || []).includes(seasonFor(trigger)))
  }
}

function buildAdvice(trigger, items) {
  const rule = RULES[trigger.type]
  const names = rule.pick(items, trigger).map(item => trimText(item.name || '未命名', 10))
  if (!names.length) return rule.empty(trigger)
  const prefix = rule.prefix(trigger)
  return prefix + summarize(names, TEXT_LIMIT - Array.from(prefix).length)
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

async function sendAlert({ db, cloud, subscription, trigger, forecast, tomorrow, templateId, now }) {
  // 一级「其他」仅作基础记录，不进入天气穿搭候选；本函数独立部署，使用本地最小过滤，不引用 auth。
  // 配饰子类「其他」仍属配饰，不受一级排除影响；只剩其他时按既有空候选规则发送通用提示。
  const items = (await listAll(db, 'clothes', { _openid: subscription._openid })).filter(item => item.category !== '其他')
  if (!await claim(db, subscription._id, now)) return 'claimed'
  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: subscription._openid,
      templateId,
      page: 'pages/wardrobe/wardrobe',
      data: {
        thing12: { value: trimText(forecast.tomorrow.textDay) },
        character_string41: { value: `${forecast.tomorrow.tempMin}~${forecast.tomorrow.tempMax}℃` },
        thing2: { value: buildAdvice(trigger, items) },
        date4: { value: dateCn(tomorrow) }
      }
    })
    if (result && Number(result.errCode || result.errcode || 0)) {
      const error = new Error(result.errMsg || result.errmsg || '订阅消息发送失败')
      error.errCode = result.errCode || result.errcode
      throw error
    }
    return 'sent'
  } catch (error) {
    if (errorCode(error) === 43101) {
      await db.collection('subscriptions').doc(subscription._id).remove()
      return 'expired'
    }
    await restoreClaim(db, subscription._id, now)
    throw error
  }
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

module.exports = { handle, setCity, setCityByLocation, evaluate, buildAdvice, fetchForecast, quotaId, sentId,
  SCENE, QUOTA_SCENE, SENT_SCENE, shanghaiDate, shiftDate, dateCn, summarize }
