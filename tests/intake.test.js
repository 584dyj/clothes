const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage, loadComponent } = require('./support/page')
const { loadCloud } = require('./support/cloud')
const event = (key, value) => ({ currentTarget: { dataset: { key, value } } })
const card = (key, patch = {}) => ({ key, status: 'pending', name: key, category: '衬衫', size: 'M',
  imageFileID: '', brand: '原品牌', seasons: ['春秋'], price: '0', ...patch })
const form = patch => ({ name: '新衣物', category: '衬衫', subcategory: '', size: 'M', color: '白色',
  brand: '品牌', selectedSeasons: ['夏'], price: '0', purchaseDate: '2026-10-01', note: '备注', ...patch })
function client(cloud, intercept = async result => result) {
  global.wx = { cloud: { callFunction: async ({ data }) => ({ result: await intercept(await cloud.main(data), data) }) } }
  delete require.cache[require.resolve('../utils/db')]
  return require('../utils/db')
}

test('批量设置只更新所选品牌和季节，取消、全选及保存隔离均保持范围', async () => {
  const batch = loadComponent('batch-panel')
  await batch.attached()
  batch.setData({ cards: [card('a'), card('b'), card('saved', { status: 'saved' })] })
  batch.onBulkToggle()
  assert.equal(batch.data.bulkSelectedCount, 0)
  batch.onBulkSelect(event('a'))
  batch.onBulkSelect(event('saved'))
  assert.equal(batch.data.bulkSelectedCount, 1)
  batch.onBulkBrandInput({ detail: { value: ' nike ' } })
  batch.onBulkSeasonTap(event('', '冬'))
  batch.onBulkApply()
  assert.equal(batch.card('a').brand, 'nike')
  assert.deepEqual(Array.from(batch.card('a').seasons), ['冬'])
  assert.equal(batch.card('a').price, '0')
  assert.equal(batch.card('a').size, 'M')
  for (const key of ['b', 'saved']) assert.equal(batch.card(key).brand, '原品牌')
  assert.equal(batch.data.bulkOpen, false)
  batch.onBulkToggle()
  batch.onBulkSelectAll()
  assert.equal(batch.data.bulkSelectedCount, 2)
  batch.onBulkSeasonTap(event('', '夏'))
  batch.onBulkToggle()
  assert.deepEqual(Array.from(batch.card('a').seasons), ['冬'])
  assert.deepEqual(Array.from(batch.card('b').seasons), ['春秋'])
  batch.onBulkToggle(); batch.onBulkSelectAll()
  batch.onBulkSeasonTap(event('', '夏')); batch.onBulkApply()
  assert.equal(batch.card('a').brand, 'nike')
  assert.equal(batch.card('b').brand, '原品牌')
  assert.deepEqual(Array.from(batch.card('b').seasons), ['夏'])
})

test('批量设置复用品牌建议，识别重试保留人工品牌季节，忙时不应用、不保存', async () => {
  const batch = loadComponent('batch-panel', { listBrands: async () => ['nike', 'adidas'],
    itemScan: async () => ({ name: 'AI名称', category: '衬衫', brand: 'AI品牌', seasons: ['冬'] }) })
  await batch.attached()
  batch.setData({ cards: [card('a', { imageFileID: 'cloud://a', status: 'failed', failStage: 'scan' })] })
  batch.onBulkToggle(); batch.onBulkSelectAll()
  batch.onBulkBrandInput({ detail: { value: 'ni' } })
  await batch.onBrandFocus(event('bulk'))
  batch.onBrandPick({ currentTarget: { dataset: { brand: 'nike' } } })
  assert.equal(batch.data.bulkBrand, 'nike')
  batch.onBulkSeasonTap(event('', '夏'))
  for (const busy of ['processing', 'saving']) {
    batch.setData({ [busy]: true }); batch.onBulkApply()
    assert.equal(batch.card('a').brand, '原品牌')
    batch.setData({ [busy]: false })
  }
  await batch.onSaveAll()
  assert.equal(batch.card('a').status, 'failed')
  batch.onBulkApply()
  await batch.onRetryScan(event('a'))
  assert.equal(batch.card('a').brand, 'nike')
  assert.deepEqual(Array.from(batch.card('a').seasons), ['夏'])
})

