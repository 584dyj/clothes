const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')
const { validDate } = require('../utils/date')
const { CATEGORIES, ACCESSORY_TYPES, isRecommendable } = require('../cloudfunctions/auth/categories')

const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', salt: 'salt', passwordHash: crypto.scryptSync('secret1', 'salt', 64).toString('hex') })
const item = () => ({ name: '衬衫', category: '衬衫', seasons: ['春秋'], price: 10, imageFileID: '' })
const dataCall = (operation, collection = 'clothes', extra = {}) => ({ action: 'data', operation, collection, ...extra })

test('客户端与云端 18 类顺序、配饰子类及推荐资格一致', () => {
  let app
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'),
    { App(value) { app = value }, require: createRequire(path.join(__dirname, '../app.js')) })
  assert.deepEqual(CATEGORIES, ['外套', '短袖', '长袖', '衬衫', '羽绒服', '保暖衣', '毛衣', '家居服', '连衣裙', '长裙', '短裙', '长裤', '短裤', '配饰', '挂件', '包袋', '鞋', '其他'])
  assert.deepEqual(Array.from(app.globalData.categories), CATEGORIES)
  assert.deepEqual(ACCESSORY_TYPES, ['袜子', '帽子', '围巾', '首饰', '其他'])
  assert.deepEqual(Array.from(app.globalData.accessoryTypes), ACCESSORY_TYPES)
  for (const category of CATEGORIES) assert.equal(isRecommendable({ category }), category !== '其他', category)
  assert.equal(isRecommendable({ category: '配饰', subcategory: '其他' }), true)
  for (const value of [null, undefined, {}, { category: '未知' }, { category: '上衣' }]) assert.equal(isRecommendable(value), false)
})

test('18 类均可新增与更新，非配饰清空子类并保留原 ID 与历史引用', async () => {
  const c = loadCloud({ users: [user()], clothes: [{ _id: 'one', _openid: 'openid-1', ...item() }],
    outfits: [{ _id: 'look', _openid: 'openid-1', itemIds: ['one'] }],
    wear_records: [{ _id: 'wear', _openid: 'openid-1', date: '2026-10-01', itemIds: ['one'] }] })
  for (const category of CATEGORIES) {
    const data = { ...item(), category, subcategory: '其他' }
    const added = await c.main(dataCall('add', 'clothes', { data }))
    assert.equal(added.success, true, category)
    const updated = await c.main(dataCall('update', 'clothes', { id: 'one', data }))
    assert.equal(updated.success, true, category)
    for (const id of [added._id, 'one']) {
      const saved = c.records.clothes.find(row => row._id === id)
      assert.equal(saved.category, category)
      assert.equal(saved.subcategory, category === '配饰' ? '其他' : '')
      assert.equal(saved._openid, 'openid-1')
      assert.equal(saved.price, 10)
    }
  }
  assert.deepEqual(c.records.outfits[0].itemIds, ['one'])
  assert.deepEqual(c.records.wear_records[0].itemIds, ['one'])
  assert.equal(c.records.wardrobe_meta[0].version, CATEGORIES.length * 2)
})

test('旧大类和非法类别不能新增或更新，配饰仅接受五个合法子类', async () => {
  const c = loadCloud({ users: [user()], clothes: [{ _id: 'one', _openid: 'openid-1', ...item() }] })
  for (const category of ['上衣', '下装', '裤子', '裙子', '鞋子', '包', '旗袍', '未知', '']) {
    for (const operation of ['add', 'update']) {
      const result = await c.main(dataCall(operation, 'clothes', { id: 'one', data: { ...item(), category } }))
      assert.equal(result.success, false, category)
      assert.match(result.error, /类别无效/)
    }
  }
  for (const subcategory of ACCESSORY_TYPES) {
    const result = await c.main(dataCall('update', 'clothes', { id: 'one', data: { ...item(), category: '配饰', subcategory } }))
    assert.equal(result.success, true, subcategory)
    assert.equal(c.records.clothes[0].subcategory, subcategory)
  }
  for (const subcategory of ['', '手套']) {
    const result = await c.main(dataCall('update', 'clothes', { id: 'one', data: { ...item(), category: '配饰', subcategory } }))
    assert.equal(result.success, false)
    assert.match(result.error, /配饰类型无效/)
  }
  assert.equal(c.records.clothes.length, 1)
  assert.equal(c.records.clothes[0].subcategory, '其他')
  assert.equal(c.records.wardrobe_meta[0].version, ACCESSORY_TYPES.length)
})

