const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')
const { loadCloud } = require('./support/cloud')
const { CATEGORIES, ACCESSORY_TYPES } = require('../cloudfunctions/auth/categories')

// 服装十四类：开放季节筛选的类别（与 category 页常量保持一致）
const SEASON_CATEGORIES = ['外套', '马甲', '短袖', '长袖', '衬衫', '羽绒服', '保暖衣', '毛衣', '家居服', '连衣裙', '长裙', '短裙', '长裤', '短裤']

test('衣橱首页按 19 类固定顺序分组，空类别保留且每类最近 5 件，挂件连衣裙与其他正常分组', async () => {
  const items = [
    { _id: 'charm', name: '玩偶', category: '挂件' },
    { _id: 'dress', name: '连体裙', category: '连衣裙' },
    { _id: 'misc', name: '摆件', category: '其他' },
    { _id: 'socks', name: '棉袜', category: '配饰', subcategory: '袜子' },
    ...Array.from({ length: 7 }, (_, index) => ({ _id: `shirt-${index}`, name: `衬衫${index}`, category: '衬衫' }))
  ]
  const page = loadPage('wardrobe', { listItems: async () => items })
  page.onLoad()
  await page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.mode, 'group')
  assert.deepEqual(Array.from(page.data.sections.map(section => section.category)), CATEGORIES)
  const section = category => page.data.sections.find(row => row.category === category)
  assert.equal(section('衬衫').total, 7)
  assert.equal(section('衬衫').list.length, 5)
  assert.equal(section('挂件').total, 1)
  assert.equal(section('连衣裙').total, 1)
  assert.equal(section('其他').total, 1)
  assert.equal(section('配饰').total, 1)
  assert.equal(section('配饰').list[0].subcategory, '袜子')
  assert.equal(section('长裤').total, 0)
  assert.deepEqual(Array.from(section('长裤').list), [])
})

test('衣橱筛选模式按新类别与搜索词过滤', async () => {
  const items = [
    { _id: 'shirt', name: '白衬衫', category: '衬衫' },
    { _id: 'bag', name: '帆布包袋', category: '包袋' },
    { _id: 'misc', name: '摆件', category: '其他' }
  ]
  const page = loadPage('wardrobe', { listItems: async () => items })
  page.onLoad()
  await page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  page.setData({ filterCategories: ['包袋'] })
  page.applyView()
  assert.equal(page.data.mode, 'filter')
  assert.deepEqual(Array.from(page.data.filtered.map(item => item._id)), ['bag'])
  page.setData({ filterCategories: [], keyword: '摆件' })
  page.applyView()
  assert.deepEqual(Array.from(page.data.filtered.map(item => item._id)), ['misc'])
})

test('类别详情页仅服装十四类显示季节筛选，配饰显示全部子类筛选，其余类别均无', async () => {
  for (const category of CATEGORIES) {
    const page = loadPage('category', { listItems: async () => [] })
    await page.onLoad({ category })
    assert.equal(page.data.showSeasonFilter, SEASON_CATEGORIES.includes(category), category)
    assert.equal(page.data.showSubFilter, category === '配饰', category)
    if (category === '配饰') assert.deepEqual(Array.from(page.data.subChips.map(chip => chip.value)), ACCESSORY_TYPES)
  }
})

