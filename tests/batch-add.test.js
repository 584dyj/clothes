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
      return { name: `衣物${fileID.at(-5)}`, category: '衬衫', color: '白色', seasons: ['春秋'] }
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
  assert.equal(savedPayloads[1].price, null)
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
      return { name: 'T恤', category: '长袖', color: '白色', seasons: ['春秋'] }
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

test('批量类别滚轮可手选保存全部 19 类，配饰保留袜子且非配饰清空子类', async () => {
  const saved = []
  const page = loadComponent('batch-panel', {
    uploadImage: async () => 'cloud://manual',
    itemScan: async () => ({}),
    addItem: async data => saved.push(data),
    listItems: async () => []
  }, { chooseMedia: options => options.success({ tempFiles: [{ tempFilePath: '/tmp/manual.jpg' }] }) })
  await page.attached()
  assert.equal(page.data.categories.length, 19)
  for (const category of page.data.categories) {
    await page.onChooseImages()
    const key = page.data.cards[0].key
    page.onInput({ currentTarget: { dataset: { key, field: 'name' } }, detail: { value: category } })
    page.openPicker({ currentTarget: { dataset: { key, target: 'category' } } })
    assert.deepEqual(Array.from(page.data.picker.columns[0]), Array.from(page.data.categories))
    page.onPickerConfirm({ detail: { values: [page.data.categories.indexOf(category)] } })
    assert.equal(page.card(key).category, category)
    if (category === '配饰') {
      page.openPicker({ currentTarget: { dataset: { key, target: 'subcategory' } } })
      page.onPickerConfirm({ detail: { values: [page.data.accessoryTypes.indexOf('袜子')] } })
    } else {
      page.patchCard(key, { subcategory: '帽子' })
    }
    page.openPicker({ currentTarget: { dataset: { key, target: 'category' } } })
    assert.equal(page.data.picker.values[0], page.data.categories.indexOf(category))
    page.onPickerCancel()
    await page.onSaveAll()
    assert.equal(page.data.cards.length, 0)
    assert.equal(saved.at(-1).category, category)
    assert.equal(saved.at(-1).subcategory, category === '配饰' ? '袜子' : '')
  }
  assert.equal(saved.length, 19)
})

test('批量九张上限保持，移除卡片后只开放剩余名额并清理票据', async () => {
  const counts = [], removed = []
  const page = loadComponent('batch-panel', {
    uploadImage: async file => `cloud://${path.basename(file)}`,
    itemScan: async () => ({ name: '衬衫', category: '衬衫' }),
    removeImage: async fileID => removed.push(fileID)
  }, { chooseMedia: options => {
    counts.push(options.count)
    options.success({ tempFiles: Array.from({ length: options.count }, (_, index) => ({ tempFilePath: `/tmp/${counts.length}-${index}.jpg` })) })
  } })
  await page.attached()
  await page.onChooseImages()
  assert.equal(page.data.cards.length, 9)
  assert.equal(page.data.remainingSlots, 0)
  await page.onChooseImages()
  assert.deepEqual(counts, [9])
  const first = page.data.cards[0]
  await page.onRemoveCard({ currentTarget: { dataset: { key: first.key } } })
  assert.deepEqual(removed, [first.imageFileID])
  await page.onChooseImages()
  assert.deepEqual(counts, [9, 1])
  assert.equal(page.data.cards.length, 9)
  assert.equal(new Set(page.data.cards.map(card => card.key)).size, 9)
  await page.detached()
  assert.equal(removed.length, 10)
})

