const test = require('node:test')
const assert = require('node:assert/strict')
const purchase = require('../cloudfunctions/auth/purchase')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')

const candidate = patch => ({ category: '短袖', subcategory: '', color: '蓝色', seasons: ['夏'], price: 199, ...patch })
const item = (_id, patch = {}) => ({ _id, _openid: 'openid-1', name: '蓝色短袖', category: '短袖', subcategory: '',
  color: '蓝色', seasons: ['夏'], price: 99, purchaseDate: '', ...patch })
const fileID = number => `cloud://env/wardrobe/${number.toString(16).padStart(32, '0')}.jpg`
const ticket = (number, patch = {}) => ({ _id: number.toString(16).padStart(32, '0'), _openid: 'openid-1',
  cloudPath: `wardrobe/${number.toString(16).padStart(32, '0')}.jpg`, fileID: fileID(number), target: 'itemScan', ...patch })
const visualResponse = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })

test('购买评估按重复、缺口和预算给出确定结果', () => {
  const now = new Date('2026-10-07T08:00:00Z')
  const duplicate = purchase.evaluate(candidate({}), [item('top'), item('pants', { category: '长裤', color: '黑色' })], [], [], now)
  assert.equal(duplicate.verdict.code, 'skip')
  assert.equal(duplicate.duplicateRisk.level, 'high')
  assert.equal(duplicate.similarItems[0].wearCount90, 0)
  const futureWear = purchase.evaluate(candidate({}), [item('top')],
    [{ date: '2026-10-08', itemIds: ['top'] }], [], now)
  assert.equal(futureWear.similarItems[0].wearCount90, 0)

  const fillsGap = purchase.evaluate(candidate({ color: '白色' }), [item('pants', { category: '长裤', color: '黑色' }),
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

test('购买评估与视觉复核需要登录，规则评估只读取本人数据', async () => {
  const cloud = loadCloud({
    users: [{ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true }],
    clothes: [item('own'), { ...item('foreign'), _openid: 'openid-2' }]
  })
  const result = await cloud.main({ action: 'purchaseAssess', candidate: candidate({}) })
  assert.equal(result.success, true)
  assert.equal(result.assessment.considered, 1)
  await cloud.db.collection('users').doc('user').update({ data: { autoLoginEnabled: false } })
  assert.match((await cloud.main({ action: 'purchaseAssess', candidate: candidate({}) })).error, /登录状态已失效/)
  assert.match((await cloud.main({ action: 'purchaseVisual', candidate: candidate({}), imageFileID: fileID(1) })).error, /登录状态已失效/)
})

test('规则结果生成后可调用模型补充自然语言建议，模型失败不影响评估', async () => {
  const cloud = loadCloud({ clothes: [item('pants', { category: '长裤', color: '黑色' })] })
  const request = async args => {
    assert.equal(args.base, 'https://api.deepseek.com')
    assert.equal(args.key, 'test-key')
    assert.equal(args.model, 'deepseek-flash')
    assert.equal(args.disableThinking, true)
    assert.equal(args.timeoutMs, 12000)
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '可以考虑', advice: '先确认是否能补足夏季上衣。' }) } }] }
  }
  const result = await purchase.handle({ db: cloud.db, openid: 'openid-1', event: { candidate: candidate({ color: '白色' }) } }, request, { AI_API_KEY: 'test-key' })
  assert.equal(result.assessment.modelAdvice.summary, '可以考虑')
  const fallback = await purchase.handle({ db: cloud.db, openid: 'openid-1', event: { candidate: candidate({ color: '白色' }) } }, async () => { throw Error('timeout') }, { AI_API_KEY: 'test-key' })
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
  page.onPurchaseCategoryTap({ currentTarget: { dataset: { value: '衬衫' } } })
  page.onPurchaseColorChange({ detail: { value: 11 } })
  page.onPurchaseSeasonTap({ currentTarget: { dataset: { value: '夏' } } })
  page.onPurchaseFieldInput({ currentTarget: { dataset: { field: 'price' } }, detail: { value: '199' } })
  await page.onPurchaseSubmit()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].color, '蓝色')
  assert.equal(page.data.purchaseResult.verdict.code, 'buy')
})

