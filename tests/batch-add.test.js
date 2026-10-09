const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadPage, loadComponent } = require('./support/page')

test('F5 串行识别、逐卡校验保存并清理未入库图片', async () => {
  const order = []
  const removed = []
  const savedPayloads = []
  const files = ['/tmp/a.jpg', '/tmp/b.jpg', '/tmp/c.jpg']
  let chooseCount, addCalls = 0, refreshed = false
  const page = loadComponent('batch-panel', {
    uploadImage: async file => {
      order.push(`upload:${file}`)
      await new Promise(resolve => setImmediate(resolve))
      return `cloud://${path.basename(file)}`
    },
    itemScan: async fileID => {
      order.push(`scan:${fileID}`)
      await new Promise(resolve => setImmediate(resolve))
      return { name: `衣物${fileID.at(-5)}`, category: '上衣', color: '白色', seasons: ['春秋'] }
    },
    addItem: async payload => {
      savedPayloads.push(payload)
      addCalls++
      if (addCalls === 1) throw Error('首件保存失败')
    },
    listItems: async force => { refreshed = force },
    removeImage: async fileID => { removed.push(fileID) }
  }, {
    chooseMedia(options) {
      chooseCount = options.count
      options.success({ tempFiles: files.map(tempFilePath => ({ tempFilePath })) })
    }
  })

  await page.attached()
  await page.onChooseImages()
  assert.equal(chooseCount, 9)
  assert.deepEqual(order, [
    'upload:/tmp/a.jpg', 'scan:cloud://a.jpg',
    'upload:/tmp/b.jpg', 'scan:cloud://b.jpg',
    'upload:/tmp/c.jpg', 'scan:cloud://c.jpg'
  ])
  assert.deepEqual(page.data.cards.map(card => card.status), ['pending', 'pending', 'pending'])

  const [first, second, third] = page.data.cards
  page.patchCard(second.key, { category: '配饰', subcategory: '' })
  page.patchCard(third.key, { price: '', size: 'M' })
  await page.onSaveAll()

  assert.equal(savedPayloads.length, 2)
  assert.equal(savedPayloads[0].imageFileID, first.imageFileID)
  assert.equal(savedPayloads[1].imageFileID, third.imageFileID)
  assert.equal(savedPayloads[1].price, 0)
  assert.equal(savedPayloads[1].size, 'M')
  assert.equal(page.card(first.key).status, 'failed')
  assert.equal(page.card(first.key).failStage, 'save')
  assert.equal(page.card(second.key).status, 'pending')
  assert.equal(page.card(second.key).error, '请选择配饰类型')
  // 已入库卡片保存后自动移除，不再占位
  assert.equal(page.card(third.key), undefined)
  assert.deepEqual(page.data.cards.map(card => card.key), [first.key, second.key])
  assert.equal(refreshed, true)

  page.openPicker({ currentTarget: { dataset: { key: first.key, target: 'shoeSize' } } })
  assert.deepEqual(Array.from(page.data.picker.columns[0].slice(1)), Array.from({ length: 21 }, (_, index) => String(index + 30)))
  assert.equal(page.data.picker.values[0], 8)

  await page.detached()
  assert.deepEqual(removed.sort(), [first.imageFileID, second.imageFileID].sort())
})

test('F5 识别失败保留重试入口，保存失败按阶段单独重试，全部入库后返回', async () => {
  let navigated = false
  let scanFails = 1
  let saveFails = 1
  const page = loadComponent('batch-panel', {
    uploadImage: async file => `cloud://${file}`,
    itemScan: async fileID => {
      if (fileID.endsWith('a.jpg') && scanFails-- > 0) throw Error('识别失败，请重试')
      return { name: 'T恤', category: '上衣', color: '白色', seasons: ['春秋'] }
    },
    addItem: async payload => {
      if (payload.imageFileID.endsWith('a.jpg') && saveFails-- > 0) throw Error('保存失败，请重试')
    },
    listItems: async () => {},
    removeImage: async () => {}
  }, {
    chooseMedia(options) {
      options.success({ tempFiles: [{ tempFilePath: 'a.jpg' }, { tempFilePath: 'b.jpg' }] })
    },
    navigateBack() { navigated = true }
  })

  await page.attached()
  await page.onChooseImages()
  const [a, b] = page.data.cards
  assert.equal(page.card(a.key).status, 'failed')
  assert.equal(page.card(a.key).failStage, 'scan')
  assert.equal(page.card(b.key).status, 'pending')

  // 全部保存：识别失败卡保持 failed（重试识别入口保留），b 入库后被自动移除
  await page.onSaveAll()
  assert.equal(page.card(a.key).status, 'failed')
  assert.equal(page.card(a.key).failStage, 'scan')
  assert.equal(page.card(b.key), undefined)
  assert.equal(navigated, false)

  // 重试识别成功回到待确认
  await page.onRetryScan({ currentTarget: { dataset: { key: a.key } } })
  assert.equal(page.card(a.key).status, 'pending')
  assert.equal(page.card(a.key).name, 'T恤')

  // 保存失败标记为 save 阶段
  await page.onSaveAll()
  assert.equal(page.card(a.key).status, 'failed')
  assert.equal(page.card(a.key).failStage, 'save')
  assert.equal(navigated, false)

  // 单独重试保存成功，全部入库后自动返回衣橱
  await page.onRetrySave({ currentTarget: { dataset: { key: a.key } } })
  assert.equal(page.data.cards.length, 0)
  assert.equal(navigated, true)
})