test('清理入口只展示当前账号的 pending 任务，重试完成后隐藏', async () => {
  const c = loadCloud({ users: [user()], cleanup_jobs: [
    { _id: 'review', _openid: 'openid-1', state: 'review', kind: 'image' },
    { _id: 'foreign', _openid: 'openid-2', state: 'pending', kind: 'references', itemId: 'gone' }
  ] })
  const page = loadPage('profile', {
    cleanupStatus: () => c.main({ action: 'profile' })
      .then(result => ({ pendingCleanup: result.profile && result.profile.pendingCleanup === true })),
    retryCleanup: () => c.main({ action: 'retryCleanup' })
  })
  await page.refreshCleanupStatus()
  assert.equal(page.data.pendingCleanup, false)
  c.records.cleanup_jobs.push({ _id: 'own', _openid: 'openid-1', state: 'pending', kind: 'references', itemId: 'gone' })
  await page.refreshCleanupStatus()
  assert.equal(page.data.pendingCleanup, true)
  await page.onRetryCleanup()
  assert.equal(page.data.pendingCleanup, false)
  assert.equal(page.data.cleaning, false)
  assert.deepEqual(c.records.cleanup_jobs.map(job => job._id), ['review', 'foreign'])
  await c.main({ action: 'logout' })
  assert.equal((await c.main({ action: 'profile' })).success, false)
})

test('清理请求失败保留重试入口并解除按钮禁用', async () => {
  const page = loadPage('profile', { retryCleanup: async () => { throw Error('offline') } })
  page.setData({ pendingCleanup: true })
  await page.onRetryCleanup()
  assert.equal(page.data.pendingCleanup, true)
  assert.equal(page.data.cleaning, false)
})

test('测试账号不能接管绑定，失败的登录更新保留原状态', async () => {
  const review = { ...user(), _id: 'review', username: 'review', openid: 'openid-2', allowAnyOpenid: true }
  const c = loadCloud({ users: [user(), review] })
  assert.equal((await c.main({ action: 'login', username: 'review', password: 'secret1' })).success, false)
  assert.equal(c.records.users[0].openid, 'openid-1')
  c.records.users[0].autoLoginEnabled = false
  c.faults.before = (name, op) => { if (name === 'users' && op === 'update') throw Error('write failed') }
  assert.equal((await c.main({ action: 'login', username: 'alice', password: 'secret1' })).success, false)
  assert.equal(c.records.users[0].autoLoginEnabled, false)
  assert.equal(c.records.users[1].openid, 'openid-2')
})

test('同一码并发注册只成功一次，用户创建失败会回滚邀请码', async () => {
  const c = loadCloud({ invite_codes: [{ _id: 'code', code: 'INVITE', used: false }] })
  const results = await Promise.all(['alice', 'bob'].map(username => c.main({ action: 'register', username, password: 'secret1', registerCode: 'INVITE' })))
  assert.equal(results.filter(r => r.success).length, 1)
  assert.equal(c.records.users.length, 1)
  assert.equal(c.records.invite_codes[0].usedBy, c.records.users[0].username)
  const failed = loadCloud({ invite_codes: [{ _id: 'code', code: 'INVITE', used: false }] })
  failed.faults.before = (name, op) => { if (name === 'users' && op === 'set') throw Error('write failed') }
  assert.equal((await failed.main({ action: 'register', username: 'alice', password: 'secret1', registerCode: 'INVITE' })).success, false)
  assert.equal(failed.records.invite_codes[0].used, false)
  assert.equal(failed.records.users.length, 0)
})

test('并发失败计数不丢失，第五次锁定，过期可恢复', async () => {
  const c = loadCloud({ users: [user()] })
  await Promise.all(Array.from({ length: 5 }, () => c.main({ action: 'login', username: 'alice', password: 'wrong' })))
  assert.equal(c.records.auth_attempts.length, 1)
  assert.equal(c.records.auth_attempts[0].failures, 5)
  assert.match((await c.main({ action: 'login', username: 'alice', password: 'secret1' })).error, /分钟/)
  c.records.auth_attempts[0].lockedUntil = new Date(Date.now() - 1000)
  assert.equal((await c.main({ action: 'login', username: 'alice', password: 'secret1' })).success, true)
  assert.equal(c.records.auth_attempts.length, 0)
})

