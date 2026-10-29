const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const scan = require('../cloudfunctions/auth/scan')
const { CATEGORIES, ACCESSORY_TYPES } = require('../cloudfunctions/auth/categories')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')

const token = 'a'.repeat(32)
const fileID = `cloud://env/wardrobe/${token}.jpg`
const ticket = patch => ({ _id: token, _openid: 'openid-1', cloudPath: `wardrobe/${token}.jpg`, ...patch })
const env = { AI_API_BASE: 'https://api.deepseek.com', AI_API_KEY: 'test-key', AI_MODEL: 'deepseek-flash' }
const reply = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })

test('拍照识别校验票据并归一模型字段', async () => {
  const cloud = loadCloud({ upload_tickets: [ticket()] })
  let options
  const result = await scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, async value => {
    options = value
    return reply({
      name: '  蓝色衬衫  ', category: '衬衫', subcategory: '帽子', color: '蓝色',
      seasons: ['春秋', '春秋', '非法'], brand: '  测试品牌  ', price: 999
    })
  }, env)
  assert.deepEqual(result.item, {
    name: '蓝色衬衫', category: '衬衫', subcategory: '', color: '蓝色', seasons: ['春秋'], brand: '测试品牌'
  })
  assert.equal(cloud.records.upload_tickets[0].target, 'itemScan')
  assert.equal(cloud.records.upload_tickets[0].fileID, fileID)
  assert.equal(cloud.downloads[0], fileID)
  assert.equal(options.json, true)
  assert.equal(options.disableThinking, true)
  assert.equal(options.maxTokens, 300)
  assert.equal(options.timeoutMs, 20000)
  assert.match(options.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/)
})

test('识别合同接受19类与配饰子类，提示词包含冻结的交叉分类规则', () => {
  for (const category of CATEGORIES) {
    const result = scan.cleanResult(reply({ name: '衣'.repeat(80), category, subcategory: '袜子', brand: '牌'.repeat(40) }))
    assert.equal(result.category, category)
    assert.equal(result.subcategory, category === '配饰' ? '袜子' : '')
    assert.equal(result.name.length, 60)
    assert.equal(result.brand.length, 30)
  }
  for (const subcategory of ACCESSORY_TYPES) {
    assert.equal(scan.cleanResult(reply({ category: '配饰', subcategory })).subcategory, subcategory)
  }
  const prompt = scan.systemPrompt()
  assert.ok(prompt.includes(`类别只能是：${CATEGORIES.join('、')}。`))
  assert.ok(prompt.includes(`配饰类型只能是：${ACCESSORY_TYPES.join('、')}。`))
  assert.ok(prompt.includes(`其余 ${CATEGORIES.length - 1} 类`))
  assert.match(prompt, /针织马甲、羽绒马甲和西装马甲.*统一归马甲/)
  assert.match(prompt, /普通贴身无袖背心不凭袖长归马甲/)
  for (const rule of [
    /品类和用途优先于袖长/, /短袖衬衫、长袖衬衫.*归衬衫/,
    /羽绒服.*保暖衣.*毛衣.*家居服/, /套头针织.*毛衣.*针织开衫.*外套/,
    /保暖裤.*长裤.*短裤/, /家居服.*单件.*套装.*连体/,
    /半身裙.*长裙.*短裙/, /连体裙.*连衣裙/,
    /普通上装袖长、半身裙或裤装长短无法确认.*类别留空/, /已确认的专属品类不因袖长或衣长不清而留空/,
    /袜子.*配饰.*袜子/,
    /手提包、背包.*包袋/, /不确定.*留空.*其他/, /非配饰.*subcategory.*空/
  ]) assert.match(prompt, rule)
})