test('购买评估选图后自动识别，仅填空字段并保留图片供视觉复核', async () => {
  const calls = [], toasts = []
  const page = loadPage('assistant', {
    chooseImage: async sourceType => { calls.push(['choose', ...sourceType]); return '/tmp/top.jpg' },
    uploadImage: async path => { calls.push(['upload', path]); return 'cloud://env/wardrobe/top.jpg' },
    itemScan: async fileID => {
      calls.push(['scan', fileID])
      return { name: '白衬衫', category: '衬衫', subcategory: '', color: '白色', seasons: ['夏'], brand: '不应填入' }
    },
    removeImage: async fileID => { calls.push(['remove', fileID]); return true }
  }, { showToast: options => toasts.push(options.title) })
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  page.setData({ 'purchaseForm.name': '已有名称', 'purchaseForm.color': '蓝色', 'purchaseForm.price': '199',
    'purchaseForm.note': '保留备注' })

  await page.onPurchaseTakePhoto()

  assert.deepEqual(calls, [
    ['choose', 'camera'], ['upload', '/tmp/top.jpg'], ['scan', 'cloud://env/wardrobe/top.jpg']
  ])
  assert.equal(page.data.purchaseForm.name, '已有名称')
  assert.equal(page.data.purchaseForm.category, '衬衫')
  assert.equal(page.data.purchaseForm.color, '蓝色')
  assert.deepEqual(Array.from(page.data.purchaseForm.seasons), ['夏'])
  assert.equal(page.data.purchaseForm.price, '199')
  assert.equal(page.data.purchaseForm.note, '保留备注')
  assert.equal(Object.hasOwn(page.data.purchaseForm, 'brand'), false)
  assert.equal(page.data.purchaseImagePath, '/tmp/top.jpg')
  assert.equal(page.data.purchaseScanFileID, 'cloud://env/wardrobe/top.jpg')
  assert.equal(toasts.at(-1), '已自动填充，请核对')
})