test('未注册、退出及跨身份的数据与上传调用被拒绝', async () => {
  const c = loadCloud({ users: [user()], clothes: [{ _id: 'own', _openid: 'openid-1', ...item() }, { _id: 'foreign', _openid: 'openid-2', ...item() }] })
  assert.equal((await c.main(dataCall('list', 'clothes', { offset: 0 }))).data.length, 1)
  for (const operation of ['get', 'update', 'delete']) assert.equal((await c.main(dataCall(operation, 'clothes', { id: 'foreign', data: item() }))).success, false)
  assert.equal((await c.main(dataCall('add', 'outfits', { data: { name: 'look', itemIds: ['foreign'] } }))).success, false)
  await c.main({ action: 'logout' })
  assert.equal((await c.main(dataCall('add', 'clothes', { data: item() }))).success, false)
  assert.equal((await c.main({ action: 'prepareUpload', directory: 'wardrobe', ext: 'jpg' })).success, false)
  c.setOpenid('unregistered')
  assert.equal((await c.main(dataCall('list', 'clothes', { offset: 0 }))).success, false)
})

test('保存验证字段、真实日期和衣物归属，不能注入系统字段', async () => {
  const c = loadCloud({ users: [user()] })
  for (const patch of [{ price: -1 }, { price: Infinity }, { purchaseDate: '2025-02-29' }, { seasons: ['invalid'] }, { name: { $ne: null } }]) {
    assert.equal((await c.main(dataCall('add', 'clothes', { data: { ...item(), ...patch } }))).success, false)
  }
  const result = await c.main(dataCall('add', 'clothes', { data: { ...item(), _openid: 'foreign', _id: 'injected' } }))
  assert.equal(result.success, true)
  assert.equal(c.records.clothes[0]._openid, 'openid-1')
  assert.notEqual(c.records.clothes[0]._id, 'injected')
})

test('图片票据验证归属，提交后客户端补偿不能误删新图', async () => {
  const c = loadCloud({ users: [user(), { ...user(), _id: 'second', openid: 'openid-2', username: 'bob' }] })
  const ticket = await c.main({ action: 'prepareUpload', directory: 'wardrobe', ext: 'jpg' })
  const fileID = 'cloud://test-env/' + ticket.cloudPath
  c.setOpenid('openid-2')
  assert.equal((await c.main(dataCall('add', 'clothes', { data: { ...item(), imageFileID: fileID } }))).success, false)
  assert.equal((await c.main({ action: 'removeImage', fileID })).success, false)
  assert.equal((await c.main({ action: 'updateProfile', avatarFileID: fileID })).success, false)
  c.setOpenid('openid-1')
  assert.equal((await c.main(dataCall('add', 'clothes', { data: { ...item(), imageFileID: fileID } }))).success, true)
  await c.main({ action: 'removeImage', fileID })
  assert.equal(c.deletedFiles.length, 0)
  assert.equal(c.records.clothes[0].imageFileID, fileID)
  const unused = await c.main({ action: 'prepareUpload', directory: 'wardrobe', ext: 'jpg' })
  const unusedFileID = 'cloud://test-env/' + unused.cloudPath
  assert.equal((await c.main({ action: 'removeImage', fileID: unusedFileID })).cleanupFailed, false)
  assert.deepEqual(c.deletedFiles, [unusedFileID])
})

