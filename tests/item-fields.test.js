const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanScanFields } = require('../utils/item-fields')
const { CATEGORIES, ACCESSORY_TYPES } = require('../cloudfunctions/auth/categories')
const { cleanResult } = require('../cloudfunctions/auth/scan')
const { loadPage, loadComponent } = require('./support/page')
const options = { categories: CATEGORIES, accessoryTypes: ACCESSORY_TYPES, colors: ['黑色', '花色'], seasons: ['春秋', '夏', '冬'] }
const modelResult = raw => cleanResult({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] })
const imageFileID = `cloud://env/wardrobe/${'1'.repeat(32)}.jpg`

test('扫描字段统一接受新枚举，拒绝过时和非法值，并保持源数据', () => {
  for (const category of CATEGORIES) {
    const input = { name: '  衣物  ', category, subcategory: '袜子', color: '黑色', seasons: ['冬', '冬', '未知', '春秋'], brand: '  品牌  ' }
    const before = structuredClone(input)
    assert.deepEqual(cleanScanFields(input, options), {
      name: '衣物', category, subcategory: category === '配饰' ? '袜子' : '', color: '黑色', seasons: ['冬', '春秋'], brand: '品牌'
    })
    assert.deepEqual(input, before)
  }
  for (const category of ['上衣', '下装', '包', '袜子', '未知', null]) {
    const result = cleanScanFields({ category, subcategory: '帽子', color: '未知', seasons: '冬', name: 123, brand: {} }, options)
    assert.deepEqual(result, { name: '', category: '', subcategory: '', color: '', seasons: [], brand: '' })
  }
  for (const value of [null, undefined, [], '未知']) {
    assert.deepEqual(cleanScanFields(value, options), { name: '', category: '', subcategory: '', color: '', seasons: [], brand: '' })
  }
  const result = cleanScanFields({ name: '衣'.repeat(100), brand: '牌'.repeat(100), category: '配饰', subcategory: '未知' }, options)
  assert.equal(result.name.length, 60)
  assert.equal(result.brand.length, 30)
  assert.equal(result.subcategory, '')
  assert.equal(cleanScanFields({ category: '配饰', subcategory: '其他' }, options).subcategory, '其他')
})

test('服务端识别清洗结果联调三处回填，18类可基础保存，其他及未知类别不能购买评估', async () => {
  const cases = [...CATEGORIES.map(category => ({ category, subcategory: '袜子' })),
    { category: '配饰', subcategory: '其他' },
    ...['上衣', '下装', '包', '袜子', '未知', ''].map(category => ({ category, subcategory: '袜子' }))]
  for (const raw of cases) {
    const result = modelResult({ name: '识别衣物', color: '黑色', seasons: ['冬'], brand: '识别品牌', ...raw })
    const category = CATEGORIES.includes(raw.category) ? raw.category : ''
    const subcategory = category === '配饰' ? raw.subcategory : ''
    const saved = []
    let assessments = 0, visuals = 0
    const db = {
      itemScan: async () => result, addItem: async data => { saved.push(data); return 'new' }, listItems: async () => [],
      purchaseAssess: async () => { assessments++; return {} }, purchaseVisual: async () => { visuals++; return null }
    }
    const single = loadPage('item-edit', db)
    await single.onLoad({})
    single.setData({ imageFileID, scanFileID: imageFileID })
    await single.onScanPhoto()
    assert.equal(single.data.category, category, raw.category)
    assert.equal(single.data.subcategory, subcategory)
    await single.onSave()
    assert.equal(saved.length, category ? 1 : 0)

    const batch = loadComponent('batch-panel', db)
    await batch.attached()
    batch.setData({ cards: [{ key: 'scan', imageFileID, status: 'pending', name: '', category: '', subcategory: '', color: '', seasons: [], price: '' }] })
    await batch.scanCard('scan')
    assert.equal(batch.card('scan').category, category, raw.category)
    assert.equal(batch.card('scan').subcategory, subcategory)
    await batch.onSaveAll()
    assert.equal(saved.length, category ? 2 : 0)
    for (const item of saved) {
      assert.equal(item.category, category)
      assert.equal(item.subcategory, subcategory)
    }

    const purchase = loadPage('assistant', db)
    purchase.setData({ activeMode: 'purchase', purchaseScanFileID: imageFileID, 'purchaseForm.price': '199' })
    await purchase.onPurchaseScanPhoto()
    assert.equal(purchase.data.purchaseForm.category, category === '其他' ? '' : category)
    assert.equal(purchase.data.purchaseForm.subcategory, subcategory)
    await purchase.onPurchaseSubmit()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(assessments, category && category !== '其他' ? 1 : 0, raw.category)
    assert.equal(visuals, assessments)
  }
})

test('服务端识别结果经过三处回填仍保留手填值，已有类别遇到其他也禁止购买评估', async () => {
  const manual = { name: '手填名称', category: '配饰', subcategory: '帽子', color: '花色', price: '123', note: '手填备注' }
  for (const category of ['外套', '配饰', '其他', '上衣', '未知']) {
    const result = modelResult({ name: '识别名称', category, subcategory: '其他', color: '黑色', seasons: ['冬'], brand: '识别品牌' })
    let assessments = 0
    const db = { itemScan: async () => result, purchaseAssess: async () => { assessments++; return {} }, purchaseVisual: async () => null }
    const single = loadPage('item-edit', db)
    await single.onLoad({})
    single.setData({ ...manual, brand: '手填品牌', selectedSeasons: ['夏'], imageFileID, scanFileID: imageFileID })
    await single.onScanPhoto()
    assert.equal(single.data.brand, '手填品牌')

    const batch = loadComponent('batch-panel', db)
    await batch.attached()
    batch.setData({ cards: [{ key: 'manual', imageFileID, status: 'pending', ...manual, seasons: ['夏'] }] })
    await batch.scanCard('manual')

    const purchase = loadPage('assistant', db)
    purchase.setData({ activeMode: 'purchase', purchaseScanFileID: imageFileID, purchaseForm: { ...manual, seasons: ['夏'], occasion: '', monthlyBudget: '' } })
    await purchase.onPurchaseScanPhoto()
    for (const fields of [single.data, batch.card('manual'), purchase.data.purchaseForm]) {
      for (const [key, value] of Object.entries(manual)) assert.equal(fields[key], value, `${category}/${key}`)
    }
    for (const seasons of [single.data.selectedSeasons, batch.card('manual').seasons, purchase.data.purchaseForm.seasons]) {
      assert.deepEqual(Array.from(seasons), ['夏'])
    }
    await purchase.onPurchaseSubmit()
    assert.equal(assessments, category === '其他' ? 0 : 1)
  }
})
