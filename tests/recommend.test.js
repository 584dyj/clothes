const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const recommendation = require('../cloudfunctions/auth/recommend')
const https = require('node:https')
const { EventEmitter } = require('node:events')

const env = { AI_API_BASE: 'https://api.deepseek.com', AI_API_KEY: 'test-key', AI_MODEL: 'deepseek-flash' }
const item = (_id, _openid, name, category, seasons) => ({ _id, _openid, name, category, seasons, color: '蓝色', price: 99 })
const response = itemIds => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
  outfits: [{ name: '通勤搭配', reason: '颜色协调', itemIds }], shoppingTips: [{ gap: '夏季缺少上衣', advice: '可考虑补充浅色短袖' }]
}) } }] })

test('推荐只读取本人衣物，按输入缓存并阻止重复付费调用', async () => {
  const cloud = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '上衣', ['春秋']), item('lower', 'openid-1', '长裤', '下装', ['春秋']), item('foreign', 'openid-2', '外套', '上衣', ['冬'])] })
  let requests = 0
  const request = async args => {
    requests++
    assert.equal(args.model, 'deepseek-flash')
    assert.match(args.messages[0].content, /三色|主色不超过 3 种/)
    assert.match(args.messages[0].content, /先基于用户衣物构思 2-3 套候选/)
    assert.match(args.messages[0].content, /示例/)
    assert.equal(args.messages[1].content.includes('foreign'), false)
    assert.equal(args.messages[1].content.includes('own'), true)
    return response(['own', 'lower'])
  }
  const context = { db: cloud.db, openid: 'openid-1', event: { occasion: '通勤' } }
  const first = await recommendation.handle(context, request, env)
  assert.equal(first.success, true)
  assert.equal(first.cached, false)
  assert.equal(first.considered, 2)
  assert.deepEqual(first.outfits[0].itemIds, ['own', 'lower'])
  assert.equal(first.shoppingTips[0], '夏季缺少上衣：可考虑补充浅色短袖')
  const second = await recommendation.handle(context, request, env)
  assert.equal(second.cached, true)
  assert.equal(requests, 1)
  await assert.rejects(recommendation.handle({ ...context, event: { occasion: '约会' } }, request, env), /请求太频繁/)
})

test('推荐拒绝虚构衣物和截断响应，失败后解除生成锁', async () => {
  const cloud = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '上衣', ['春秋']), item('lower', 'openid-1', '长裤', '下装', ['春秋'])] })
  const context = { db: cloud.db, openid: 'openid-1', event: { occasion: '日常' } }
  await assert.rejects(recommendation.handle(context, async () => response(['foreign']), env), /无效衣物/)
  assert.equal(cloud.records.auth_attempts[0].busyUntil, null)
  assert.equal(cloud.records.auth_attempts[0].cacheResult, undefined)
  const fresh = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '上衣', ['春秋']), item('lower', 'openid-1', '长裤', '下装', ['春秋'])] })
  await assert.rejects(recommendation.handle({ ...context, db: fresh.db }, async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), env), /不完整/)
  assert.throws(() => recommendation.cleanResult(response(['own']), [
    { id: 'own', category: '上衣' }, { id: 'lower', category: '下装' }
  ], ['夏季缺少上衣']), /组合不完整/)
})

test('购买建议只接受实际缺口，缺少可穿组合时可只返回补缺建议', () => {
  const output = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    outfits: [], shoppingTips: [{ gap: '夏季缺少上衣', advice: '可考虑短袖' }, { gap: '虚构缺口', advice: '买更多' }]
  }) } }] }
  const result = recommendation.cleanResult(output, [{ id: 'own', category: '上衣' }], ['夏季缺少上衣'])
  assert.deepEqual(result.outfits, [])
  assert.deepEqual(result.shoppingTips, ['夏季缺少上衣：可考虑短袖'])
})

test('超过取样上限时不把未扫描衣物误判为购买缺口', async () => {
  const clothes = Array.from({ length: 121 }, (_, index) => item(`item-${index}`, 'openid-1', `衣物${index}`, index === 1 ? '下装' : '上衣', ['春秋']))
  const cloud = loadCloud({ clothes })
  let prompt
  const result = await recommendation.handle({ db: cloud.db, openid: 'openid-1', event: { occasion: '日常' } }, async args => {
    prompt = JSON.parse(args.messages[1].content)
    return response(['item-0', 'item-1'])
  }, env)
  assert.equal(prompt.items.length, 120)
  assert.deepEqual(prompt.gaps, [])
  assert.equal(result.truncated, true)
  assert.deepEqual(result.shoppingTips, [])
})

