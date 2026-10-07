const test = require('node:test')
const assert = require('node:assert/strict')
const purchase = require('../cloudfunctions/auth/purchase')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')

const candidate = patch => ({ category: '上衣', subcategory: '', color: '蓝色', seasons: ['夏'], price: 199, ...patch })
const item = (_id, patch = {}) => ({ _id, _openid: 'openid-1', name: '蓝色短袖', category: '上衣', subcategory: '',
  color: '蓝色', seasons: ['夏'], price: 99, purchaseDate: '', ...patch })

test('购买评估按重复、缺口和预算给出确定结果', () => {
  const now = new Date('2026-10-07T08:00:00Z')
  const duplicate = purchase.evaluate(candidate({}), [item('top'), item('pants', { category: '下装', color: '黑色' })], [], [], now)
  assert.equal(duplicate.verdict.code, 'skip')
  assert.equal(duplicate.duplicateRisk.level, 'high')
  assert.equal(duplicate.similarItems[0].wearCount90, 0)

  const fillsGap = purchase.evaluate(candidate({ color: '白色' }), [item('pants', { category: '下装', color: '黑色' }),
    item('shoes', { category: '鞋', color: '白色' })], [], [], now)
  assert.equal(fillsGap.verdict.code, 'buy')
  assert.deepEqual(fillsGap.filledGaps, ['夏季缺少上衣'])
  assert.equal(fillsGap.matchCount, 2)

  const overBudget = purchase.evaluate(candidate({ monthlyBudget: 300 }), [], [],
    [{ amount: 150, date: '2026-10-02' }], now)
  assert.equal(overBudget.verdict.code, 'skip')
  assert.equal(overBudget.spending.afterPurchase, 349)
  assert.equal(overBudget.spending.budgetExceeded, true)
})

test('purchaseAssess 需要登录并只读取本人数据', async () => {
  const cloud = loadCloud({
    users: [{ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true }],
    clothes: [item('own'), { ...item('foreign'), _openid: 'openid-2' }]
  })
  const result = await cloud.main({ action: 'purchaseAssess', candidate: candidate({}) })
  assert.equal(result.success, true)
  assert.equal(result.assessment.considered, 1)
  await cloud.db.collection('users').doc('user').update({ data: { autoLoginEnabled: false } })
  assert.match((await cloud.main({ action: 'purchaseAssess', candidate: candidate({}) })).error, /登录状态已失效/)
})

test('规则结果生成后可调用模型补充自然语言建议，模型失败不影响评估', async () => {
  const cloud = loadCloud({ clothes: [item('pants', { category: '下装', color: '黑色' })] })
  const request = async args => {
    assert.equal(args.model, 'qwen3.8-flash')
    assert.equal(args.disableThinking, true)
    assert.equal(args.timeoutMs, 12000)
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '可以考虑', advice: '先确认是否能补足夏季上衣。' }) } }] }
  }
  const result = await purchase.handle({ db: cloud.db, openid: 'openid-1', event: { candidate: candidate({ color: '白色' }) } }, request, { DASHSCOPE_API_KEY: 'test-key' })
  assert.equal(result.assessment.modelAdvice.summary, '可以考虑')
  const fallback = await purchase.handle({ db: cloud.db, openid: 'openid-1', event: { candidate: candidate({ color: '白色' }) } }, async () => { throw Error('timeout') }, { DASHSCOPE_API_KEY: 'test-key' })
  assert.equal(fallback.assessment.modelAdvice, null)
})

test('购买评估页校验输入并展示服务端结果', async () => {
  const calls = []
  const page = loadPage('assistant', {
    purchaseAssess: async form => {
      calls.push(form)
      return { verdict: { code: 'buy', label: '可以买' }, reasons: ['可补缺'], duplicateRisk: { label: '低' },
        similarItems: [], matchCount: 2, spending: { monthSpent: 0, afterPurchase: 199 }, truncated: false }
    }
  })
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  await page.onPurchaseSubmit()
  assert.match(page.data.purchaseError, /分类/)
  page.onPurchaseCategoryTap({ currentTarget: { dataset: { value: '上衣' } } })
  page.onPurchaseColorChange({ detail: { value: 11 } })
  page.onPurchaseSeasonTap({ currentTarget: { dataset: { value: '夏' } } })
  page.onPurchaseFieldInput({ currentTarget: { dataset: { field: 'price' } }, detail: { value: '199' } })
  await page.onPurchaseSubmit()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].color, '蓝色')
  assert.equal(page.data.purchaseResult.verdict.code, 'buy')
})
