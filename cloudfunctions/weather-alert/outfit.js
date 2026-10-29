const crypto = require('crypto')
const RULE_VERSION = 2

// 独立云函数自包含；基础角色与 auth/categories.js 保持一致，保暖衣只作内搭。
const ROLES = {
  短袖: 'top', 长袖: 'top', 衬衫: 'top', 毛衣: 'top', 保暖衣: 'inner',
  外套: 'outer', 羽绒服: 'outer', 长裙: 'bottom', 短裙: 'bottom',
  马甲: 'layer',
  长裤: 'bottom', 短裤: 'bottom', 连衣裙: 'dress', 鞋: 'shoes',
  配饰: 'extra', 包袋: 'extra'
}
const bodyKey = items => items.map(item => item._id).sort().join('|')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const daysBetween = (date, previous) => (Date.parse(date) - Date.parse(previous)) / 86400000
const neutral = color => /^(白色?|黑色?|灰色?|米色?|卡其|棕色?|驼色?|藏青|藏蓝)$/.test(color || '')

// ponytail: 温度是初始经验阈值，集中在此校准；缺少厚薄属性时只使用明确类别及季节。
function temperatureRank(item, weather) {
  const high = Number(weather.tempMax)
  const role = ROLES[item.category]
  if (!role) return null
  if (item.subcategory === '围巾' && high > 12) return null
  if (role === 'shoes' || role === 'extra') return 0
  if (item.category === '羽绒服') return high <= 12 ? 0 : null
  if (role === 'inner') return high < 13 ? 0 : null
  if (high < 18 && ['短袖', '短裤', '短裙'].includes(item.category)) return null
  const seasons = (Array.isArray(item.seasons) ? item.seasons : []).map(value => ['春', '秋'].includes(value) ? '春秋' : value)
  const allowed = role === 'outer'
    ? (high <= 12 ? ['冬', '春秋'] : ['春秋'])
    : high >= 28 ? ['夏'] : high >= 23 ? ['夏', '春秋'] : high >= 18 ? ['春秋', '夏']
      : high >= 13 ? ['春秋', '冬'] : high >= 8 ? ['冬', '春秋'] : ['冬']
  if (high >= 23 && item.category === '毛衣') return null
  const rank = allowed.findIndex(season => seasons.includes(season))
  return rank < 0 ? null : rank
}

function itemSnapshot(item) {
  return { _id: item._id, name: String(item.name || '未命名'), category: item.category,
    subcategory: item.category === '配饰' ? String(item.subcategory || '') : '', imageFileID: String(item.imageFileID || '') }
}

