const { loadItems, inventory, findGaps } = require('./recommend')
const { requestChat } = require('./ai-http')

const CATEGORIES = ['上衣', '下装', '连衣裙', '配饰', '挂件', '包', '鞋']
const SEASONS = ['春秋', '夏', '冬']
const OCCASIONS = ['日常', '通勤', '约会', '运动', '旅行', '正式']
const NEUTRAL_COLORS = new Set(['白色', '黑色', '灰色', '米色', '卡其', '棕色', '驼色', '藏青', '藏蓝'])
const COMPLEMENTS = {
  上衣: ['下装', '鞋'],
  下装: ['上衣', '鞋'],
  连衣裙: ['鞋'],
  鞋: ['上衣', '下装', '连衣裙']
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function validate(input = {}) {
  const candidate = {
    name: text(input.name, 60),
    category: text(input.category, 20),
    subcategory: text(input.subcategory, 30),
    color: text(input.color, 30),
    seasons: Array.isArray(input.seasons) ? [...new Set(input.seasons)].filter(value => SEASONS.includes(value)) : [],
    occasion: text(input.occasion, 20),
    note: text(input.note, 200),
    price: Number(input.price),
    monthlyBudget: input.monthlyBudget === '' || input.monthlyBudget === undefined ? null : Number(input.monthlyBudget)
  }
  if (!CATEGORIES.includes(candidate.category)) throw new Error('请选择有效分类')
  if (candidate.category === '配饰' && !candidate.subcategory) throw new Error('请选择配饰类型')
  if (!candidate.color) throw new Error('请填写颜色')
  if (!candidate.seasons.length) throw new Error('请至少选择一个季节')
  if (!Number.isFinite(candidate.price) || candidate.price <= 0 || candidate.price > 1000000) throw new Error('请输入有效价格')
  if (candidate.monthlyBudget !== null && (!Number.isFinite(candidate.monthlyBudget) || candidate.monthlyBudget <= 0 || candidate.monthlyBudget > 1000000000)) {
    throw new Error('请输入有效月预算')
  }
  if (candidate.occasion && !OCCASIONS.includes(candidate.occasion)) throw new Error('场合无效')
  return candidate
}

async function loadRecords(db, collection, openid) {
  const rows = []
  for (let offset = 0; offset < 500; offset += 20) {
    const res = await db.collection(collection).where({ _openid: openid }).skip(offset).limit(20).get()
    rows.push(...res.data)
    if (res.data.length < 20) break
  }
  return rows
}

function overlaps(left, right) {
  return left.some(value => right.includes(value))
}

function compatibleColor(left, right) {
  return left === right || NEUTRAL_COLORS.has(left) || NEUTRAL_COLORS.has(right)
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function dateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function modelPrompt(candidate, assessment) {
  return [
    '你是购买前评估助手。只能基于输入事实给建议，不得编造衣物、穿着次数或金额。',
    '规则引擎的 verdict、重复风险、缺口、搭配数量和开销是事实，必须保持一致。',
    '只输出 JSON：{"summary":"一句结论","advice":"两句以内的行动建议"}。',
    JSON.stringify({ candidate, facts: assessment })
  ].join('\n')
}

async function modelAdvice(candidate, assessment, request, env) {
  const key = env.PURCHASE_AI_KEY || env.DASHSCOPE_API_KEY
  if (!key) return null
  const base = env.PURCHASE_AI_BASE || env.DASHSCOPE_API_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const model = env.PURCHASE_AI_MODEL || env.DASHSCOPE_PURCHASE_MODEL || 'qwen3.8-flash'
  try {
    const response = await request({
      base, key, model,
      messages: [{ role: 'system', content: modelPrompt(candidate, assessment) }],
      json: true, disableThinking: true, maxTokens: 500, timeoutMs: 12000
    })
    const choice = response && response.choices && response.choices[0]
    if (!choice || choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') return null
    const parsed = JSON.parse(choice.message.content)
    const summary = text(parsed.summary, 120)
    const advice = text(parsed.advice, 240)
    return summary && advice ? { summary, advice } : null
  } catch (error) {
    console.error('购买评估模型失败，使用规则结果', error.message || error)
    return null
  }
}

function evaluate(candidate, rawItems, wearRecords, expenses, now = new Date(), includeGaps = true) {
  const items = inventory(rawItems).map((item, index) => ({
    ...item,
    subcategory: text(rawItems[index].subcategory, 30),
    purchaseDate: text(rawItems[index].purchaseDate, 10)
  }))
  const since = new Date(now)
  since.setDate(since.getDate() - 90)
  const sinceDate = dateKey(since)
  const wearCounts = new Map()
  // 账号在近 90 天有过穿着记录，闲置判断才有意义；从不打卡的用户"次数为 0"是没记录而非没穿过
  let hasRecentWear = false
  for (const record of wearRecords) {
    if (text(record.date, 10) < sinceDate || !Array.isArray(record.itemIds)) continue
    hasRecentWear = true
    for (const id of record.itemIds) wearCounts.set(id, (wearCounts.get(id) || 0) + 1)
  }

  const sameType = items.filter(item => item.category === candidate.category &&
    item.subcategory === candidate.subcategory && overlaps(item.seasons, candidate.seasons))
  const exact = sameType.filter(item => item.color === candidate.color)
  const risk = exact.length ? 'high' : sameType.length >= 2 || sameType.length && sameType.some(item => item.color !== candidate.color) ? 'medium' : 'low'
  const similarItems = sameType.slice(0, 5).map(item => ({
    id: item.id,
    name: item.name || item.category,
    color: item.color,
    wearCount90: wearCounts.get(item.id) || 0
  }))
  const allSimilarIdle = hasRecentWear && similarItems.length > 0 && similarItems.every(item => item.wearCount90 === 0)

  const gaps = includeGaps ? findGaps(items) : []
  const filledGaps = candidate.seasons
    .map(season => `${season}季缺少${candidate.category}`)
    .filter(gap => gaps.includes(gap))
  const matchItems = COMPLEMENTS[candidate.category] ? items.filter(item =>
    COMPLEMENTS[candidate.category].includes(item.category) &&
    overlaps(item.seasons, candidate.seasons) && compatibleColor(item.color, candidate.color)
  ).slice(0, 8) : []

  const month = dateKey(now).slice(0, 7)
  const wardrobeSpend = items.filter(item => item.purchaseDate.startsWith(month)).reduce((sum, item) => sum + item.price, 0)
  const ledgerSpend = expenses.filter(item => text(item.date, 10).startsWith(month)).reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
  const monthSpent = roundMoney(wardrobeSpend + ledgerSpend)
  const afterPurchase = roundMoney(monthSpent + candidate.price)
  const budgetExceeded = candidate.monthlyBudget !== null && afterPurchase > candidate.monthlyBudget

  let code = 'consider'
  if ((risk === 'high' && !filledGaps.length) || allSimilarIdle || budgetExceeded) code = 'skip'
  else if (risk === 'low' && filledGaps.length && !budgetExceeded) code = 'buy'
  const labels = { buy: '可以买', consider: '再考虑', skip: '建议不买' }
  const reasons = []
  if (risk === 'high') reasons.push(`衣橱已有 ${exact.length} 件同类同色衣物`)
  else if (risk === 'medium') reasons.push(`衣橱已有 ${sameType.length} 件相似衣物`)
  else reasons.push('衣橱中的同类重复度较低')
  if (filledGaps.length) reasons.push(`可补足${filledGaps.join('、')}`)
  if (allSimilarIdle) reasons.push('相似衣物近 90 天均无穿着记录')
  if (COMPLEMENTS[candidate.category]) reasons.push(`可与 ${matchItems.length} 件现有衣物搭配`)
  if (budgetExceeded) reasons.push(`购买后将超过月预算 ${roundMoney(afterPurchase - candidate.monthlyBudget)} 元`)

  return {
    verdict: { code, label: labels[code] },
    reasons,
    duplicateRisk: { level: risk, label: { high: '高', medium: '中', low: '低' }[risk], similarCount: sameType.length },
    similarItems,
    filledGaps,
    matchCount: COMPLEMENTS[candidate.category] ? matchItems.length : null,
    spending: { monthSpent, candidatePrice: candidate.price, afterPurchase, budget: candidate.monthlyBudget, budgetExceeded }
  }
}

async function handle({ db, openid, event }, request = requestChat, env = process.env) {
  const candidate = validate(event.candidate)
  const [{ items, truncated }, wearRecords, expenses] = await Promise.all([
    loadItems(db, openid),
    loadRecords(db, 'wear_records', openid),
    loadRecords(db, 'expenses', openid)
  ])
  const assessment = evaluate(candidate, items, wearRecords, expenses, new Date(), !truncated)
  const value = { ...assessment, considered: items.length, truncated }
  value.modelAdvice = await modelAdvice(candidate, value, request, env)
  return { success: true, assessment: value }
}

module.exports = { handle, validate, evaluate, modelAdvice }