test('引用与逐文件删除失败持久保存，重试保留并发新增单品和空穿搭', async () => {
  const token = 'a'.repeat(32), fileID = 'cloud://test-env/wardrobe/' + token + '.jpg'
  const c = loadCloud({ users: [user()], upload_tickets: [{ _id: token, _openid: 'openid-1', fileID, cloudPath: 'wardrobe/' + token + '.jpg', target: 'clothes/one' }], clothes: [{ _id: 'one', _openid: 'openid-1', ...item(), imageFileID: fileID }], outfits: [
    { _id: 'look', _openid: 'openid-1', itemIds: ['one', 'other'] },
    { _id: 'empty', _openid: 'openid-1', itemIds: ['one'] }
  ] })
  c.faults.deleteStatus = -1
  c.faults.before = (name, op) => { if (name === 'outfits' && op === 'update') throw Error('network') }
  const result = await c.main(dataCall('delete', 'clothes', { id: 'one' }))
  assert.equal(result.success, true)
  assert.equal(result.cleanupFailed, true)
  assert.equal(c.records.clothes.length, 0)
  assert.equal(c.records.cleanup_jobs.length, 2)
  c.records.outfits[0].itemIds.push('concurrent')
  c.faults.before = null
  c.faults.deleteStatus = 0
  assert.equal((await c.main({ action: 'retryCleanup' })).cleanupFailed, false)
  assert.deepEqual(c.records.outfits[0].itemIds, ['other', 'concurrent'])
  assert.deepEqual(c.records.outfits[1].itemIds, [])
  assert.deepEqual(c.deletedFiles, [fileID])
  assert.equal(c.records.cleanup_jobs.length, 0)
})

test('编辑加载失败禁止保存，重试成功恢复；依赖失败不读取穿搭', async () => {
  let reads = 0, writes = 0, fail = true
  const db = {
    getItem: async () => { if (fail) throw Error('offline'); return item() },
    listItems: async () => { if (fail) throw Error('offline'); return [{ _id: 'one', ...item() }] },
    getOutfit: async () => { reads++; return { name: 'look', itemIds: ['one'] } },
    updateItem: async () => { writes++; return {} }, updateOutfit: async () => { writes++; return {} }
  }
  const cloth = loadPage('item-edit', db), outfit = loadPage('outfit-edit', db)
  await cloth.loadItem('one')
  await cloth.onSave()
  await outfit.onLoad({ id: 'look' })
  await outfit.onSave()
  assert.equal(writes, 0)
  assert.equal(reads, 0)
  assert.equal(cloth.data.ready, false)
  assert.equal(outfit.data.ready, false)
  fail = false
  await outfit.onRetry()
  assert.equal(outfit.data.ready, true)
  await outfit.onSave()
  assert.equal(writes, 1)
})

test('数据库提交后尺码存储失败保留新图；提交失败仅清理新图', async () => {
  const deleted = []
  let fail = false
  const page = loadPage('item-edit', {
    uploadImage: async () => 'cloud://new',
    updateItem: async () => { if (fail) throw Error('write failed'); return {} },
    removeImage: id => deleted.push(id)
  }, { setStorageSync() { throw Error('disk full') } })
  Object.assign(page.data, { ...item(), id: 'one', ready: true, size: 'M', imagePath: '/tmp/new.jpg', imageFileID: 'cloud://old',
    categories: CATEGORIES, accessoryTypes: ACCESSORY_TYPES })
  await page.onSave()
  assert.deepEqual(deleted, [])
  page.data.saving = false
  fail = true
  await page.onSave()
  assert.deepEqual(deleted, ['cloud://new'])
})

test('穿搭详情读取失败后不能保存；重新加载后保留有效选择', async () => {
  let fail = true, writes = 0
  const page = loadPage('outfit-edit', {
    listItems: async () => [{ _id: 'one', ...item() }],
    getOutfit: async () => { if (fail) throw Error('offline'); return { name: 'look', itemIds: ['one', 'deleted'] } },
    updateOutfit: async () => { writes++; return {} }
  })
  await page.onLoad({ id: 'look' })
  await page.onSave()
  assert.equal(writes, 0)
  assert.equal(page.data.ready, false)
  fail = false
  await page.onRetry()
  assert.equal(page.data.selectedIds.join(','), 'one')
  await page.onSave()
  assert.equal(writes, 1)
})

test('头像提交成功后清理失败保留新图，提交失败回收新图', async () => {
  let fail = false
  const removed = []
  const page = loadPage('profile', {
    uploadImage: async () => 'cloud://new', removeImage: async id => { removed.push(id); return false }
  }, {}, { updateProfile: async () => { if (fail) throw Error('write failed') } })
  page.data.avatarFileID = 'cloud://old'
  await page.onChooseAvatar({ detail: { avatarUrl: 'local.jpg' } })
  assert.equal(page.data.avatarFileID, 'cloud://new')
  assert.deepEqual(removed, ['cloud://old'])
  fail = true
  await page.onChooseAvatar({ detail: { avatarUrl: 'local.jpg' } })
  assert.deepEqual(removed, ['cloud://old', 'cloud://new'])
})