test('批量选择随移除重算，全部移除后退出设置，允许重新选图', async () => {
  const batch = loadComponent('batch-panel')
  await batch.attached()
  batch.setData({ cards: [card('a'), card('b')] })
  batch.onBulkToggle(); batch.onBulkSelectAll()
  await batch.onRemoveCard(event('a'))
  assert.equal(batch.data.bulkSelectedCount, 1)
  await batch.onRemoveCard(event('b'))
  assert.equal(batch.data.bulkOpen, false)
  assert.equal(batch.data.remainingSlots, 9)
})

test('保存并继续仅在成功后清空单件信息，保留尺码且下一件使用新的保存请求', async () => {
  const saved = [], removed = [], navigation = [], scroll = []
  const page = loadPage('item-edit', { addItem: async (data, requestId) => { saved.push({ data, requestId }); return 'new' },
    removeImage: async id => removed.push(id) }, {
    navigateBack: () => navigation.push('back'), pageScrollTo: options => scroll.push(options.scrollTop)
  })
  await page.onLoad({})
  page.setData(form({ imageFileID: 'cloud://first', scanFileID: 'cloud://first' }))
  await page.onSaveAndContinue()
  assert.equal(saved[0].data.price, 0)
  for (const field of ['name', 'category', 'subcategory', 'color', 'brand', 'price', 'purchaseDate', 'note', 'imagePath', 'imageFileID', 'scanFileID']) assert.equal(page.data[field], '')
  assert.equal(page.data.size, 'M')
  assert.equal(page.data.selectedSeasons.length, 0)
  assert.equal(page.data.saving, false)
  assert.equal(page.data.seasonStates.every(season => !season.active), true)
  assert.deepEqual(scroll, [0])
  assert.deepEqual(navigation, [])
  page.setData(form({ name: '第二件', imageFileID: 'cloud://second', scanFileID: 'cloud://second' }))
  await page.onSaveAndContinue()
  assert.notEqual(saved[0].requestId, saved[1].requestId)
  page.setData({ scanFileID: 'cloud://third' })
  page.onUnload()
  assert.deepEqual(removed, ['cloud://third'])
})

test('保存并继续阻止连点，上传失败保留表单，编辑页保持原有保存路径', async () => {
  let writes = 0, finish
  const page = loadPage('item-edit', { addItem: async () => { writes++; await new Promise(resolve => { finish = resolve }) } })
  await page.onLoad({}); page.setData(form({}))
  const pending = page.onSaveAndContinue()
  await page.onSaveAndContinue(); await page.onSave()
  assert.equal(writes, 1)
  assert.equal(page.data.name, '新衣物')
  finish(); await pending
  const failed = loadPage('item-edit', { uploadImage: async () => { throw Error('offline') } })
  await failed.onLoad({}); failed.setData(form({ imagePath: '/local/a.jpg' }))
  await failed.onSaveAndContinue()
  assert.equal(failed.data.imagePath, '/local/a.jpg')
  assert.equal(failed.data.price, '0')
  assert.equal(failed.data.name, '新衣物')
  assert.equal(failed.data.saving, false)
  let updates = 0
  const edit = loadPage('item-edit', { getItem: async () => ({ ...form({}), seasons: ['夏'] }), updateItem: async () => { updates++; return {} } })
  await edit.onLoad({ id: 'existing' })
  await edit.onSaveAndContinue(); assert.equal(updates, 0)
  await edit.onSave(); assert.equal(updates, 1)
})