test('识别未知字段留空，旧类别不兼容或强制归其他，异常模型结构统一拒绝', () => {
  const empty = { name: '', category: '', subcategory: '', color: '', seasons: [], brand: '' }
  for (const category of ['', '上衣', '下装', '包', '袜子', '未知', null, 123]) {
    assert.deepEqual(scan.cleanResult(reply({ category, subcategory: '袜子', name: 123, color: '未知', seasons: '夏', brand: {} })), empty)
  }
  assert.deepEqual(scan.cleanResult(reply({})), empty)
  assert.equal(scan.cleanResult(reply({ category: '配饰', subcategory: '手套' })).subcategory, '')
  for (const value of [null, [], 123, true, '物品']) {
    assert.throws(() => scan.cleanResult(reply(value)), /识别失败，请重试或手动填写/)
  }
  for (const response of [null, { choices: [] }, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{' } }] }]) {
    assert.throws(() => scan.cleanResult(response), /识别失败，请重试或手动填写/)
  }
})

test('无效识别结果释放忙锁，同图重试可识别其他并保存基础记录', async () => {
  const cloud = loadCloud({ users: [user()], upload_tickets: [ticket()] })
  const context = { db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }
  await assert.rejects(scan.handle(context, async () => reply(null), env), /识别失败，请重试或手动填写/)
  assert.equal(cloud.records.auth_attempts[0].busyUntil, null)
  const { item } = await scan.handle(context, async () => reply({ name: '桌面摆件', category: '其他', subcategory: '袜子' }), env)
  assert.equal(item.category, '其他')
  assert.equal(item.subcategory, '')
  const saved = await cloud.main({ action: 'data', operation: 'add', collection: 'clothes', data: {
    ...item, size: '', price: 0, purchaseDate: '', note: '', imageFileID: fileID
  } })
  assert.equal(saved.success, true)
  assert.equal(cloud.records.clothes[0].category, '其他')
  assert.match(cloud.records.upload_tickets[0].target, /^clothes\//)
})

test('拍照识别拒绝外账号、已用和已取消票据', async () => {
  const request = async () => reply({})
  for (const invalid of [
    ticket({ _openid: 'openid-2' }),
    ticket({ target: 'chat', fileID }),
    ticket({ cancelled: true })
  ]) {
    const cloud = loadCloud({ upload_tickets: [invalid] })
    await assert.rejects(scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, request, env), /图片不属于当前账号或已使用/)
  }
})

test('模型失败统一提示并释放忙锁，同一图片可以重试', async () => {
  const cloud = loadCloud({ upload_tickets: [ticket()] })
  const context = { db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }
  await assert.rejects(scan.handle(context, async () => { throw Error('timeout') }, env), /识别失败，请重试或手动填写/)
  assert.equal(cloud.records.auth_attempts[0].busyUntil, null)
  const result = await scan.handle(context, async () => reply({ category: '鞋', color: '黑色', seasons: [] }), env)
  assert.equal(result.item.category, '鞋')
})

test('同账号并发识别会被忙锁拒绝', async () => {
  const cloud = loadCloud({ upload_tickets: [ticket()] })
  let finish, started
  const began = new Promise(resolve => { started = resolve })
  const first = scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, () => {
    started()
    return new Promise(resolve => { finish = () => resolve(reply({ category: '鞋' })) })
  }, env)
  await began
  await assert.rejects(scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, async () => reply({}), env), /图片正在识别/)
  finish()
  await first
})

test('识别后的图片可保存为衣物，未保存图片可清理', async () => {
  const cloud = loadCloud({ users: [user()], upload_tickets: [ticket()] })
  await scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, async () => reply({ category: '衬衫' }), env)
  const saved = await cloud.main({ action: 'data', operation: 'add', collection: 'clothes', data: {
    name: '衬衫', category: '衬衫', subcategory: '', size: 'M', color: '', brand: '', seasons: [], price: 0,
    purchaseDate: '', note: '', imageFileID: fileID
  } })
  assert.equal(saved.success, true)
  assert.match(cloud.records.upload_tickets[0].target, /^clothes\//)

  const otherToken = 'b'.repeat(32)
  const otherFile = `cloud://env/wardrobe/${otherToken}.jpg`
  const cleanup = loadCloud({ users: [user()], upload_tickets: [{
    _id: otherToken, _openid: 'openid-1', cloudPath: `wardrobe/${otherToken}.jpg`, fileID: otherFile, target: 'itemScan'
  }] })
  assert.equal((await cleanup.main({ action: 'removeImage', fileID: otherFile })).cleanupFailed, false)
  assert.deepEqual(cleanup.deletedFiles, [otherFile])
})

test('未配置和未登录时拒绝拍照识别', async () => {
  const cloud = loadCloud({ upload_tickets: [ticket()] })
  await assert.rejects(scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, async () => reply({}), {}), /AI 识别尚未配置/)
  assert.match((await cloud.main({ action: 'itemScan', imageFileID: fileID })).error, /登录状态已失效/)
})

test('auth 在登录校验后路由拍照识别', async () => {
  const original = scan.handle
  const seen = []
  scan.handle = async context => { seen.push(context.openid); return { success: true, item: { name: '衬衫' } } }
  try {
    const cloud = loadCloud({ users: [user()] })
    const result = await cloud.main({ action: 'itemScan', imageFileID: fileID })
    assert.equal(result.item.name, '衬衫')
    assert.deepEqual(seen, ['openid-1'])
    cloud.records.users[0].autoLoginEnabled = false
    assert.match((await cloud.main({ action: 'itemScan', imageFileID: fileID })).error, /登录状态已失效/)
    assert.deepEqual(seen, ['openid-1'])
  } finally {
    scan.handle = original
  }
})

