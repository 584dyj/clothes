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
  const cloud = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '衬衫', ['春秋']), item('lower', 'openid-1', '长裤', '长裤', ['春秋']), item('foreign', 'openid-2', '外套', '外套', ['冬'])] })
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
  const cloud = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '衬衫', ['春秋']), item('lower', 'openid-1', '长裤', '长裤', ['春秋'])] })
  const context = { db: cloud.db, openid: 'openid-1', event: { occasion: '日常' } }
  await assert.rejects(recommendation.handle(context, async () => response(['foreign']), env), /无效衣物/)
  assert.equal(cloud.records.auth_attempts[0].busyUntil, null)
  assert.equal(cloud.records.auth_attempts[0].cacheResult, undefined)
  const fresh = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '衬衫', ['春秋']), item('lower', 'openid-1', '长裤', '长裤', ['春秋'])] })
  await assert.rejects(recommendation.handle({ ...context, db: fresh.db }, async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), env), /不完整/)
  assert.throws(() => recommendation.cleanResult(response(['own']), [
    { id: 'own', category: '衬衫' }, { id: 'lower', category: '长裤' }
  ], ['夏季缺少上衣']), /组合不完整/)
})

test('购买建议只接受实际缺口，缺少可穿组合时可只返回补缺建议', () => {
  const output = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    outfits: [], shoppingTips: [{ gap: '夏季缺少上衣', advice: '可考虑短袖' }, { gap: '虚构缺口', advice: '买更多' }]
  }) } }] }
  const result = recommendation.cleanResult(output, [{ id: 'own', category: '衬衫' }], ['夏季缺少上衣'])
  assert.deepEqual(result.outfits, [])
  assert.deepEqual(result.shoppingTips, ['夏季缺少上衣：可考虑短袖'])
})

test('超过取样上限时不把未扫描衣物误判为购买缺口', async () => {
  const clothes = Array.from({ length: 121 }, (_, index) => item(`item-${index}`, 'openid-1', `衣物${index}`, index === 1 ? '长裤' : '衬衫', ['春秋']))
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
  const cloud = loadCloud({ clothes: [item('own', 'openid-1', '衬衫', '衬衫', ['春秋'])] })
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
    clothes: [item('own', 'openid-1', '衬衫', '衬衫', ['春秋'])] })
  const first = await recommendation.getInventory(cloud.db, 'openid-1')
  assert.equal(first.items.length, 1)
  assert.equal(cloud.records.ai_cache.length, 1)
  assert.equal(cloud.records.ai_cache[0].strategyVersion, 3)
  const reads = () => cloud.calls.filter(call => call.collection === 'clothes' && call.operation === 'get').length
  const count = reads()
  assert.deepEqual((await recommendation.getInventory(cloud.db, 'openid-1')).items, first.items)
  assert.equal(reads(), count)
  delete cloud.records.ai_cache[0].strategyVersion
  cloud.records.ai_cache[0].items = [{ id: '旧缓存' }]
  assert.deepEqual((await recommendation.getInventory(cloud.db, 'openid-1')).items, first.items)
  assert.equal(reads(), count + 1)
  const newItem = { name: '黑针织衫', category: '毛衣', subcategory: '', size: '', color: '黑色', brand: '',
    purchaseDate: '', note: '', imageFileID: '', seasons: ['冬'], price: 99 }
  assert.equal((await cloud.main({ action: 'data', operation: 'add', collection: 'clothes', data: newItem })).success, true)
  assert.equal(cloud.records.wardrobe_meta[0].version, 1)
  const refreshed = await recommendation.getInventory(cloud.db, 'openid-1')
  assert.equal(refreshed.items.length, 2)
  assert.equal(reads(), count + 2)
  assert.equal(cloud.records.ai_cache[0].clothesVersion, 1)
})