test('购买评估识别失败保留图片供重试，离开模式时清理票据', async () => {
  let scans = 0, uploads = 0
  const removed = []
  const page = loadPage('assistant', {
    chooseImage: async () => '/tmp/shoe.jpg',
    uploadImage: async () => { uploads++; return 'cloud://env/wardrobe/shoe.jpg' },
    itemScan: async () => {
      scans++
      if (scans === 1) throw Error('识别失败，请重试或手动填写')
      return { name: '运动鞋', category: '鞋', subcategory: '', color: '白色', seasons: ['春秋'], brand: '' }
    },
    removeImage: async fileID => { removed.push(fileID); return true }
  })
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })

  await page.onPurchaseChooseAlbum()
  assert.equal(page.data.purchaseImagePath, '/tmp/shoe.jpg')
  assert.equal(page.data.purchaseScanFileID, 'cloud://env/wardrobe/shoe.jpg')
  assert.match(page.data.purchaseError, /识别失败/)
  assert.equal(removed.length, 0)

  await page.onPurchaseScanPhoto()
  assert.equal(uploads, 1)
  assert.equal(scans, 2)
  assert.deepEqual(removed, [])
  assert.equal(page.data.purchaseForm.category, '鞋')

  page.onModeTap({ currentTarget: { dataset: { mode: 'outfit' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(removed, ['cloud://env/wardrobe/shoe.jpg'])

  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  page.setData({ purchaseImagePath: '/tmp/failed.jpg', purchaseScanFileID: 'cloud://env/wardrobe/failed.jpg' })
  page.onModeTap({ currentTarget: { dataset: { mode: 'outfit' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.purchaseImagePath, '')
  assert.deepEqual(removed, ['cloud://env/wardrobe/shoe.jpg', 'cloud://env/wardrobe/failed.jpg'])

  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /拍照识别/)
  assert.match(markup, /相册识别/)
  assert.match(markup, /重试识别/)
})

test('视觉复核限制图片数量并按一级范围合成结论', async () => {
  const clothes = []
  for (let index = 0; index < 6; index++) clothes.push(item(`similar-${index}`, { imageFileID: fileID(index + 2) }))
  for (let index = 0; index < 3; index++) clothes.push(item(`match-${index}`, {
    category: index === 2 ? '鞋' : '长裤', color: '黑色', imageFileID: fileID(index + 20)
  }))
  const cloud = loadCloud({ clothes, upload_tickets: [ticket(1)] })
  let requestArgs
  const result = await purchase.visualHandle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1',
    event: { candidate: candidate({}), imageFileID: fileID(1) } }, async args => {
    requestArgs = args
    return visualResponse({ adjust: 1, reason: '候选与现有款式仍有明显细节差异' })
  }, { AI_API_KEY: 'key' })

  const images = requestArgs.messages[1].content.filter(part => part.type === 'image_url')
  assert.equal(images.length, 7)
  assert.equal(requestArgs.disableThinking, true)
  assert.equal(requestArgs.maxTokens, 400)
  assert.equal(requestArgs.timeoutMs, 30000)
  assert.equal(result.visualReview.comparedCount, 6)
  assert.equal(result.visualReview.ruleVerdict.code, 'skip')
  assert.equal(result.visualReview.finalVerdict.code, 'consider')
})

test('视觉复核非法调整归零、端点钳制且预算超支不可推翻', () => {
  const base = { verdict: { code: 'consider', label: '再考虑' }, spending: { budgetExceeded: false } }
  assert.equal(purchase.composeVisualReview(base, { adjust: 8, reason: '依据' }, 2).adjust, 0)
  const endpoint = purchase.composeVisualReview({ ...base, verdict: { code: 'buy', label: '可以买' } },
    { adjust: 1, reason: '依据' }, 2)
  assert.equal(endpoint.adjust, 0)
  assert.equal(endpoint.finalVerdict.code, 'buy')
  const budget = purchase.composeVisualReview({ verdict: { code: 'skip', label: '建议不买' }, spending: { budgetExceeded: true } },
    { adjust: 1, reason: '图片看起来不同' }, 2)
  assert.equal(budget.adjust, 0)
  assert.equal(budget.finalVerdict.code, 'skip')
})

test('视觉复核校验本人票据，关联图片单张失败时跳过', async () => {
  const cloud = loadCloud({
    clothes: [item('similar', { imageFileID: fileID(2) }), item('match', { category: '长裤', color: '黑色', imageFileID: fileID(3) })],
    upload_tickets: [ticket(1)]
  })
  cloud.faults.download = async id => {
    if (id === fileID(2)) throw Error('missing')
    return { fileContent: Buffer.from('image') }
  }
  const result = await purchase.visualHandle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1',
    event: { candidate: candidate({}), imageFileID: fileID(1) } }, async () => visualResponse({ adjust: 0, reason: '保留规则结论' }),
  { AI_API_KEY: 'key' })
  assert.equal(result.visualReview.comparedCount, 1)

  cloud.records.upload_tickets[0]._openid = 'openid-2'
  await assert.rejects(purchase.visualHandle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1',
    event: { candidate: candidate({}), imageFileID: fileID(1) } }, async () => visualResponse({ adjust: 0, reason: '无' }),
  { AI_API_KEY: 'key' }), /不属于当前账号/)
})

