const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

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
  page.onCategoryTap({ currentTarget: { dataset: { value: '上衣' } } })
  assert.equal(page.data.size, '')
})

test('类别按钮回显已有选择，保持单选并清除不适用的配饰类型', async () => {
  const page = loadPage('item-edit', { getItem: async () => ({ category: '配饰', subcategory: '帽子' }) })
  await page.onLoad({ id: 'item' })
  assert.equal(page.data.category, '配饰')
  const select = value => page.onCategoryTap({ currentTarget: { dataset: { value } } })
  select('配饰')
  assert.equal(page.data.subcategory, '帽子')
  select('上衣')
  assert.equal(page.data.category, '上衣')
  assert.equal(page.data.subcategory, '')
  assert.equal(page.data.subcategoryIndex, -1)
  select('上衣')
  assert.equal(page.data.category, '上衣')
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