test('类别详情页季节与子类筛选过滤正确，现有挂件与连衣裙可查看', async () => {
  const items = [
    { _id: 'summer', name: '夏季长裤', category: '长裤', seasons: ['夏'] },
    { _id: 'winter', name: '冬季长裤', category: '长裤', seasons: ['冬'] }
  ]
  const pants = loadPage('category', { listItems: async () => items })
  await pants.onLoad({ category: '长裤' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pants.data.items.length, 2)
  pants.onSeasonTap({ currentTarget: { dataset: { value: '夏' } } })
  assert.deepEqual(Array.from(pants.data.items.map(item => item._id)), ['summer'])

  const accessories = loadPage('category', { listItems: async () => [
    { _id: 'socks', name: '棉袜', category: '配饰', subcategory: '袜子' },
    { _id: 'hat', name: '棒球帽', category: '配饰', subcategory: '帽子' }
  ] })
  await accessories.onLoad({ category: '配饰' })
  await new Promise(resolve => setImmediate(resolve))
  accessories.onSubTap({ currentTarget: { dataset: { value: '袜子' } } })
  assert.deepEqual(Array.from(accessories.data.items.map(item => item._id)), ['socks'])

  const kept = loadPage('category', { listItems: async () => [
    { _id: 'charm', name: '玩偶', category: '挂件' }, { _id: 'dress', name: '连体裙', category: '连衣裙' }
  ] })
  await kept.onLoad({ category: '挂件' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(Array.from(kept.data.items.map(item => item._id)), ['charm'])
  assert.equal(kept.data.showSeasonFilter, false)
  assert.equal(kept.data.showSubFilter, false)
})

test('单件页面按固定顺序手选全部 19 类并实际保存，袜子保留配饰子类', async () => {
  const cloud = loadCloud({ users: [{ _id: 'user', openid: 'openid-1' }] })
  for (const category of CATEGORIES) {
    const page = loadPage('item-edit', { addItem: async data => {
      const result = await cloud.main({ action: 'data', collection: 'clothes', operation: 'add', data })
      assert.equal(result.success, true, result.error)
      return result._id
    } })
    await page.onLoad({})
    assert.deepEqual(Array.from(page.data.categories), CATEGORIES)
    page.onNameInput({ detail: { value: `手填${category}` } })
    page.onCategoryTap({ currentTarget: { dataset: { value: category } } })
    if (category === '配饰') {
      page.openPicker({ currentTarget: { dataset: { target: 'subcategory' } } })
      page.onPickerConfirm({ detail: { values: [0] } })
    }
    await page.onSave()
    const saved = cloud.records.clothes.at(-1)
    assert.equal(saved.category, category)
    assert.equal(saved.subcategory, category === '配饰' ? '袜子' : '')
    assert.equal(saved.name, `手填${category}`)
  }
  assert.equal(cloud.records.clothes.length, CATEGORIES.length)
})

test('历史非法类别与不适用子类不进入编辑选值，其余字段保持', async () => {
  for (const [category, subcategory, expectedCategory] of [
    ['上衣', '帽子', ''], ['衬衫', '帽子', '衬衫'], ['配饰', '手套', '配饰']
  ]) {
    const page = loadPage('item-edit', { getItem: async () => ({
      category, subcategory, name: '历史名称', size: 'XL', price: 88, imageFileID: 'cloud://history'
    }) })
    await page.onLoad({ id: 'old' })
    assert.equal(page.data.category, expectedCategory)
    assert.equal(page.data.subcategory, '')
    assert.equal(page.data.subcategoryIndex, -1)
    assert.equal(page.data.name, '历史名称')
    assert.equal(page.data.size, 'XL')
    assert.equal(page.data.price, '88')
    assert.equal(page.data.imageFileID, 'cloud://history')
  }
})

test('保存前拒绝过时类别及非法配饰子类，五个合法子类均可选择保存', async () => {
  const saved = []
  let uploads = 0
  const page = loadPage('item-edit', {
    addItem: async data => { saved.push(data) },
    uploadImage: async () => { uploads++; return 'cloud://photo' }
  })
  await page.onLoad({})
  for (const [category, subcategory] of [['上衣', ''], ['下装', ''], ['包', ''], ['配饰', ''], ['配饰', '手套']]) {
    page.setData({ category, subcategory, name: '手填名称', imagePath: '/tmp/photo.jpg' })
    await page.onSave()
  }
  assert.equal(saved.length, 0)
  assert.equal(uploads, 0)
  page.setData({ category: '配饰', imagePath: '' })
  for (let index = 0; index < page.data.accessoryTypes.length; index++) {
    page.setData({ saving: false })
    page.openPicker({ currentTarget: { dataset: { target: 'subcategory' } } })
    page.onPickerConfirm({ detail: { values: [index] } })
    await page.onSave()
    assert.equal(saved.at(-1).subcategory, page.data.accessoryTypes[index])
  }
  assert.equal(saved.length, 5)
})

test('尺码按钮提供 XS 至 XL 及 F，忽略旧尺码记忆并保留已有记录', async () => {
  const page = loadPage('item-edit', {}, { getStorageSync: () => 'XXL' })
  await page.onLoad({})
  assert.deepEqual(Array.from(page.data.sizes), ['XS', 'S', 'M', 'L', 'XL', 'F'])
  assert.equal(page.data.size, '')
  for (const size of ['XS', 'XL', 'F']) {
    page.onSizeTap({ currentTarget: { dataset: { value: size } } })
    assert.equal(page.data.size, size)
  }
  assert.equal(page.data.picker.show, false)
  const remembered = loadPage('item-edit', {}, { getStorageSync: () => 'M' })
  await remembered.onLoad({})
  assert.equal(remembered.data.size, 'M')
  const existing = loadPage('item-edit', { getItem: async () => ({ size: 'XXL' }) })
  await existing.onLoad({ id: 'old' })
  assert.equal(existing.data.size, 'XXL')
})

test('鞋类使用 30 至 50 的鞋码滚轮，切换衣物类别时清除不适用尺码', async () => {
  const page = loadPage('item-edit', {}, { getStorageSync: () => 'M' })
  await page.onLoad({})
  assert.equal(page.data.size, 'M')
  page.onCategoryTap({ currentTarget: { dataset: { value: '鞋' } } })
  assert.equal(page.data.size, '')
  page.openPicker({ currentTarget: { dataset: { target: 'shoeSize' } } })
  assert.deepEqual(Array.from(page.data.picker.columns[0]), Array.from({ length: 21 }, (_, index) => String(index + 30)))
  assert.equal(page.data.picker.values[0], 7)
  page.onPickerConfirm({ detail: { values: [12] } })
  assert.equal(page.data.size, '42')
  page.onCategoryTap({ currentTarget: { dataset: { value: '衬衫' } } })
  assert.equal(page.data.size, '')
})

test('类别按钮回显已有选择，保持单选并清除不适用的配饰类型', async () => {
  const page = loadPage('item-edit', { getItem: async () => ({ category: '配饰', subcategory: '帽子' }) })
  await page.onLoad({ id: 'item' })
  assert.equal(page.data.category, '配饰')
  const select = value => page.onCategoryTap({ currentTarget: { dataset: { value } } })
  select('配饰')
  assert.equal(page.data.subcategory, '帽子')
  select('衬衫')
  assert.equal(page.data.category, '衬衫')
  assert.equal(page.data.subcategory, '')
  assert.equal(page.data.subcategoryIndex, -1)
  select('衬衫')
  assert.equal(page.data.category, '衬衫')
  assert.equal(page.data.picker.show, false)
})

test('颜色确认后可再次修改，购买日期可通过滚轮确认', async () => {
  const page = loadPage('item-edit')
  await page.onLoad({})

  page.openPicker({ currentTarget: { dataset: { target: 'color' } } })
  const blue = page.data.colorOptions.indexOf('蓝色')
  page.onPickerConfirm({ detail: { values: [blue] } })
  assert.equal(page.data.color, '蓝色')

  page.openPicker({ currentTarget: { dataset: { target: 'color' } } })
  assert.equal(page.data.picker.show, true)
  assert.equal(page.data.picker.values[0], blue)
  const black = page.data.colorOptions.indexOf('黑色')
  page.onPickerConfirm({ detail: { values: [black] } })
  assert.equal(page.data.color, '黑色')

  page.openPicker({ currentTarget: { dataset: { target: 'date' } } })
  const columns = page.data.picker.columns
  page.onPickerConfirm({ detail: { values: [columns[0].indexOf('2026'), columns[1].indexOf('10'), columns[2].indexOf('09')] } })
  assert.equal(page.data.purchaseDate, '2026-10-09')
})