test('批量识别保留在途手填字段，不把模型其他类别的子类填入配饰', async () => {
  let finish
  const page = loadComponent('batch-panel', {
    uploadImage: async () => 'cloud://editing',
    itemScan: () => new Promise(resolve => { finish = resolve })
  }, { chooseMedia: options => options.success({ tempFiles: [{ tempFilePath: '/tmp/editing.jpg' }] }) })
  await page.attached()
  const scanning = page.onChooseImages()
  await new Promise(resolve => setImmediate(resolve))
  const key = page.data.cards[0].key
  for (const [field, value] of [['name', '手填名称'], ['color', '自定义蓝'], ['price', '88']]) {
    page.onInput({ currentTarget: { dataset: { key, field } }, detail: { value } })
  }
  page.onCategoryTap({ currentTarget: { dataset: { key, value: '配饰' } } })
  page.onSizeTap({ currentTarget: { dataset: { key, value: 'M' } } })
  page.onSeasonTap({ currentTarget: { dataset: { key, value: '冬' } } })
  finish({ name: '模型名称', category: '衬衫', subcategory: '帽子', color: '白色', seasons: ['夏'], price: 1 })
  await scanning
  const card = page.card(key)
  assert.equal(card.status, 'pending')
  assert.equal(card.name, '手填名称')
  assert.equal(card.category, '配饰')
  assert.equal(card.subcategory, '')
  assert.equal(card.color, '自定义蓝')
  assert.equal(card.colorCustom, true)
  assert.equal(card.price, '88')
  assert.equal(card.size, 'M')
  assert.deepEqual(Array.from(card.seasons), ['冬'])
  assert.deepEqual(Array.from(card.seasonStates.filter(state => state.active), state => state.value), ['冬'])
  for (const subcategory of page.data.accessoryTypes) {
    page.openPicker({ currentTarget: { dataset: { key, target: 'subcategory' } } })
    page.onPickerConfirm({ detail: { values: [page.data.accessoryTypes.indexOf(subcategory)] } })
    assert.equal(page.validate(page.card(key)), '')
    assert.equal(page.buildPayload(page.card(key)).subcategory, subcategory)
  }
  page.onCategoryTap({ currentTarget: { dataset: { key, value: '鞋' } } })
  assert.equal(page.card(key).subcategory, '')
  assert.equal(page.card(key).size, '')
  page.openPicker({ currentTarget: { dataset: { key, target: 'shoeSize' } } })
  page.onPickerConfirm({ detail: { values: [page.data.picker.columns[0].indexOf('42')] } })
  assert.equal(page.card(key).size, '42')
  page.onCategoryTap({ currentTarget: { dataset: { key, value: '长袖' } } })
  assert.equal(page.card(key).size, '')
  assert.equal(page.buildPayload(page.card(key)).subcategory, '')
})

test('批量回填拒绝旧类别及非法模型字段，保存前拦截非法类别和配饰子类', async () => {
  let result, writes = 0
  const page = loadComponent('batch-panel', {
    uploadImage: async () => 'cloud://invalid',
    itemScan: async () => result,
    addItem: async () => { writes++ },
    listItems: async () => [],
    removeImage: async () => {}
  }, { chooseMedia: options => options.success({ tempFiles: [{ tempFilePath: '/tmp/invalid.jpg' }] }) })
  await page.attached()
  for (const raw of [
    { category: '上衣', name: {}, subcategory: '帽子', color: {}, seasons: '冬' },
    { category: '下装', name: 1, subcategory: '帽子', color: '非法', seasons: [] },
    null,
    { category: '配饰', name: '模型配饰', subcategory: '手套', color: '非法', seasons: ['冬', '冬', '非法'] }
  ]) {
    result = raw
    await page.onChooseImages()
    const card = page.data.cards[0]
    assert.equal(card.status, 'pending')
    assert.equal(card.category, raw && raw.category === '配饰' ? '配饰' : '')
    assert.equal(card.subcategory, '')
    assert.equal(card.color, '')
    assert.deepEqual(Array.from(card.seasons), raw && raw.category === '配饰' ? ['冬'] : [])
    assert.equal(card.name, raw && raw.category === '配饰' ? '模型配饰' : '')
    page.patchCard(card.key, { name: '手填名称', category: '上衣' })
    await page.onSaveAll()
    assert.equal(page.card(card.key).error, '请选择类别')
    page.patchCard(card.key, { category: '配饰', subcategory: '手套' })
    await page.onSaveAll()
    assert.equal(page.card(card.key).error, '请选择配饰类型')
    assert.equal(writes, 0)
    await page.onRemoveCard({ currentTarget: { dataset: { key: card.key } } })
  }
})