test('空衣橱画像缓存不命中，并可自愈遗漏版本递增的旧数据', async () => {
  const cloud = loadCloud()
  const reads = () => cloud.calls.filter(call => call.collection === 'clothes' && call.operation === 'get').length

  assert.deepEqual((await recommendation.getInventory(cloud.db, 'openid-1')).items, [])
  assert.equal(reads(), 1)
  assert.deepEqual((await recommendation.getInventory(cloud.db, 'openid-1')).items, [])
  assert.equal(reads(), 2)

  cloud.records.clothes.push(item('late', 'openid-1', '迟到的衬衫', '衬衫', ['春秋']))
  const recovered = await recommendation.getInventory(cloud.db, 'openid-1')
  assert.deepEqual(recovered.items.map(row => row.id), ['late'])
  assert.equal(reads(), 3)
  assert.deepEqual(cloud.records.ai_cache[0].items.map(row => row.id), ['late'])
})

test('超过 120 件时保留最近 60 件，其余按近 90 天穿着频次选择', async () => {
  const now = Date.now()
  const today = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const clothes = Array.from({ length: 130 }, (_, index) => ({
    ...item(`item-${index}`, 'openid-1', `衣物${index}`, '衬衫', ['春秋']),
    createdAt: new Date(now - index * 1000)
  }))
  clothes[127].createdAt = new Date(now - 124500)
  clothes.push({ ...item('foreign', 'openid-2', '他人衣物', '衬衫', ['春秋']), createdAt: new Date(now) })
  const wear_records = [
    { _id: 'w1', _openid: 'openid-1', date: today, itemIds: ['item-125', 'item-126', 'missing', 'foreign'] },
    { _id: 'w2', _openid: 'openid-1', date: today, itemIds: ['item-125', 'item-127'] },
    { _id: 'w3', _openid: 'openid-1', date: '2022-01-01', itemIds: ['item-129'] },
    { _id: 'w4', _openid: 'openid-2', date: today, itemIds: ['item-128'] }
  ]
  const result = await recommendation.loadItems(loadCloud({ clothes, wear_records }).db, 'openid-1')
  assert.deepEqual(result.items.slice(0, 60).map(row => row._id), Array.from({ length: 60 }, (_, index) => `item-${index}`))
  assert.deepEqual(result.items.slice(60, 63).map(row => row._id), ['item-125', 'item-127', 'item-126'])
  assert.equal(result.items.length, 120)
  assert.equal(result.items.some(row => ['missing', 'foreign', 'item-128', 'item-129'].includes(row._id)), false)
  assert.equal(result.truncated, true)
  assert.equal(result.wearTruncated, false)
})

test('穿着画像最多读取最近 500 条并标记截断', async () => {
  const now = Date.now()
  const today = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const clothes = Array.from({ length: 121 }, (_, index) => ({
    ...item(`item-${index}`, 'openid-1', `衣物${index}`, '衬衫', ['春秋']),
    createdAt: new Date(now - index * 1000)
  }))
  const wear_records = Array.from({ length: 501 }, (_, index) => ({
    _id: `wear-${index}`, _openid: 'openid-1', date: today, itemIds: ['item-120'], createdAt: new Date(now - index)
  }))
  const cloud = loadCloud({ clothes, wear_records })
  const result = await recommendation.loadItems(cloud.db, 'openid-1')
  assert.equal(result.wearTruncated, true)
  assert.equal(result.items.some(row => row._id === 'item-120'), true)
  assert.deepEqual(cloud.calls.filter(call => call.collection === 'wear_records' && call.operation === 'get').map(call => call.offset),
    Array.from({ length: 25 }, (_, index) => index * 20))
})