test('新增页只填空字段并防止重复识别', async () => {
  let scans = 0, release
  const toasts = []
  const page = loadPage('item-edit', {
    uploadImage: async () => fileID,
    itemScan: async () => {
      scans++
      await new Promise(resolve => { release = resolve })
      return { name: '白衬衫', category: '鞋', subcategory: '', color: '白色', seasons: ['冬'], brand: '品牌' }
    }
  }, {
    getStorageSync: () => 'M',
    showToast: options => toasts.push(options.title)
  })
  await page.onLoad({})
  page.setData({ imagePath: '/tmp/shoe.jpg', name: '已有名称', color: '红色', brand: '', price: '88', note: '保留备注' })
  const pending = page.onScanPhoto()
  const duplicate = page.onScanPhoto()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scans, 1)
  assert.equal(page.data.scanning, true)
  release()
  await Promise.all([pending, duplicate])
  assert.equal(page.data.name, '已有名称')
  assert.equal(page.data.color, '红色')
  assert.equal(page.data.category, '鞋')
  assert.equal(page.data.size, '')
  assert.deepEqual(Array.from(page.data.selectedSeasons), ['冬'])
  assert.equal(page.data.brand, '品牌')
  assert.equal(page.data.price, '88')
  assert.equal(page.data.note, '保留备注')
  assert.equal(page.data.imagePath, '')
  assert.equal(page.data.scanFileID, fileID)
  assert.equal(toasts.at(-1), '已自动填充，请核对')
})

test('新增页识别失败保留表单，按钮只在有新照片时出现', async () => {
  const toasts = []
  const page = loadPage('item-edit', {
    uploadImage: async () => fileID,
    itemScan: async () => { throw Error('识别失败，请重试或手动填写') }
  }, { showToast: options => toasts.push(options.title) })
  await page.onLoad({})
  page.setData({ imagePath: '/tmp/top.jpg', name: '手填名称', color: '蓝色' })
  await page.onScanPhoto()
  assert.equal(page.data.name, '手填名称')
  assert.equal(page.data.color, '蓝色')
  assert.equal(page.data.scanning, false)
  assert.equal(toasts.at(-1), '识别失败，请重试或手动填写')

  const markup = fs.readFileSync(path.resolve(__dirname, '../pages/item-edit/item-edit.wxml'), 'utf8')
  assert.match(markup, /!id && \(imagePath \|\| scanFileID\)/)
  assert.match(markup, /AI 识别填充/)
})

test('单件照片回填过滤过时类别、非法子类及颜色季节，合法细类与袜子正常回填', async () => {
  for (const [category, subcategory, expectedCategory, expectedSubcategory] of [
    ['上衣', '', '', ''], ['下装', '', '', ''], ['包', '', '', ''],
    ['未知', '', '', ''], ['长袖', '帽子', '长袖', ''], ['其他', '袜子', '其他', ''],
    ['配饰', '袜子', '配饰', '袜子'], ['配饰', '手套', '配饰', '']
  ]) {
    const page = loadPage('item-edit', {
      uploadImage: async () => fileID,
      itemScan: async () => ({ name: '识别名称', category, subcategory, color: '非法颜色', seasons: ['夏', '夏', '非法'], brand: '' })
    })
    await page.onLoad({})
    page.setData({ imagePath: '/tmp/photo.jpg' })
    await page.onScanPhoto()
    assert.equal(page.data.category, expectedCategory)
    assert.equal(page.data.subcategory, expectedSubcategory)
    assert.equal(page.data.name, '识别名称')
    assert.equal(page.data.color, '')
    assert.deepEqual(Array.from(page.data.selectedSeasons), ['夏'])
    assert.equal(page.data.scanning, false)
  }
})

test('购买识别回填过滤过时类别与非法字段，合法细类与袜子正常回填', async () => {
  for (const [category, subcategory, expectedCategory, expectedSubcategory] of [
    ['上衣', '', '', ''], ['下装', '', '', ''], ['未知', '', '', ''],
    ['长袖', '帽子', '长袖', ''], ['配饰', '袜子', '配饰', '袜子'], ['配饰', '手套', '配饰', '']
  ]) {
    const page = loadPage('assistant', {
      uploadImage: async () => fileID,
      itemScan: async () => ({ name: '识别名称', category, subcategory, color: '非法颜色', seasons: ['夏', '夏', '非法'], brand: '' })
    })
    page.setData({ activeMode: 'purchase', purchaseImagePath: '/tmp/photo.jpg' })
    await page.onPurchaseScanPhoto()
    assert.equal(page.data.purchaseForm.category, expectedCategory, category)
    assert.equal(page.data.purchaseForm.subcategory, expectedSubcategory, category)
    assert.equal(page.data.purchaseForm.name, '识别名称')
    assert.equal(page.data.purchaseForm.color, '')
    assert.deepEqual(Array.from(page.data.purchaseForm.seasons), ['夏'])
    assert.equal(page.data.purchaseError, '')
    assert.equal(page.data.purchaseScanning, false)
  }
})