test('视觉模型失败与非法 JSON 静默回退，忙锁拒绝并在完成后释放', async () => {
  const cloud = loadCloud({ upload_tickets: [ticket(1)] })
  const context = { db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1',
    event: { candidate: candidate({}), imageFileID: fileID(1) } }
  const unconfigured = await purchase.visualHandle(context, async () => { throw Error('不应调用') }, {})
  assert.equal(unconfigured.visualReview, null)
  const failed = await purchase.visualHandle(context, async () => { throw Error('timeout') }, { AI_API_KEY: 'key' })
  assert.equal(failed.visualReview, null)
  const invalid = await purchase.visualHandle(context, async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'bad' } }] }),
    { AI_API_KEY: 'key' })
  assert.equal(invalid.visualReview, null)

  let release, started
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const first = purchase.visualHandle(context, async () => { started(); return waiting }, { AI_API_KEY: 'key' })
  await entered
  await assert.rejects(purchase.visualHandle(context, async () => visualResponse({ adjust: 0, reason: '无变化' }),
    { AI_API_KEY: 'key' }), /视觉复核中/)
  release(visualResponse({ adjust: 0, reason: '无变化' }))
  assert.equal((await first).visualReview.finalVerdict.code, 'buy')
  assert.ok((await purchase.visualHandle(context, async () => visualResponse({ adjust: 0, reason: '已释放' }),
    { AI_API_KEY: 'key' })).visualReview)
})

test('客户端仅在有照片时异步复核，失败后保留规则结果', async () => {
  const rules = { verdict: { code: 'consider', label: '再考虑' }, reasons: [], duplicateRisk: { label: '中' },
    similarItems: [], matchCount: 0, spending: { monthSpent: 0, afterPurchase: 199 }, truncated: false }
  let visualCalls = 0, removedFileID = ''
  const page = loadPage('assistant', {
    purchaseAssess: async () => rules,
    purchaseVisual: async () => { visualCalls++; throw Error('timeout') },
    removeImage: async fileID => { removedFileID = fileID }
  })
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  page.setData({ purchaseForm: candidate({ category: '衬衫' }) })
  await page.onPurchaseSubmit()
  assert.equal(visualCalls, 0)
  assert.equal(page.data.purchaseResult, rules)

  page.onPurchaseEdit()
  page.setData({ purchaseImagePath: '/tmp/top.jpg', purchaseScanFileID: fileID(1) })
  await page.onPurchaseSubmit()
  assert.equal(page.data.purchaseVisualLoading, true)
  await page._purchaseVisualPromise
  assert.equal(visualCalls, 1)
  assert.equal(page.data.purchaseVisualLoading, false)
  assert.equal(page.data.purchaseVisualReview, null)
  assert.equal(page.data.purchaseResult, rules)

  page.onPurchaseEdit()
  assert.deepEqual(page.data.purchaseForm, candidate({ category: '衬衫' }))
  assert.equal(page.data.purchaseImagePath, '/tmp/top.jpg')
  assert.equal(page.data.purchaseScanFileID, fileID(1))

  await page.onPurchaseRestart()
  assert.equal(JSON.stringify(page.data.purchaseForm), JSON.stringify({
    name: '', category: '', subcategory: '', color: '', seasons: [], occasion: '', price: '', monthlyBudget: '', note: ''
  }))
  assert.equal(page.data.purchaseImagePath, '')
  assert.equal(page.data.purchaseScanFileID, '')
  assert.equal(removedFileID, fileID(1))

  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /AI 视觉复核中/)
  assert.match(markup, /规则基准/)
  assert.match(markup, /purchaseImagePath \|\| purchaseScanFileID/)
  assert.match(markup, /onPurchaseRestart/)
})

test('购买评估拦截一级其他候选，非法类别与配饰子类校验严格', () => {
  assert.throws(() => purchase.validate(candidate({ category: '其他' })), /不参与购买评估/)
  assert.throws(() => purchase.validate(candidate({ category: '上衣' })), /有效分类/)
  assert.throws(() => purchase.validate(candidate({ category: '配饰', subcategory: '' })), /配饰类型/)
  assert.throws(() => purchase.validate(candidate({ category: '配饰', subcategory: '手套' })), /配饰类型/)
  assert.equal(purchase.validate(candidate({ category: '配饰', subcategory: '袜子' })).subcategory, '袜子')
  assert.equal(purchase.validate(candidate({ category: '衬衫', subcategory: '袜子' })).subcategory, '')
})

