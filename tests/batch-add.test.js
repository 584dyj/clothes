const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadPage } = require('./support/page')

test('F5 串行识别、逐卡校验保存并清理未入库图片', async () => {
  const order = []
  const removed = []
  const savedPayloads = []
  const files = ['/tmp/a.jpg', '/tmp/b.jpg', '/tmp/c.jpg']
  let chooseCount, addCalls = 0, refreshed = false
  const page = loadPage('batch-add', {
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

  await page.onLoad()
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
  assert.equal(page.card(second.key).status, 'pending')
  assert.equal(page.card(second.key).error, '请选择配饰类型')
  assert.equal(page.card(third.key).status, 'saved')
  assert.equal(refreshed, true)

  page.openPicker({ currentTarget: { dataset: { key: first.key, target: 'shoeSize' } } })
  assert.deepEqual(Array.from(page.data.picker.columns[0].slice(1)), Array.from({ length: 21 }, (_, index) => String(index + 30)))

  await page.onUnload()
  assert.deepEqual(removed.sort(), [first.imageFileID, second.imageFileID].sort())
})

test('F5 衣橱入口、页面注册和移除卡片清理票据', async () => {
  const removed = []
  const page = loadPage('batch-add', { removeImage: async fileID => removed.push(fileID) })
  page.setData({ cards: [
    { key: 'pending', status: 'pending', imageFileID: 'cloud://pending' },
    { key: 'saved', status: 'saved', imageFileID: 'cloud://saved' }
  ] })
  await page.onRemoveCard({ currentTarget: { dataset: { key: 'pending' } } })
  assert.deepEqual(removed, ['cloud://pending'])
  await page.onUnload()
  assert.deepEqual(removed, ['cloud://pending'])

  const root = path.resolve(__dirname, '..')
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const wardrobe = fs.readFileSync(path.join(root, 'pages/wardrobe/wardrobe.wxml'), 'utf8')
  assert.ok(appConfig.pages.includes('pages/batch-add/batch-add'))
  assert.match(wardrobe, /onBatchAddTap/)
})