test('连续添加按用户选择沿用品牌季节，价格日期不沿用，取消选择或重新进入即不复用', async () => {
  const stored = []
  const page = loadPage('item-edit', { addItem: async () => 'new', uploadImage: async () => 'cloud://new',
    itemScan: async () => ({ name: '下一件', category: '长裤', color: '黑色', brand: '识别品牌', seasons: ['冬'] }) },
  { setStorageSync: key => stored.push(key) })
  await page.onLoad({})
  assert.equal(page.data.reuseBrand, false)
  page.onReuseFieldsChange({ detail: { value: ['brand', 'season'] } })
  page.setData(form({}))
  await page.onSaveAndContinue()
  assert.equal(page.data.brand, '品牌')
  assert.deepEqual(Array.from(page.data.selectedSeasons), ['夏'])
  assert.equal(page.data.price, '')
  assert.equal(page.data.purchaseDate, '')
  assert.equal(page.data.note, '')
  assert.equal(page.data.name, '')
  page.setData({ imagePath: '/next.jpg' })
  await page.onScanPhoto()
  assert.equal(page.data.brand, '品牌')
  assert.deepEqual(Array.from(page.data.selectedSeasons), ['夏'])
  assert.equal(page.data.name, '下一件')
  page.onReuseFieldsChange({ detail: { value: [] } })
  await page.onSaveAndContinue()
  assert.equal(page.data.brand, '')
  assert.equal(page.data.selectedSeasons.length, 0)
  assert.equal(stored.every(key => key === 'lastSize'), true)
  const reopened = loadPage('item-edit')
  await reopened.onLoad({})
  assert.equal(reopened.data.reuseBrand, false)
  assert.equal(reopened.data.reuseSeason, false)
})

test('单件上传后的响应丢失重试复用图片及回执，既有记录不覆盖、不重复', async () => {
  const id = 'a'.repeat(32), fileID = `cloud://env/wardrobe/${id}.jpg`
  const cloud = loadCloud({ users: [{ _id: 'u', openid: 'openid-1' }],
    upload_tickets: [{ _id: id, _openid: 'openid-1', cloudPath: `wardrobe/${id}.jpg` }] })
  let lost = false, uploads = 0
  const db = client(cloud, async (result, event) => {
    if (event.operation === 'add' && result.success && !lost) { lost = true; throw Error('response lost') }
    return result
  })
  const page = loadPage('item-edit', { ...db, uploadImage: async () => { uploads++; return fileID } })
  await page.onLoad({}); page.setData(form({ imagePath: '/local/a.jpg' }))
  await page.onSaveAndContinue()
  assert.equal(page.data.name, '新衣物')
  assert.equal(page.data.scanFileID, fileID)
  assert.equal(cloud.records.clothes.length, 1)
  const requestId = page._createRequestId, original = structuredClone(cloud.records.clothes[0])
  await page.onSaveAndContinue()
  assert.equal(cloud.records.clothes.length, 1)
  assert.equal(uploads, 1)
  assert.equal(page.data.name, '')
  assert.equal(cloud.records.upload_tickets[0].cancelled, undefined)
  const record = cloud.records.clothes[0], receipt = cloud.records.wardrobe_meta.find(row => row.recordId === record._id)
  record.note = '其他设备更新'
  const changed = await cloud.main({ action: 'data', collection: 'clothes', operation: 'add', requestId, data: original })
  assert.match(changed.error, /已修改/)
  assert.equal(record.note, '其他设备更新')
  assert.equal(cloud.records.clothes.length, 1)
  assert.ok(receipt)
})

test('批量保存响应丢失后逐卡重试复用回执，保留未保存卡片', async () => {
  const id = 'b'.repeat(32), fileID = `cloud://env/wardrobe/${id}.jpg`
  const cloud = loadCloud({ users: [{ _id: 'u', openid: 'openid-1' }],
    upload_tickets: [{ _id: id, _openid: 'openid-1', cloudPath: `wardrobe/${id}.jpg` }] })
  let lost = false
  const db = client(cloud, async (result, event) => {
    if (event.operation === 'add' && result.success && !lost) { lost = true; throw Error('response lost') }
    return result
  })
  const batch = loadComponent('batch-panel', db)
  await batch.attached(); batch.setData({ cards: [card('a', { imageFileID: fileID })] })
  await batch.onSaveAll()
  assert.equal(cloud.records.clothes.length, 1)
  assert.equal(batch.card('a').status, 'failed')
  await batch.onRetrySave(event('a'))
  assert.equal(cloud.records.clothes.length, 1)
  assert.equal(batch.data.cards.length, 0)
})
