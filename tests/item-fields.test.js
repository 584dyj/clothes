const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanScanFields } = require('../utils/item-fields')
const brandSuggestions = require('../utils/brand-suggestions')
const { CATEGORIES, ACCESSORY_TYPES } = require('../cloudfunctions/auth/categories')
const { cleanResult } = require('../cloudfunctions/auth/scan')
const { loadPage, loadComponent } = require('./support/page')
const options = { categories: CATEGORIES, accessoryTypes: ACCESSORY_TYPES, colors: ['黑色', '花色'], seasons: ['春秋', '夏', '冬'] }
const modelResult = raw => cleanResult({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] })
const imageFileID = `cloud://env/wardrobe/${'1'.repeat(32)}.jpg`

test('品牌包含匹配忽略大小写、空白与重复，保留原写法并限制建议数量', () => {
  const brands = [' nike ', 'NIKE', 'adidas', '', null, 'New Balance', '耐克', '耐克']
  assert.deepEqual(brandSuggestions(brands, ' N '), ['nike', 'New Balance'])
  assert.deepEqual(brandSuggestions(brands, 'IK'), ['nike'])
  assert.deepEqual(brandSuggestions(brands, 'ad'), ['adidas'])
  assert.deepEqual(brandSuggestions(brands, '耐'), ['耐克'])
  assert.deepEqual(brandSuggestions(brands, '未知'), [])
  assert.deepEqual(brandSuggestions(brands, '  '), [])
  assert.deepEqual(brandSuggestions(Array.from({ length: 20 }, (_, n) => `brand${n}`), 'brand').length, 8)
})

test('单件输入使用最新文本匹配历史品牌，可选填或保留新品牌，失败与卸载不影响手填', async () => {
  let finish
  const page = loadPage('item-edit', { listBrands: () => new Promise(resolve => { finish = resolve }) })
  await page.onLoad({})
  const pending = page.onBrandFocus({ currentTarget: { dataset: { field: 'brand' } } })
  page.onBrandInput({ detail: { value: 'n' } })
  page.onBrandInput({ detail: { value: 'adi' } })
  finish(['nike', 'adidas'])
  await pending
  assert.deepEqual(Array.from(page.data.brandSuggestions), ['adidas'])
  page.onBrandPick({ currentTarget: { dataset: { brand: 'adidas' } } })
  assert.equal(page.data.brand, 'adidas')
  assert.equal(page.data.brandSuggestions.length, 0)
  page.onBrandInput({ detail: { value: '新品牌' } })
  page.onBrandPick({ currentTarget: { dataset: { brand: '伪造建议' } } })
  assert.equal(page.data.brand, '新品牌')
  assert.equal(page.data.brandSuggestions.length, 0)

  const failed = loadPage('item-edit', { listBrands: async () => { throw Error('offline') } })
  failed.onBrandInput({ detail: { value: '手填品牌' } })
  await failed.onBrandFocus({ currentTarget: { dataset: { field: 'brand' } } })
  assert.equal(failed.data.brand, '手填品牌')
  const late = page.onBrandFocus({ currentTarget: { dataset: { field: 'brand' } } })
  page.onUnload()
  finish(['新品牌'])
  await late
  assert.equal(page.data.brandSuggestions.length, 0)
})

test('批量品牌建议只填入当前卡片，异步返回不覆盖其他卡片或已保存记录', async () => {
  let finish
  const batch = loadComponent('batch-panel', { listBrands: () => new Promise(resolve => { finish = resolve }) })
  await batch.attached()
  batch.setData({ cards: [{ key: 'one', brand: 'n', status: 'pending' }, { key: 'two', brand: 'adi', status: 'pending' }] })
  const pending = batch.onBrandFocus({ currentTarget: { dataset: { key: 'one' } } })
  batch.onInput({ currentTarget: { dataset: { key: 'two', field: 'brand' } }, detail: { value: 'adi' } })
  finish(['nike', 'adidas'])
  await pending
  assert.deepEqual(Array.from(batch.data.brandSuggestions), ['adidas'])
  batch.onBrandPick({ currentTarget: { dataset: { brand: 'adidas' } } })
  assert.equal(batch.card('one').brand, 'n')
  assert.equal(batch.card('two').brand, 'adidas')
  assert.equal(batch.buildPayload(batch.card('two')).brand, 'adidas')
  batch.patchCard('two', { status: 'saved' })
  batch.setData({ brandSuggestions: ['nike'] })
  batch.onBrandPick({ currentTarget: { dataset: { brand: 'nike' } } })
  assert.equal(batch.card('two').brand, 'adidas')
})

test('扫描字段统一接受新枚举，拒绝过时和非法值，并保持源数据', () => {
  for (const category of CATEGORIES) {
    const input = { name: '  衣物  ', category, subcategory: '袜子', color: '黑色', seasons: ['冬', '冬', '未知', '春秋'], brand: '  品牌  ' }
    const before = structuredClone(input)
    assert.deepEqual(cleanScanFields(input, options), {
      name: '衣物', category, subcategory: category === '配饰' ? '袜子' : '', color: '黑色', seasons: ['冬'], brand: '品牌'
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

test('三个录入入口的适合季节均为单选', async () => {
  const single = loadPage('item-edit')
  await single.onLoad({})
  single.onSeasonTap({ currentTarget: { dataset: { value: '春秋' } } })
  single.onSeasonTap({ currentTarget: { dataset: { value: '冬' } } })
  assert.deepEqual(Array.from(single.data.selectedSeasons), ['冬'])

  const batch = loadComponent('batch-panel')
  await batch.attached()
  batch.setData({ cards: [{ key: 'one', seasons: ['春秋'], seasonStates: batch.seasonStates(['春秋']) }] })
  batch.onSeasonTap({ currentTarget: { dataset: { key: 'one', value: '夏' } } })
  assert.deepEqual(Array.from(batch.card('one').seasons), ['夏'])

  const purchase = loadPage('assistant')
  purchase.onPurchaseSeasonTap({ currentTarget: { dataset: { value: '春秋' } } })
  purchase.onPurchaseSeasonTap({ currentTarget: { dataset: { value: '夏' } } })
  assert.deepEqual(Array.from(purchase.data.purchaseForm.seasons), ['夏'])

  const legacy = loadPage('item-edit', { getItem: async () => ({ seasons: ['春秋', '冬'] }) })
  await legacy.onLoad({ id: 'legacy' })
  assert.deepEqual(Array.from(legacy.data.selectedSeasons), ['春秋'])
})

test('服务端识别清洗结果联调三处回填，19类可基础保存，其他及未知类别不能购买评估', async () => {
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