test('购买识别为其他时不回填类别，引导到衣橱基础建档', async () => {
  const toasts = []
  const page = loadPage('assistant', {
    uploadImage: async () => fileID,
    itemScan: async () => ({ name: '摆件', category: '其他', subcategory: '', color: '蓝色', seasons: ['夏'], brand: '' })
  }, { showToast: options => toasts.push(options.title) })
  page.setData({ activeMode: 'purchase', purchaseImagePath: '/tmp/photo.jpg' })
  await page.onPurchaseScanPhoto()
  assert.equal(page.data.purchaseForm.name, '摆件')
  assert.equal(page.data.purchaseForm.category, '')
  assert.equal(page.data.purchaseForm.subcategory, '')
  assert.match(page.data.purchaseError, /不参与购买评估.*基础记录/)
  assert.match(toasts.at(-1), /基础建档/)
  assert.equal(page.data.purchaseScanning, false)
})

test('购买评估入口排除一级其他，手选与提交均拦截', async () => {
  let assesses = 0
  const page = loadPage('assistant', { purchaseAssess: async () => { assesses++; return {} } })
  assert.deepEqual(Array.from(page.data.purchaseCategories), CATEGORIES.filter(value => value !== '其他'))
  const markup = fs.readFileSync(path.resolve(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /wx:for="{{purchaseCategories}}"/)

  page.onPurchaseCategoryTap({ currentTarget: { dataset: { value: '其他' } } })
  assert.equal(page.data.purchaseForm.category, '')
  page.onPurchaseCategoryTap({ currentTarget: { dataset: { value: '长裤' } } })
  assert.equal(page.data.purchaseForm.category, '长裤')

  page.setData({ purchaseForm: { name: '摆件', category: '其他', subcategory: '', color: '蓝色', seasons: ['夏'], occasion: '', price: '10', monthlyBudget: '', note: '' } })
  await page.onPurchaseSubmit()
  assert.equal(assesses, 0)
  assert.match(page.data.purchaseError, /不参与购买评估/)

  page.setData({ purchaseForm: { name: '长裤', category: '长裤', subcategory: '', color: '蓝色', seasons: ['夏'], occasion: '', price: '10', monthlyBudget: '', note: '' } })
  await page.onPurchaseSubmit()
  assert.equal(assesses, 1)
  assert.equal(page.data.purchaseError, '')
})

test('识别返回保护期间手填字段，阻止在途保存并保持单件批量切换状态', async () => {
  let finish, began, saves = 0
  const started = new Promise(resolve => { began = resolve })
  const page = loadPage('item-edit', {
    uploadImage: async () => fileID,
    itemScan: async () => { began(); return new Promise(resolve => { finish = resolve }) },
    addItem: async () => { saves++ }
  })
  await page.onLoad({})
  page.setData({ imagePath: '/tmp/photo.jpg' })
  const pending = page.onScanPhoto()
  await started
  page.onCategoryTap({ currentTarget: { dataset: { value: '配饰' } } })
  page.openPicker({ currentTarget: { dataset: { target: 'subcategory' } } })
  page.onPickerConfirm({ detail: { values: [4] } })
  page.onSizeTap({ currentTarget: { dataset: { value: 'M' } } })
  page.setData({ name: '手填名称', color: '手填颜色', colorCustom: true, brand: '手填品牌', selectedSeasons: ['夏'], price: '88', note: '保留备注' })
  await page.onSave()
  assert.equal(saves, 0)
  page.onModeTap({ currentTarget: { dataset: { mode: 'batch' } } })
  finish({ name: '模型名称', category: '鞋', subcategory: '', color: '白色', seasons: ['冬'], brand: '模型品牌' })
  await pending
  assert.equal(page.data.mode, 'batch')
  page.onModeTap({ currentTarget: { dataset: { mode: 'single' } } })
  assert.equal(page.data.mode, 'single')
  assert.equal(page.data.name, '手填名称')
  assert.equal(page.data.category, '配饰')
  assert.equal(page.data.subcategory, '其他')
  assert.equal(page.data.size, 'M')
  assert.equal(page.data.color, '手填颜色')
  assert.equal(page.data.colorCustom, true)
  assert.equal(page.data.brand, '手填品牌')
  assert.deepEqual(Array.from(page.data.selectedSeasons), ['夏'])
  assert.equal(page.data.price, '88')
  assert.equal(page.data.note, '保留备注')
  assert.equal(page.data.scanFileID, fileID)
  assert.equal(page.data.scanning, false)
})
