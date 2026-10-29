const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage, loadComponent } = require('./support/page')
const db = require('../utils/db')
const event = key => ({ currentTarget: { dataset: { key } } })

test('裁剪入口通过事件通道传递本地或云图片，确认、取消与打开失败正确返回', async () => {
  const calls = []
  global.wx = { navigateTo: options => {
    assert.equal(options.url, '/pages/image-edit/image-edit')
    options.success({ eventChannel: { emit: (name, data) => { calls.push([name, data.path]); options.events.imageEdited({ path: '/edited.jpg' }) } } })
  } }
  assert.equal(await db.editImage('/local.jpg'), '/edited.jpg')
  assert.equal(await db.editImage('cloud://photo'), '/edited.jpg')
  assert.deepEqual(calls, [['imageSource', '/local.jpg'], ['imageSource', 'cloud://photo']])
  global.wx.navigateTo = options => options.events.imageEditCancelled()
  await assert.rejects(db.editImage('/local.jpg'), /cancel/)
  global.wx.navigateTo = options => options.fail({ errMsg: 'navigation failed' })
  await assert.rejects(db.editImage('/local.jpg'), error => /navigation/.test(error.errMsg))
})

test('单件编辑已上传图片后改用新图识别保存，原表单保留，未提交旧票据被回收', async () => {
  const removed = [], uploads = [], saved = []
  const page = loadPage('item-edit', {
    editImage: async path => { assert.equal(path, 'cloud://old'); return '/edited.jpg' },
    uploadImage: async path => { uploads.push(path); return 'cloud://edited' },
    removeImage: async id => removed.push(id),
    itemScan: async id => { assert.equal(id, 'cloud://edited'); return { name: 'AI名称', category: '短袖' } },
    addItem: async data => saved.push(data)
  })
  await page.onLoad({})
  page.setData({ name: '手填名称', category: '衬衫', brand: '手填品牌', selectedSeasons: ['夏'], price: '0',
    imageFileID: 'cloud://old', scanFileID: 'cloud://old' })
  await page.onEditImage()
  assert.equal(page.data.imagePath, '/edited.jpg')
  assert.equal(page.data.imageFileID, '')
  assert.equal(page.data.scanFileID, '')
  assert.equal(page.data.price, '0')
  assert.deepEqual(removed, ['cloud://old'])
  await page.onScanPhoto()
  assert.equal(page.data.name, '手填名称')
  assert.equal(page.data.brand, '手填品牌')
  await page.onSave()
  assert.deepEqual(uploads, ['/edited.jpg'])
  assert.equal(saved[0].imageFileID, 'cloud://edited')
})

test('编辑取消或失败保留原图和表单，已有衣物的旧图保留到保存时处理', async () => {
  const removed = [], toasts = []
  let outcome = 'cancel'
  const page = loadPage('item-edit', { getItem: async () => ({ name: '旧衣', category: '衬衫', seasons: [], imageFileID: 'cloud://saved' }),
    editImage: async () => {
      if (outcome === 'cancel') throw { errMsg: 'editImage:fail cancel' }
      if (outcome === 'failed') throw Error('failed')
      return '/edited.jpg'
    }, removeImage: async id => removed.push(id) }, { showToast: options => toasts.push(options.title) })
  await page.onLoad({ id: 'old' })
  await page.onEditImage()
  assert.equal(page.data.imageFileID, 'cloud://saved')
  assert.equal(page.data.imagePath, '')
  assert.equal(toasts.length, 0)
  outcome = 'failed'; await page.onEditImage()
  assert.equal(page.data.imagePath, '')
  assert.equal(page.data.editingImage, false)
  outcome = 'success'; await page.onEditImage()
  assert.equal(page.data.imagePath, '/edited.jpg')
  assert.equal(page.data.imageFileID, 'cloud://saved')
  assert.equal(page.data.name, '旧衣')
  assert.deepEqual(removed, [])
})

test('编辑在途阻止保存、换图和识别，离开后回调不改写页面', async () => {
  let finish, writes = 0, chooses = 0, scans = 0
  const page = loadPage('item-edit', { editImage: () => new Promise(resolve => { finish = resolve }),
    addItem: async () => { writes++ }, chooseImage: async () => { chooses++ }, itemScan: async () => { scans++ } })
  await page.onLoad({})
  page.setData({ name: '衣物', category: '衬衫', imagePath: '/original.jpg' })
  const pending = page.onEditImage()
  await page.onSaveAndContinue(); await page.onChooseImage(); await page.onScanPhoto()
  assert.equal(writes + chooses + scans, 0)
  page.onUnload(); finish('/edited.jpg'); await pending
  assert.equal(page.data.imagePath, '/original.jpg')
})

test('批量编辑后重新上传识别，仅更新目标图片并保留人工公共字段和请求标识', async () => {
  const removed = [], uploaded = [], saved = []
  const batch = loadComponent('batch-panel', {
    editImage: async source => { assert.equal(source, '/original.jpg'); return '/edited.jpg' },
    uploadImage: async source => { uploaded.push(source); return 'cloud://edited' },
    itemScan: async () => ({ name: 'AI名称', category: '短袖', brand: 'AI品牌', seasons: ['冬'] }),
    removeImage: async id => removed.push(id), addItem: async data => saved.push(data), listItems: async () => []
  })
  await batch.attached()
  batch.setData({ cards: [{ key: 'a', status: 'pending', name: '手填名称', category: '衬衫', seasons: ['夏'],
    brand: '手填品牌', price: '0', imagePath: '/original.jpg', imageFileID: 'cloud://old', requestId: 'existing-request' },
  { key: 'b', status: 'pending', name: '', imagePath: '/b.jpg' }] })
  await batch.onEditImage(event('a'))
  assert.deepEqual(removed, ['cloud://old'])
  assert.deepEqual(uploaded, ['/edited.jpg'])
  assert.equal(batch.card('a').imageFileID, 'cloud://edited')
  assert.equal(batch.card('a').brand, '手填品牌')
  assert.deepEqual(Array.from(batch.card('a').seasons), ['夏'])
  assert.equal(batch.card('a').requestId, 'existing-request')
  assert.equal(batch.card('b').imagePath, '/b.jpg')
  await batch.onRetrySave(event('a'))
  assert.equal(saved[0].imageFileID, 'cloud://edited')
})

test('批量编辑取消、并发或卸载均不丢原图，取消后可以继续保存', async () => {
  const removed = []
  let finish
  const batch = loadComponent('batch-panel', { editImage: () => new Promise(resolve => { finish = resolve }),
    removeImage: async id => removed.push(id) })
  await batch.attached()
  batch.setData({ cards: [{ key: 'a', status: 'pending', name: 'a', category: '衬衫', imageFileID: 'cloud://old' }] })
  const pending = batch.onEditImage(event('a'))
  await batch.onRemoveCard(event('a')); await batch.onSaveAll()
  assert.equal(batch.data.cards.length, 1)
  await batch.detached(); finish('/edited.jpg'); await pending
  assert.equal(batch.card('a').imageFileID, 'cloud://old')
  assert.deepEqual(removed, ['cloud://old'])
  const cancelled = loadComponent('batch-panel', { editImage: async () => { throw { errMsg: 'editImage:fail cancel' } } })
  await cancelled.attached()
  cancelled.setData({ cards: [{ key: 'a', status: 'pending', name: 'a', category: '衬衫', imageFileID: 'cloud://old' }] })
  await cancelled.onEditImage(event('a'))
  assert.equal(cancelled.card('a').imageFileID, 'cloud://old')
  assert.equal(cancelled.data.processing, false)
})