test('F5 已入库卡片不占选图名额且不可展开编辑', async () => {
  let chooseCount
  const page = loadComponent('batch-panel', {}, {
    chooseMedia(options) {
      chooseCount = options.count
      options.success({ tempFiles: [] })
    }
  })
  await page.attached()
  page.setData({ cards: [
    { key: 's1', status: 'saved', imageFileID: 'cloud://s1', expanded: false },
    { key: 'p1', status: 'pending', imageFileID: 'cloud://p1', name: '', price: '' }
  ] })
  page.refreshView()
  assert.equal(page.data.remainingSlots, 8)
  await page.onChooseImages()
  assert.equal(chooseCount, 8)

  page.onToggleCard({ currentTarget: { dataset: { key: 's1' } } })
  assert.equal(page.card('s1').expanded, false)
  page.onToggleCard({ currentTarget: { dataset: { key: 'p1' } } })
  assert.equal(page.card('p1').expanded, true)
})

test('F5 添加页切换入口和移除卡片清理票据', async () => {
  const removed = []
  const page = loadComponent('batch-panel', { removeImage: async fileID => removed.push(fileID) })
  page.setData({ cards: [
    { key: 'pending', status: 'pending', imageFileID: 'cloud://pending' },
    { key: 'saved', status: 'saved', imageFileID: 'cloud://saved' }
  ] })
  await page.onRemoveCard({ currentTarget: { dataset: { key: 'pending' } } })
  assert.deepEqual(removed, ['cloud://pending'])
  await page.detached()
  assert.deepEqual(removed, ['cloud://pending'])

  const root = path.resolve(__dirname, '..')
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const wardrobe = fs.readFileSync(path.join(root, 'pages/wardrobe/wardrobe.wxml'), 'utf8')
  const itemEdit = fs.readFileSync(path.join(root, 'pages/item-edit/item-edit.wxml'), 'utf8')
  const itemEditStyles = fs.readFileSync(path.join(root, 'pages/item-edit/item-edit.wxss'), 'utf8')
  const itemEditConfig = JSON.parse(fs.readFileSync(path.join(root, 'pages/item-edit/item-edit.json'), 'utf8'))
  assert.equal(appConfig.pages.includes('pages/batch-add/batch-add'), false)
  assert.doesNotMatch(wardrobe, /onBatchAddTap|批量添加/)
  assert.match(itemEdit, /data-mode="single"/)
  assert.match(itemEdit, /data-mode="batch"/)
  assert.match(itemEdit, /mode-indicator-right/)
  assert.match(itemEditStyles, /transition:\s*transform 240ms ease/)
  assert.match(itemEdit, /<view wx:if="\{\{loading\}\}" class="empty item-edit-loading">加载中…<\/view>/)
  assert.match(itemEdit, /<block wx:else>/)
  assert.match(itemEditStyles, /\.item-edit-loading\s*\{[^}]*padding:\s*48rpx 0/s)
  assert.match(itemEdit, /mode-panel-hidden/)
  assert.doesNotMatch(itemEdit, /<batch-panel[^>]+hidden=/)
  assert.match(itemEditStyles, /\.mode-panel-hidden\s*\{[^}]*display:\s*none/s)
  assert.equal(itemEditConfig.usingComponents['batch-panel'], '/components/batch-panel/batch-panel')

  const titles = []
  const itemEditPage = loadPage('item-edit', {}, { setNavigationBarTitle: ({ title }) => titles.push(title) })
  itemEditPage.onModeTap({ currentTarget: { dataset: { mode: 'batch' } } })
  itemEditPage.onModeTap({ currentTarget: { dataset: { mode: 'single' } } })
  assert.equal(itemEditPage.data.mode, 'single')
  assert.deepEqual(titles, ['批量添加', '添加衣物'])
})
