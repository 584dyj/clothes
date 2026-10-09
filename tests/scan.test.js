const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const scan = require('../cloudfunctions/auth/scan')
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
      name: '  蓝色衬衫  ', category: '上衣', subcategory: '帽子', color: '蓝色',
      seasons: ['春秋', '春秋', '非法'], brand: '  测试品牌  ', price: 999
    })
  }, env)
  assert.deepEqual(result.item, {
    name: '蓝色衬衫', category: '上衣', subcategory: '', color: '蓝色', seasons: ['春秋'], brand: '测试品牌'
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
  await scan.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { imageFileID: fileID } }, async () => reply({ category: '上衣' }), env)
  const saved = await cloud.main({ action: 'data', operation: 'add', collection: 'clothes', data: {
    name: '衬衫', category: '上衣', subcategory: '', size: 'M', color: '', brand: '', seasons: [], price: 0,
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
