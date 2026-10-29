const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { loadCloud } = require('./support/cloud')
const { createBackup, COLLECTIONS } = require('../utils/backup')
const { loadPage } = require('./support/page')
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const sourceImage = 'cloud://original/wardrobe/' + 'a'.repeat(32) + '.jpg'
const createdAt = new Date('2025-01-01T00:00:00Z')
const clothes = (id, patch = {}) => ({ _id: id, _openid: 'a', createdAt, name: '中文马甲', category: '马甲', subcategory: '',
  seasons: ['春秋'], price: 12.34, imageFileID: sourceImage, ...patch })

function setup(records = {}) {
  const cloud = loadCloud({ users: [{ _id: 'ua', openid: 'a', passwordHash: 'secret' }, { _id: 'ub', openid: 'b' }],
    clothes: [clothes('cloth')], outfits: [{ _id: 'outfit', _openid: 'a', name: '搭配', itemIds: ['cloth'], imageFileID: sourceImage, createdAt }],
    wear_records: [{ _id: 'wear', _openid: 'a', date: today(), itemIds: ['cloth'], outfitId: 'outfit', note: '实穿备注', createdAt }],
    expenses: [{ _id: 'expense', _openid: 'a', category: '洗护', date: today(), amount: 20, itemId: 'cloth', note: '', createdAt }],
    outfit_plans: [{ _id: 'plan', _openid: 'a', date: today(), outfitId: 'outfit', note: '', createdAt }],
    stickers: [{ _id: 'sticker', _openid: 'a', name: '贴纸', status: 'done', imageFileID: sourceImage, doneImageFileID: sourceImage,
      doneAt: today(), purchasedAt: '2025-01-01', price: null, quantity: 2, createdAt }], ...records })
  cloud.setOpenid('a')
  const files = new Map(), images = new Map([[sourceImage, Buffer.from('原图'.repeat(30000))]])
  let sequence = 0, intercept = async result => result
  const bytes = (value, encoding) => typeof value === 'string' ? Buffer.from(value, encoding || 'utf8') : Buffer.from(value)
  const reply = (options, fn) => { try { options.success(fn()) } catch (error) { options.fail({ errMsg: error.message }) } }
  const fs = {
    writeFile: options => reply(options, () => { files.set(options.filePath, bytes(options.data, options.encoding)); return {} }),
    appendFile: options => reply(options, () => { files.set(options.filePath, Buffer.concat([files.get(options.filePath), bytes(options.data, options.encoding)])); return {} }),
    readFile: options => reply(options, () => {
      const part = files.get(options.filePath).subarray(options.position || 0, (options.position || 0) + options.length)
      return { data: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) }
    }),
    getFileInfo: options => reply(options, () => ({ size: files.get(options.filePath).length,
      digest: crypto.createHash(options.digestAlgorithm).update(files.get(options.filePath)).digest('hex') })),
    unlink: options => reply(options, () => { files.delete(options.filePath); return {} })
  }
  const wx = { env: { USER_DATA_PATH: '/local' }, getFileSystemManager: () => fs,
    arrayBufferToBase64: data => Buffer.from(data).toString('base64'),
    base64ToArrayBuffer: text => { const b = Buffer.from(text, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
    cloud: {
      callFunction: async ({ data }) => ({ result: await intercept(await cloud.main(data), data) }),
      downloadFile: options => reply(options, () => {
        const path = '/download/' + ++sequence
        if (!images.has(options.fileID)) throw Error('image unavailable')
        files.set(path, images.get(options.fileID)); return { tempFilePath: path }
      }),
      uploadFile: options => reply(options, () => {
        const fileID = 'cloud://destination/' + options.cloudPath
        images.set(fileID, Buffer.from(files.get(options.filePath))); return { fileID }
      })
    } }
  global.wx = wx
  delete require.cache[require.resolve('../utils/db')]
  const db = require('../utils/db'), tools = createBackup({ wx, db })
  return { cloud, files, images, wx, db, tools, intercept(fn) { intercept = fn } }
}

test('完整备份含原图与六类业务数据，跨账号恢复映射引用，重复恢复不覆盖修改', async () => {
  const ctx = setup(), { cloud, tools, files, images } = ctx
  const exported = await tools.exportBackup()
  const text = files.get(exported.path).toString('utf8')
  assert.ok(!text.includes('passwordHash') && !text.includes('secret') && !text.includes('_openid'))
  assert.equal(exported.images, 1)
  assert.ok(COLLECTIONS.every(key => exported.counts[key] === 1))
  cloud.setOpenid('b'); ctx.db.clearCache()
  const archive = await tools.inspectBackup(exported.path)
  assert.equal(archive.records.length, 6)
  const restored = await tools.restoreBackup(archive)
  assert.equal(restored.restored, 6)
  const own = collection => cloud.records[collection].find(row => row._openid === 'b')
  assert.notEqual(own('clothes')._id, 'cloth')
  assert.equal(own('clothes').category, '马甲')
  assert.equal(own('clothes').createdAt.toISOString(), createdAt.toISOString())
  assert.equal(own('clothes').price, 12.34)
  assert.deepEqual(own('outfits').itemIds, [own('clothes')._id])
  assert.equal(own('wear_records').outfitId, own('outfits')._id)
  assert.equal(own('expenses').itemId, own('clothes')._id)
  assert.equal(own('outfit_plans').outfitId, own('outfits')._id)
  assert.equal(own('stickers').status, 'done')
  assert.equal(own('stickers').price, null)
  assert.deepEqual(images.get(own('clothes').imageFileID), images.get(sourceImage))
  assert.equal(own('outfits').imageFileID, own('clothes').imageFileID)
  own('clothes').name = '恢复后自行改名'
  const again = await tools.restoreBackup(await tools.inspectBackup(exported.path))
  assert.equal(again.restored, 0)
  assert.equal(again.skipped, 6)
  assert.equal(own('clothes').name, '恢复后自行改名')
  assert.equal(cloud.records.wear_records.filter(row => row._openid === 'b').length, 1)
  await archive.cleanup()
})

test('备份恢复保留未填价格与明确0元', async () => {
  const { cloud, tools } = setup({ clothes: [clothes('unknown', { price: null }), clothes('free', { price: 0 })] })
  const exported = await tools.exportBackup()
  cloud.setOpenid('b')
  const archive = await tools.inspectBackup(exported.path)
  await tools.restoreBackup(archive)
  assert.deepEqual(cloud.records.clothes.filter(row => row._openid === 'b').map(row => row.price).sort(), [0, null])
  await archive.cleanup()
})

test('本账号备份补回被删除的记录，保留现有内容，允许恢复已清空的搭配及历史失效引用', async () => {
  const { cloud, tools } = setup({ outfits: [{ _id: 'empty', _openid: 'a', name: '空搭配', itemIds: [], createdAt }] })
  const exported = await tools.exportBackup()
  cloud.records.clothes = []
  cloud.records.outfits[0].name = '保留此修改'
  const result = await tools.restoreBackup(await tools.inspectBackup(exported.path))
  assert.equal(result.restored, 1)
  assert.equal(cloud.records.clothes[0]._id, 'cloth')
  assert.equal(cloud.records.outfits[0].name, '保留此修改')
  assert.equal(cloud.records.wear_records[0].outfitId, 'outfit')
  cloud.setOpenid('b')
  await tools.restoreBackup(await tools.inspectBackup(exported.path))
  assert.deepEqual(cloud.records.outfits.find(row => row._openid === 'b').itemIds, [])
})

test('损坏、截断、未知版本与非法业务记录均在恢复前被拒绝，不留下解包图片', async () => {
  const { cloud, tools, files } = setup()
  const { path } = await tools.exportBackup(), original = files.get(path).toString('utf8')
  const before = structuredClone(cloud.records)
  const cases = [original.replace('"version":1', '"version":9'), original.slice(0, original.lastIndexOf('{"type":"end"')),
    original.replace('"digest":"', '"digest":"bad'), original.replace('"price":12.34', '"price":-1'),
    original + '{"type":"record"}\n']
  for (const text of cases) {
    files.set('/bad.jsonl', Buffer.from(text))
    await assert.rejects(tools.inspectBackup('/bad.jsonl'))
    assert.deepEqual(cloud.records, before)
    assert.equal([...files.keys()].filter(path => path.startsWith('/local/') && !path.endsWith('jsonl')).length, 0)
  }
})

test('恢复提交后响应丢失可重试，大于一批记录不重复，失败批次回滚', async () => {
  const ctx = setup({ clothes: Array.from({ length: 25 }, (_, n) => clothes('cloth' + n, { note: '衣'.repeat(1999) })) })
  const exported = await ctx.tools.exportBackup()
  ctx.cloud.setOpenid('b')
  let lost = false
  ctx.intercept(async (result, data) => {
    if (data.action === 'backupRestore' && result.success && !lost) { lost = true; throw Error('response lost') }
    return result
  })
  await assert.rejects(ctx.tools.restoreBackup(await ctx.tools.inspectBackup(exported.path)), /可重新选择同一备份重试/)
  ctx.intercept(async result => result)
  const result = await ctx.tools.restoreBackup(await ctx.tools.inspectBackup(exported.path))
  assert.equal(result.restored + result.skipped, 30)
  assert.equal(ctx.cloud.records.clothes.filter(row => row._openid === 'b').length, 25)
  assert.equal(ctx.cloud.records.clothes.find(row => row._openid === 'b').note, '衣'.repeat(1999))
  const before = structuredClone(ctx.cloud.records)
  ctx.cloud.faults.before = (name, operation) => { if (name === 'expenses' && operation === 'set') throw Error('failed write') }
  const { source } = await ctx.db.backupInfo()
  const bad = await ctx.cloud.main({ action: 'backupRestore', source, images: {}, records: [
    { collection: 'outfits', id: 'new', data: { name: 'new', itemIds: [] } },
    { collection: 'expenses', id: 'new', data: { category: '洗护', date: today(), amount: 1 } }
  ] })
  assert.equal(bad.success, false)
  assert.deepEqual(ctx.cloud.records, before)
})

test('备份动作鉴权、集合白名单、图片票据及实穿组合冲突均在服务端校验', async () => {
  const { cloud, db } = setup()
  assert.equal((await cloud.main({ action: 'backupExport', collection: 'users', offset: 0 })).success, false)
  const { source } = await db.backupInfo()
  const row = { collection: 'clothes', id: 'new', data: { ...clothes('unused'), imageFileID: sourceImage } }
  const denied = await cloud.main({ action: 'backupRestore', source, records: [row], images: { [sourceImage]: sourceImage } })
  assert.equal(denied.success, false)
  assert.ok(!cloud.records.clothes.some(row => row._id === 'new'))
  const conflict = await cloud.main({ action: 'backupRestore', source, records: [{ collection: 'wear_records', id: 'another',
    data: { date: today(), itemIds: ['cloth'], note: '' } }], images: {} })
  assert.match(conflict.error, /实穿组合.*冲突/)
  await cloud.main({ action: 'logout' })
  for (const action of ['backupInfo', 'backupExport', 'backupValidate', 'backupRestore']) {
    assert.match((await cloud.main({ action })).error, /登录状态已失效/)
  }
})

test('个人页提供导出、发送和恢复入口，备份进行中不能退出登录', () => {
  const page = loadPage('profile')
  page.setData({ backupBusy: true })
  page.onLogout()
  assert.equal(page.data.loggingOut, false)
  const markup = require('node:fs').readFileSync(require.resolve('../pages/profile/profile.wxml'), 'utf8')
  for (const handler of ['onExportBackup', 'onShareBackup', 'onRestoreBackup']) {
    assert.match(markup, new RegExp(`bindtap="${handler}"`))
    assert.equal(typeof page[handler], 'function')
  }
})