function buildRecommendation(weather, items, { date = '', openid = '', trigger = {}, history = [], wearRecords = [], excludeBodyKeys = [] } = {}) {
  const low = Number(weather.tempMin), high = Number(weather.tempMax)
  if (![low, high].every(Number.isFinite)) throw new Error('天气温度无效')
  const recent = history.filter(row => daysBetween(date, row.date) >= 1 && daysBetween(date, row.date) <= 7)
  const wears = wearRecords.filter(row => daysBetween(date, row.date) >= 1 && daysBetween(date, row.date) <= 7)
  const groups = {}
  for (const item of items) {
    if (!item._id) continue
    const rank = temperatureRank(item, weather)
    if (rank === null) continue
    const role = ROLES[item.category]
    ;(groups[role] ||= []).push({ ...item, temperatureRank: rank })
  }
  const itemPenalty = item => {
    const strong = ['top', 'dress'].includes(ROLES[item.category])
    return recent.filter(row => daysBetween(date, row.date) <= 3 && (row.itemIds || []).includes(item._id)).length * (strong ? 2 : 1) +
      wears.filter(row => daysBetween(date, row.date) <= (strong ? 2 : 1) && (row.itemIds || []).includes(item._id)).length * (strong ? 4 : 1)
  }
  const colorPenalty = outfit => {
    const colors = outfit.map(item => item.color).filter(Boolean)
    return Math.max(0, new Set(colors.filter(color => !neutral(color))).size - 1)
  }
  const compare = (a, b) => {
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
    }
    return 0
  }
  let body = [], bestScore
  function consider(candidate) {
    const key = bodyKey(candidate)
    if (excludeBodyKeys.includes(key)) return
    const used = recent.filter(row => row.bodyKey === key)
    const age = used.length ? Math.min(...used.map(row => daysBetween(date, row.date))) : 8
    // 温度硬限制已在入池前执行，合格组合之间先轮换，再比较季节偏好。
    const score = [used.some(row => daysBetween(date, row.date) === 1) ? 1 : 0, age <= 7 ? 1 : 0, -age,
      candidate.reduce((sum, item) => sum + itemPenalty(item), 0),
      Math.max(...candidate.map(item => item.temperatureRank)), colorPenalty(candidate),
      hash(`${openid}:${date}:${key}`)]
    if (!bestScore || compare(score, bestScore) < 0) { body = candidate; bestScore = score }
  }
  // ponytail: 流式比较上装×下装，不保存组合列表；超大衣橱再按温度和历史缩小候选池。
  for (const top of groups.top || []) for (const bottom of groups.bottom || []) consider([top, bottom])
  for (const dress of groups.dress || []) consider([dress])
  // 完整候选都看过后保留当前方案，不能退化成缺上装或下装的组合。
  if (!body.length && ((groups.top?.length && groups.bottom?.length) || groups.dress?.length)) return null
  const completeBody = body.length > 0
  if (!completeBody) {
    const partial = groups.top?.length ? groups.top : groups.bottom || []
    for (const item of partial) consider([item])
  }
  const picked = body.slice()
  const choose = role => {
    let best, score
    for (const item of groups[role] || []) {
      const next = [item.temperatureRank, itemPenalty(item), colorPenalty([...body, item]), hash(`${openid}:${date}:${item._id}`)]
      if (!score || compare(next, score) < 0) { best = item; score = next }
    }
    if (best) picked.push(best)
    return best
  }
  const missing = []
  if (!completeBody) missing.push(body.length ? (ROLES[body[0].category] === 'top' ? '下装' : '上装') : '上装与下装或连衣裙')
  if (!choose('shoes')) missing.push('鞋')
  const needsOuter = high < 18 || (high < 23 ? low < 15 : low < 18)
  if (needsOuter && !choose('outer')) missing.push(high <= 12 ? '保暖外套' : '春秋外套')
  if (body.length && high < 8) choose('inner')
  // 包袋及点缀只在主体齐全时补一件，围巾随冷天使用；不声称鞋具有防水性能。
  if (completeBody) {
    // 马甲沿用主体的季节匹配，不设专属温度阈值，也不抵扣上衣或外套需求。
    choose('layer')
    if (groups.extra) groups.extra = groups.extra.filter(item => item.subcategory !== '围巾' || high <= 12)
    choose('extra')
  }
  const key = completeBody ? bodyKey(body) : ''
  const repeated = !!key && recent.some(row => row.bodyKey === key)
  const wet = /[雨雪雷]/.test(weather.textDay || '')
  let advice = wet ? '明日有雨，出门记得带伞' : high >= 28 ? '明日偏热，穿轻薄衣物' : high < 13 ? '明日偏冷，注意保暖' : '明日穿搭已备好'
  if (!picked.length) advice = '暂无适温衣物，请自行搭配'
  else if (trigger.type === 'drop' && !wet) advice = `降温${trigger.delta}度，按明日温度搭配`
  const reasons = [`明日${low}～${high}℃，${high >= 28 ? '选择夏季轻薄衣物' : high < 13 ? '优先保暖搭配' : '按日间温度选择主体衣物'}`]
  if (needsOuter) reasons.push(high >= 18 ? '外套供早晚增减' : '搭配外套保暖')
  if (picked.some(item => ROLES[item.category] === 'layer')) reasons.push('马甲用于叠穿，不能替代内层衣物或保暖外套')
  if (high - low >= 10) reasons.push('昼夜温差较大，白天和早晚分层穿着')
  if (wet) reasons.push('出门带伞，鞋子请自行确认防滑与防水性能')
  if (completeBody) reasons.push(repeated ? '当前适温组合较少，沿用近期组合' : '这组主体近7天未推荐')
  if (missing.length) reasons.push(`当前缺少适合的${missing.join('、')}，请自行补齐`)
  return { advice: Array.from(advice).slice(0, 20).join(''), reason: reasons.join('；') + '。', missing,
    bodyKey: key, repeated, itemIds: picked.map(item => item._id), items: picked.map(itemSnapshot) }
}

function replaceItem(weather, items, current, replaceId, options) {
  const target = current.items.find(item => item._id === replaceId)
  if (!target) throw new Error('要替换的衣物已变化，请刷新')
  const role = ROLES[target.category]
  const retained = current.itemIds.filter(id => id !== replaceId)
  const candidates = items.filter(item => retained.includes(item._id) ||
    (item._id !== replaceId && ROLES[item.category] === role && temperatureRank(item, weather) !== null))
  if (!candidates.some(item => !retained.includes(item._id))) return null
  const result = buildRecommendation(weather, candidates, options)
  return result && result.itemIds.length === current.itemIds.length && retained.every(id => result.itemIds.includes(id))
    ? result : null
}

module.exports = { buildRecommendation, replaceItem, temperatureRank, ROLES, RULE_VERSION }