test('推荐接口需要登录，配置缺失时不请求模型', async () => {
  const cloud = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '上衣', ['春秋'])] })
  assert.match((await cloud.main({ action: 'recommend', occasion: '日常' })).error, /登录状态已失效/)
  await assert.rejects(recommendation.handle({ db: cloud.db, openid: 'openid-1', event: { occasion: '日常' } }, async () => response(['own']), {}), /尚未配置/)
})

test('auth 推荐入口校验账号状态后才调用推荐模块', async () => {
  const original = recommendation.handle
  const seen = []
  recommendation.handle = async context => { seen.push(context.openid); return { success: true, outfits: [] } }
  try {
    const cloud = loadCloud({ users: [{ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true }] })
    assert.equal((await cloud.main({ action: 'recommend', occasion: '日常' })).success, true)
    await cloud.db.collection('users').doc('user').update({ data: { autoLoginEnabled: false } })
    assert.match((await cloud.main({ action: 'recommend', occasion: '日常' })).error, /登录状态已失效/)
    assert.deepEqual(seen, ['openid-1'])
  } finally { recommendation.handle = original }
})

test('模型请求使用服务端密钥和 JSON 输出格式', async () => {
  const original = https.request
  let captured
  https.request = (url, options, callback) => {
    const req = new EventEmitter()
    req.setTimeout = timeout => { captured = { ...captured, timeout } }
    req.end = body => {
      captured = { ...captured, url: String(url), options, body: JSON.parse(body) }
      const res = new EventEmitter()
      res.statusCode = 200
      res.setEncoding = () => {}
      callback(res)
      process.nextTick(() => {
        res.emit('data', JSON.stringify(response(['own', 'lower'])))
        res.emit('end')
      })
    }
    return req
  }
  try {
    const result = await recommendation.requestCompletion({ ...env, base: env.AI_API_BASE, key: env.AI_API_KEY, model: env.AI_MODEL, messages: [{ role: 'user', content: 'json' }] })
    assert.equal(result.choices[0].finish_reason, 'stop')
    assert.equal(captured.url, 'https://api.deepseek.com/chat/completions')
    assert.equal(captured.options.headers.Authorization, 'Bearer test-key')
    assert.equal(captured.body.model, 'deepseek-flash')
    assert.equal(captured.body.response_format.type, 'json_object')
    assert.equal(captured.body.thinking.type, 'disabled')
    assert.equal(captured.timeout, 20000)
    await recommendation.requestCompletion({ base: env.AI_API_BASE, key: env.AI_API_KEY, model: env.AI_MODEL,
      messages: [{ role: 'user', content: 'json' }], disableThinking: false })
    assert.equal(captured.body.thinking.type, 'enabled')
    assert.equal(captured.body.reasoning_effort, 'low')
  } finally { https.request = original }
})

test('衣橱画像命中缓存，衣物写入后按版本重建', async () => {
  const cloud = loadCloud({ users: [{ _id: 'user', username: 'alice', openid: 'openid-1', autoLoginEnabled: true }],
    clothes: [item('own', 'openid-1', '衬衫', '上衣', ['春秋'])] })
  const first = await recommendation.getInventory(cloud.db, 'openid-1')
  assert.equal(first.items.length, 1)
  assert.equal(cloud.records.ai_cache.length, 1)
  const reads = () => cloud.calls.filter(call => call.collection === 'clothes' && call.operation === 'get').length
  const count = reads()
  assert.deepEqual((await recommendation.getInventory(cloud.db, 'openid-1')).items, first.items)
  assert.equal(reads(), count)
  const newItem = { name: '黑针织衫', category: '上衣', subcategory: '', size: '', color: '黑色', brand: '',
    purchaseDate: '', note: '', imageFileID: '', seasons: ['冬'], price: 99 }
  assert.equal((await cloud.main({ action: 'data', operation: 'add', collection: 'clothes', data: newItem })).success, true)
  assert.equal(cloud.records.wardrobe_meta[0].version, 1)
  const refreshed = await recommendation.getInventory(cloud.db, 'openid-1')
  assert.equal(refreshed.items.length, 2)
  assert.equal(reads(), count + 1)
  assert.equal(cloud.records.ai_cache[0].clothesVersion, 1)
})