test('其他衣物计入预算但不参与相似互补与缺口，袜子按细类子类判重，家居服无结构互补', () => {
  const now = new Date('2026-10-07T08:00:00Z')
  const wardrobe = [
    item('misc', { category: '其他', purchaseDate: '2026-10-02', price: 500 }),
    item('socks', { category: '配饰', subcategory: '袜子', name: '蓝袜' }),
    item('hat', { category: '配饰', subcategory: '帽子', name: '蓝帽' }),
    item('pants', { category: '长裤', color: '黑色' })
  ]
  const result = purchase.evaluate(candidate({}), wardrobe, [], [], now)
  assert.equal(result.duplicateRisk.similarCount, 0)
  assert.equal(result.spending.monthSpent, 500)

  const socksResult = purchase.evaluate(candidate({ category: '配饰', subcategory: '袜子' }), wardrobe, [], [], now)
  assert.equal(socksResult.duplicateRisk.similarCount, 1)
  assert.deepEqual(socksResult.similarItems.map(row => row.id), ['socks'])
  assert.equal(socksResult.matchCount, null)

  const homeResult = purchase.evaluate(candidate({ category: '家居服' }), wardrobe, [], [], now)
  assert.equal(homeResult.matchCount, null)
  assert.deepEqual(homeResult.filledGaps, [])
})

test('购买换图识别为其他保留手选类别，重新确认类别前拦截规则及视觉评估', async () => {
  let assessments = 0, visuals = 0
  const page = loadPage('assistant', {
    chooseImage: async () => '/tmp/other.jpg', uploadImage: async () => fileID(2), removeImage: async () => true,
    itemScan: async () => ({ name: '摆件', category: '其他', color: '白色', seasons: ['夏'] }),
    purchaseAssess: async () => { assessments++; return { marker: 'rules' } },
    purchaseVisual: async () => { visuals++; return { marker: 'visual' } }
  })
  page.setData({ activeMode: 'purchase', purchaseForm: candidate({ name: '手选衬衫', category: '衬衫' }), purchaseScanFileID: fileID(1) })
  await page.onPurchaseChooseAlbum()
  assert.equal(page.data.purchaseForm.category, '衬衫')
  assert.equal(page.data.purchaseForm.name, '手选衬衫')
  await page.onPurchaseSubmit()
  await page.startPurchaseVisual(page.data.purchaseForm, fileID(2))
  assert.equal(assessments, 0)
  assert.equal(visuals, 0)
  assert.match(page.data.purchaseError, /其他.*基础记录|基础记录.*其他/)

  page.onPurchaseFieldInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '改名' } })
  page.onPurchaseFieldInput({ currentTarget: { dataset: { field: 'price' } }, detail: { value: '299' } })
  await page.onPurchaseSubmit()
  assert.equal(assessments, 0)
  page.onPurchaseCategoryTap({ currentTarget: { dataset: { value: '其他' } } })
  await page.onPurchaseSubmit()
  assert.equal(assessments, 0)

  page.onPurchaseCategoryTap({ currentTarget: { dataset: { value: '衬衫' } } })
  await page.onPurchaseSubmit()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(assessments, 1)
  assert.equal(visuals, 1)

  page.onPurchaseEdit()
  await page.onPurchaseScanPhoto()
  await page.onPurchaseRestart()
  page.setData({ purchaseForm: candidate({ name: '重新填写' }) })
  await page.onPurchaseSubmit()
  assert.equal(assessments, 2)
})