test('推荐完整性按冻结角色判定：内搭加下装或连衣裙通过，外搭家居服配饰不构成结构', () => {
  const owned = [
    { id: 'shirt', category: '衬衫' }, { id: 'tee', category: '短袖' }, { id: 'sweater', category: '毛衣' },
    { id: 'pants', category: '长裤' }, { id: 'skirt', category: '短裙' }, { id: 'longskirt', category: '长裙' },
    { id: 'dress', category: '连衣裙' }, { id: 'coat', category: '外套' }, { id: 'down', category: '羽绒服' },
    { id: 'home', category: '家居服' }, { id: 'socks', category: '配饰', subcategory: '袜子' }
  ]
  for (const ids of [['shirt', 'pants'], ['tee', 'skirt'], ['sweater', 'pants'], ['dress'], ['shirt', 'pants', 'coat'], ['dress', 'down']]) {
    const result = recommendation.cleanResult(response(ids), owned, [])
    assert.deepEqual(result.outfits[0].itemIds, ids, ids.join('+'))
  }
  for (const ids of [['longskirt'], ['coat', 'pants'], ['down', 'pants'], ['socks'], ['home'], ['home', 'pants']]) {
    assert.throws(() => recommendation.cleanResult(response(ids), owned, []), /组合不完整/, ids.join('+'))
  }
})

test('衣橱画像先过滤再采样：其他与未知类别不占名额不入画像，配饰保留子类，结果引用其他无效', async () => {
  const cloud = loadCloud({ clothes: [
    item('shirt', 'openid-1', '白衬衫', '衬衫', ['春秋']),
    { ...item('socks', 'openid-1', '棉袜', '配饰', ['春秋']), subcategory: '袜子' },
    item('misc', 'openid-1', '摆件', '其他', ['春秋']),
    item('legacy', 'openid-1', '旧上衣', '上衣', ['春秋'])
  ] })
  const first = await recommendation.getInventory(cloud.db, 'openid-1')
  assert.deepEqual(Array.from(first.items.map(row => row.id)).sort(), ['shirt', 'socks'])
  assert.equal(first.items.find(row => row.id === 'socks').subcategory, '袜子')
  await assert.rejects(recommendation.handle({ db: cloud.db, openid: 'openid-1', event: { occasion: '日常' } }, async args => {
    assert.equal(args.messages[1].content.includes('misc'), false)
    assert.equal(args.messages[1].content.includes('legacy'), false)
    return response(['misc'])
  }, env), /无效衣物/)

  const onlyMisc = loadCloud({ clothes: [item('only-misc', 'openid-1', '摆件', '其他', ['春秋'])] })
  await assert.rejects(recommendation.handle({ db: onlyMisc.db, openid: 'openid-1', event: { occasion: '日常' } },
    async () => response([]), env), /衣橱中还没有衣物/)
})

test('大量其他不占用采样名额，更旧的合格衣物仍可进入画像', async () => {
  const now = Date.now()
  const clothes = [
    ...Array.from({ length: 130 }, (_, index) => ({ ...item(`misc-${index}`, 'openid-1', `摆件${index}`, '其他', ['春秋']),
      createdAt: new Date(now - index * 1000) })),
    ...[['shirt', '衬衫'], ['dress', '连衣裙'], ['pants', '长裤']].map(([id, category], index) => ({
      ...item(id, 'openid-1', id, category, ['春秋']), createdAt: new Date(now - 200000 - index * 1000) }))
  ]
  const result = await recommendation.getInventory(loadCloud({ clothes }).db, 'openid-1')
  assert.deepEqual(Array.from(result.items.map(row => row.id)).sort(), ['dress', 'pants', 'shirt'])
  assert.equal(result.truncated, false)
})

test('缺口按搭配角色判断：短袖补上衣缺口，外搭与家居服不消除结构缺口', () => {
  assert.equal(recommendation.findGaps([{ category: '短袖', seasons: ['夏'] }]).includes('夏季缺少上衣'), false)
  const gaps = recommendation.findGaps([{ category: '外套', seasons: ['春秋'] }, { category: '长裤', seasons: ['春秋'] }])
  assert.equal(gaps.includes('春秋季缺少上衣'), true)
  assert.equal(gaps.includes('春秋季缺少下装'), false)
  assert.equal(recommendation.findGaps([{ category: '家居服', seasons: ['夏'] }]).includes('夏季缺少上衣'), true)
  assert.equal(recommendation.findGaps([{ category: '连衣裙', seasons: ['夏'] }]).includes('夏季缺少上衣'), true)
})