test('刷新失败有重试状态，恢复后清除错误并更新数据', async () => {
  let fail = true, forced = false
  const page = loadPage('wardrobe', { listItems: async force => { forced = force; if (fail) throw Error('offline'); return [{ _id: 'one', ...item() }] } })
  page.onLoad()
  await page.onRetry()
  assert.ok(page.data.loadError)
  fail = false
  await page.onRetry()
  assert.equal(forced, true)
  assert.equal(page.data.loadError, '')
  assert.equal(page.data.items.length, 1)
  const unavailable = loadPage('wardrobe', {}, {}, { ensureLogin: async () => false })
  await unavailable.onShow()
  assert.equal(unavailable.data.loading, false)
  assert.ok(unavailable.data.loadError)
})

test('日期、月份边界及每日明细与月历金额一致', () => {
  assert.equal(validDate('2024-02-29'), true)
  for (const value of ['2025-02-29', '2024-04-31', '1999-12-31', '', 'x']) assert.equal(validDate(value), false)
  const page = loadPage('calendar')
  page._year = 2024; page._month = 2
  page._items = [{ _id: 'a', purchaseDate: '2024-02-29', price: 0.1 }, { _id: 'b', purchaseDate: '2024-02-29', price: 0.2 }, { price: 2 }, { purchaseDate: '2024-02-30', price: 3 }]
  page.render()
  page.selectDate('2024-02-29')
  assert.equal(page.data.monthTotal, 0.3)
  assert.equal(page.data.selectedTotal, 0.3)
  assert.equal(page.data.undatedTotal, 5)
  assert.equal(page.data.dayItems.length, 2)
  page._year = 2022; page._month = 1; page.render(); page.onPrevMonth()
  assert.equal(page._year, 2022); assert.equal(page._month, 1)
  page._year = 2030; page._month = 12; page.render(); page.onNextMonth()
  assert.equal(page._month, 12)
  page._year = 2024; page._month = 12; page.render(); page.onNextMonth()
  assert.equal(page._year, 2025); assert.equal(page._month, 1)
})

test('日期与统计年月范围均为 2022 至 2030 年，云端采用相同上限', async () => {
  const maxYear = 2030
  const edit = loadPage('item-edit')
  const calendar = loadPage('calendar')
  calendar.onLoad()
  calendar.openPicker()
  const years = edit.buildDateColumns(`${maxYear}-12-31`).columns[0]
  assert.equal(years[0], '2022')
  assert.equal(years.at(-1), String(maxYear))
  assert.deepEqual(Array.from(calendar.data.picker.columns[0]), Array.from(years))
  const c = loadCloud({ users: [user()] })
  for (const [date, valid] of [['2022-01-01', true], [`${maxYear}-12-31`, true], ['2021-12-31', false], [`${maxYear + 1}-01-01`, false]]) {
    assert.equal(validDate(date), valid)
    assert.equal((await c.main(dataCall('add', 'clothes', { data: { ...item(), purchaseDate: date } }))).success, valid)
  }
})

for (const collection of ['clothes', 'outfits']) {
  test(collection + '：写后旧查询与强制刷新交错不回填旧值', async () => {
    let release, requests = 0
    global.wx = { cloud: { callFunction: async ({ data }) => {
      if (data.operation !== 'list') return { result: { success: true } }
      requests++
      if (requests === 1) return new Promise(resolve => { release = () => resolve({ result: { success: true, data: [{ name: 'old' }] } }) })
      return { result: { success: true, data: [{ name: 'new' }] } }
    } } }
    delete require.cache[require.resolve('../utils/db')]
    const db = require('../utils/db')
    const list = collection === 'clothes' ? db.listItems : db.listOutfits
    const update = collection === 'clothes' ? db.updateItem : db.updateOutfit
    const pending = list()
    await update('one', {})
    assert.equal((await list(true))[0].name, 'new')
    release()
    assert.equal((await pending)[0].name, 'new')
    assert.equal((await list())[0].name, 'new')
    assert.equal(requests, 2)
  })
}