test('规则评估期间识别为其他后，旧成功和失败均不回填或启动视觉复核', async () => {
  for (const fails of [false, true]) {
    let settle, visuals = 0
    const page = loadPage('assistant', {
      purchaseAssess: () => new Promise((resolve, reject) => { settle = () => fails ? reject(Error('旧评估失败')) : resolve({ marker: 'old' }) }),
      purchaseVisual: async () => { visuals++; return { marker: 'old-visual' } },
      itemScan: async () => ({ category: '其他' })
    })
    page.setData({ activeMode: 'purchase', purchaseForm: candidate({ name: '旧候选' }), purchaseScanFileID: fileID(1) })
    const request = page.onPurchaseSubmit()
    await page.onPurchaseScanPhoto()
    const error = page.data.purchaseError
    assert.match(error, /其他/)
    settle()
    await request
    assert.equal(page.data.purchaseResult, null)
    assert.equal(page.data.purchaseError, error)
    assert.equal(page.data.purchaseAssessing, false)
    assert.equal(page.data.purchaseVisualLoading, false)
    assert.equal(visuals, 0)
  }
})

test('修改条件、识别、换图和离开使旧规则及视觉请求失效，旧失败不影响新请求', async () => {
  const snapshot = page => JSON.stringify([
    page.data.purchaseResult, page.data.purchaseError, page.data.purchaseAssessing,
    page.data.purchaseVisualReview, page.data.purchaseVisualLoading
  ])
  const edit = page => page.onPurchaseFieldInput({ currentTarget: { dataset: { field: 'price' } }, detail: { value: '299' } })
  const actions = [edit, page => page.onPurchaseScanPhoto(), page => page.onPurchaseChooseAlbum(),
    page => page.onHide(), page => page.onPurchaseRestart()]
  for (const phase of ['rules', 'visual']) {
    for (const action of actions) {
      for (const fails of [false, true]) {
        let settle, visuals = 0
        const waiting = new Promise((resolve, reject) => { settle = () => fails ? reject(Error('过时失败')) : resolve({ marker: 'stale' }) })
        const page = loadPage('assistant', {
          chooseImage: async () => '/tmp/new.jpg', uploadImage: async () => fileID(2), removeImage: async () => true,
          itemScan: async () => ({ category: '衬衫' }),
          purchaseAssess: () => waiting,
          purchaseVisual: () => { visuals++; return waiting }
        })
        page.setData({ activeMode: 'purchase', purchaseForm: candidate({ name: '候选' }), purchaseScanFileID: fileID(1) })
        const request = phase === 'rules' ? page.onPurchaseSubmit() : page.startPurchaseVisual(page.data.purchaseForm, fileID(1))
        await action(page)
        const current = snapshot(page)
        settle()
        await request
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(snapshot(page), current, `${phase}/${action.name || 'action'}/${fails}`)
        assert.equal(visuals, phase === 'visual' ? 1 : 0)
      }
    }

    const requests = []
    const pending = () => new Promise((resolve, reject) => requests.push({ resolve, reject }))
    const page = loadPage('assistant', { purchaseAssess: pending, purchaseVisual: pending })
    page.setData({ activeMode: 'purchase', purchaseForm: candidate({ name: '候选' }), purchaseScanFileID: fileID(1) })
    const start = () => phase === 'rules' ? page.onPurchaseSubmit() : page.startPurchaseVisual(page.data.purchaseForm, fileID(1))
    const old = start()
    edit(page)
    const latest = start()
    assert.equal(requests.length, 2)
    const current = snapshot(page)
    requests[0].reject(Error('旧失败'))
    await old
    assert.equal(snapshot(page), current)
    if (phase === 'rules') page.setData({ purchaseScanFileID: '' })
    requests[1].resolve({ marker: 'latest' })
    await latest
    assert.equal((phase === 'rules' ? page.data.purchaseResult : page.data.purchaseVisualReview).marker, 'latest')
  }
})