test('穿着记录增删改递增衣橱画像版本', async () => {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const cloud = loadCloud({
    users: [{ _id: 'user', username: 'alice', openid: 'openid-1', autoLoginEnabled: true }],
    clothes: [item('own', 'openid-1', '衬衫', '衬衫', ['春秋'])]
  })
  const data = { date: today, outfitId: '', itemIds: ['own'], note: '' }
  const added = await cloud.main({ action: 'data', operation: 'add', collection: 'wear_records', data })
  assert.equal(added.success, true)
  assert.equal(cloud.records.wardrobe_meta[0].version, 1)
  assert.equal((await cloud.main({ action: 'data', operation: 'update', collection: 'wear_records', id: added._id,
    data: { ...data, note: '更新' } })).success, true)
  assert.equal(cloud.records.wardrobe_meta[0].version, 2)
  assert.equal((await cloud.main({ action: 'data', operation: 'delete', collection: 'wear_records', id: added._id })).success, true)
  assert.equal(cloud.records.wardrobe_meta[0].version, 3)
})

test('策略升级使旧画像和旧推荐失效，挂件与连衣裙按新策略重建', async () => {
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex')
  const clothes = [item('dress', 'openid-1', '原连衣裙', '连衣裙', ['春秋']), item('pendant', 'openid-1', '原挂件', '挂件', ['春秋'])]
  const items = recommendation.inventory(clothes)
  const cloud = loadCloud({ clothes, ai_cache: [{ _id: hash('ai-cache:openid-1'), clothesVersion: 0, strategyVersion: 2, items }],
    auth_attempts: [{ _id: hash('recommend:openid-1'), key: hash('recommend:openid-1'),
      cacheHash: hash(JSON.stringify({ strategyVersion: 2, model: env.AI_MODEL, occasion: '日常', items, wearTruncated: false })),
      cacheResult: { marker: 'old-policy' }, cacheUntil: new Date(Date.now() + 600000) }] })
  let requests = 0
  const result = await recommendation.handle({ db: cloud.db, openid: 'openid-1', event: {} }, async () => {
    requests++
    return response(['dress'])
  }, env)
  assert.equal(result.cached, false)
  assert.equal(requests, 1)
  assert.equal(cloud.records.ai_cache[0].strategyVersion, 3)
  assert.deepEqual(cloud.records.ai_cache[0].items.map(row => row.id), ['dress', 'pendant'])
  assert.deepEqual(result.outfits[0].itemIds, ['dress'])
})

test('大量其他不消耗扫描名额，高频候选也须过滤且截断只看合格衣物', async () => {
  const now = Date.now(), today = new Date(now + 8 * 3600000).toISOString().slice(0, 10)
  for (const count of [3, 121]) {
    const clothes = [
      ...Array.from({ length: 600 }, (_, index) => item(`misc-${index}`, 'openid-1', '摆件', '其他', ['春秋'])),
      item('unknown', 'openid-1', '旧类别', '上衣', ['春秋']),
      ...Array.from({ length: count }, (_, index) => item(`dress-${index}`, 'openid-1', '连衣裙', '连衣裙', ['春秋']))
    ]
    const cloud = loadCloud({ clothes, wear_records: [{ _id: 'wear', _openid: 'openid-1', date: today,
      itemIds: ['misc-0', 'unknown', `dress-${count - 1}`] }] })
    const result = await recommendation.getInventory(cloud.db, 'openid-1')
    assert.equal(result.items.length, Math.min(count, 120))
    assert.ok(result.items.every(row => row.category === '连衣裙'))
    assert.ok(result.items.some(row => row.id === `dress-${count - 1}`))
    assert.equal(result.truncated, count > 120)
  }
})

