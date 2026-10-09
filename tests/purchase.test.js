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

test('购买评估选图后自动识别，仅填空字段并清理图片', async () => {
  const calls = [], toasts = []
  const page = loadPage('assistant', {
    chooseImage: async sourceType => { calls.push(['choose', ...sourceType]); return '/tmp/top.jpg' },
    uploadImage: async path => { calls.push(['upload', path]); return 'cloud://env/wardrobe/top.jpg' },
    itemScan: async fileID => {
      calls.push(['scan', fileID])
      return { name: '白衬衫', category: '上衣', subcategory: '', color: '白色', seasons: ['夏'], brand: '不应填入' }
    },
    removeImage: async fileID => { calls.push(['remove', fileID]); return true }
  }, { showToast: options => toasts.push(options.title) })
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  page.setData({ 'purchaseForm.name': '已有名称', 'purchaseForm.color': '蓝色', 'purchaseForm.price': '199',
    'purchaseForm.note': '保留备注' })

  await page.onPurchaseTakePhoto()

  assert.deepEqual(calls, [
    ['choose', 'camera'], ['upload', '/tmp/top.jpg'], ['scan', 'cloud://env/wardrobe/top.jpg'], ['remove', 'cloud://env/wardrobe/top.jpg']
  ])
  assert.equal(page.data.purchaseForm.name, '已有名称')
  assert.equal(page.data.purchaseForm.category, '上衣')
  assert.equal(page.data.purchaseForm.color, '蓝色')
  assert.deepEqual(Array.from(page.data.purchaseForm.seasons), ['夏'])
  assert.equal(page.data.purchaseForm.price, '199')
  assert.equal(page.data.purchaseForm.note, '保留备注')
  assert.equal(Object.hasOwn(page.data.purchaseForm, 'brand'), false)
  assert.equal(page.data.purchaseImagePath, '')
  assert.equal(page.data.purchaseScanFileID, '')
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
  assert.deepEqual(removed, ['cloud://env/wardrobe/shoe.jpg'])
  assert.equal(page.data.purchaseForm.category, '鞋')

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