test('类别来回修改和普通编辑失效旧推荐，在途结果不发布且保留冷却', async () => {
  const cloud = loadCloud({ users: [{ _id: 'user', openid: 'openid-1', autoLoginEnabled: true }],
    clothes: [item('dress', 'openid-1', '连衣裙', '连衣裙', ['春秋'])] })
  const context = { db: cloud.db, openid: 'openid-1', event: {} }
  let release, began
  const entered = new Promise(resolve => { began = resolve })
  const pending = recommendation.handle(context, () => { began(); return new Promise(resolve => { release = resolve }) }, env)
  await entered
  const update = async patch => {
    const result = await cloud.main({ action: 'data', operation: 'update', collection: 'clothes', id: 'dress',
      data: { ...cloud.records.clothes[0], ...patch } })
    assert.equal(result.success, true)
  }
  await update({ category: '其他' })
  release(response(['dress']))
  await assert.rejects(pending, /衣橱已更新/)
  const lock = cloud.records.auth_attempts.find(row => row.action === 'recommend')
  assert.equal(lock.busyUntil, null)
  assert.equal(lock.cacheResult, undefined)
  assert.deepEqual((await recommendation.getInventory(cloud.db, 'openid-1')).items, [])
  await update({ category: '连衣裙' })
  await assert.rejects(recommendation.handle(context, async () => response(['dress']), env), /请求太频繁/)
  cloud.records.auth_attempts.find(row => row.action === 'recommend').nextAllowedAt = new Date(0)
  assert.equal((await recommendation.handle(context, async () => response(['dress']), env)).cached, false)
  assert.equal((await recommendation.handle(context, async () => response(['dress']), env)).cached, true)
  await update({ note: '普通编辑' })
  cloud.records.auth_attempts.find(row => row.action === 'recommend').nextAllowedAt = new Date(0)
  assert.equal((await recommendation.handle(context, async () => response(['dress']), env)).cached, false)
  assert.equal(cloud.records.wardrobe_meta[0].version, 3)
})

test('旧画像构建和超时旧推荐均不能覆盖新版本或新请求的锁', async () => {
  const crypto = require('node:crypto')
  const metaId = crypto.createHash('sha256').update('wardrobe:openid-1').digest('hex')
  const cloud = loadCloud({ clothes: [item('dress', 'openid-1', '连衣裙', '连衣裙', ['春秋'])] })
  cloud.faults.before = (collection, operation) => {
    if (collection === 'clothes' && operation === 'get') {
      cloud.faults.before = null
      cloud.records.wardrobe_meta.push({ _id: metaId, version: 1 })
    }
  }
  await assert.rejects(recommendation.getInventory(cloud.db, 'openid-1'), /衣橱已更新/)
  assert.equal(cloud.records.ai_cache.length, 0)
  const context = { db: cloud.db, openid: 'openid-1', event: {} }
  const releases = []
  let began
  let entered = new Promise(resolve => { began = resolve })
  const request = () => new Promise(resolve => { releases.push(resolve); began() })
  const old = recommendation.handle(context, request, env)
  await entered
  const lock = cloud.records.auth_attempts.find(row => row.action === 'recommend')
  lock.busyUntil = new Date(0)
  lock.nextAllowedAt = new Date(0)
  entered = new Promise(resolve => { began = resolve })
  const latest = recommendation.handle(context, request, env)
  await entered
  const token = cloud.records.auth_attempts.find(row => row.action === 'recommend').requestToken
  releases[0](response(['dress']))
  await assert.rejects(old, /请求已失效/)
  assert.equal(cloud.records.auth_attempts.find(row => row.action === 'recommend').requestToken, token)
  releases[1](response(['dress']))
  assert.equal((await latest).success, true)
})

