const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')

const MODULE_PATH = require.resolve('../utils/db')

const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
const makeImage = ch => {
  const token = ch.repeat(32)
  return { fileID: `cloud://env/wardrobe/${token}.jpg`, ticket: { _id: token, _openid: 'openid-1', cloudPath: `wardrobe/${token}.jpg` } }
}
const imgA = makeImage('a')
const imgB = makeImage('b')
const dataCall = (operation, extra = {}) => ({ action: 'data', operation, collection: 'stickers', ...extra })
const owned = () => ({
  name: '古风小院', brand: '芯陌', series: '四季', channel: '淘宝', themeTag: '古风造景',
  purchasedAt: '2026-10-01', status: 'owned', imageFileID: imgA.fileID, price: 15.5, quantity: 2
})
const shanghaiDate = offset => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const day = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return new Date(Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day) + offset)).toISOString().slice(0, 10)
}

// ---------- ST-01 stickers 建模与创建 / 列表 ----------

test('贴纸建档成功，票据归属更新，列表与单条可回读', async () => {
  const c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket }] })
  const added = await c.main(dataCall('add', { data: owned() }))
  assert.equal(added.success, true)
  const row = c.records.stickers[0]
  assert.equal(row._openid, 'openid-1')
  assert.equal(row.name, '古风小院')
  assert.equal(row.brand, '芯陌')
  assert.equal(row.series, '四季')
  assert.equal(row.price, 15.5)
  assert.equal(row.quantity, 2)
  assert.equal(row.status, 'owned')
  assert.equal(row.themeTag, '古风造景')
  assert.equal(row.purchasedAt, '2026-10-01')
  assert.ok(row.createdAt)
  assert.equal(c.records.upload_tickets[0].target, `stickers/${added._id}`)
  const list = await c.main(dataCall('list', { offset: 0 }))
  assert.equal(list.data.length, 1)
  assert.equal(list.data[0].name, '古风小院')
  const got = await c.main(dataCall('get', { id: added._id }))
  assert.equal(got.data.name, '古风小院')
})

test('心愿单建档可缺省价格、数量与购入日期', async () => {
  const c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket }] })
  const added = await c.main(dataCall('add', { data: { name: '种草款', status: 'wishlist', imageFileID: imgA.fileID } }))
  assert.equal(added.success, true)
  const row = c.records.stickers[0]
  assert.equal(row.status, 'wishlist')
  assert.equal(row.price, null)
  assert.equal(row.quantity, 1)
  assert.equal(row.purchasedAt, '')
  assert.equal(row.brand, '')
  assert.equal(row.themeTag, '')
})

test('贴纸建档逐项校验拦截', async () => {
  const c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket }] })
  const valid = owned()
  for (const patch of [
    { name: '' }, { name: '   ' }, { imageFileID: '' },
    { status: 'done' }, { status: 'bad' }, { status: '' },
    { themeTag: '手帐' }, { purchasedAt: '2026-13-01' }, { purchasedAt: '2021-01-01' }, { purchasedAt: shanghaiDate(1) },
    { price: -1 }, { price: 'x' }, { price: 1e9 + 1 },
    { quantity: 0 }, { quantity: -2 }, { quantity: 1.5 }, { quantity: 'x' }, { quantity: 10000 },
    { doneAt: '2026-10-20' }, { doneImageFileID: imgA.fileID }
  ]) {
    assert.equal((await c.main(dataCall('add', { data: { ...valid, ...patch } }))).success, false, JSON.stringify(patch))
  }
  assert.equal(c.records.stickers.length, 0)
  const ok = await c.main(dataCall('add', { data: { ...valid, price: 15.555 } }))
  assert.equal(ok.success, true)
  assert.equal(c.records.stickers[0].price, 15.56)
})

test('贴纸封面图须经有效票据，无票、他人、取消或已用票据均被拒', async () => {
  let c = loadCloud({ users: [user()] })
  assert.equal((await c.main(dataCall('add', { data: owned() }))).success, false)
  c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket, _openid: 'openid-2' }] })
  assert.equal((await c.main(dataCall('add', { data: owned() }))).success, false)
  c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket, cancelled: true }] })
  assert.equal((await c.main(dataCall('add', { data: owned() }))).success, false)
  c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket, target: 'stickers/other' }] })
  assert.equal((await c.main(dataCall('add', { data: owned() }))).success, false)
  // itemScan 用途票据同样不能用于贴纸
  c = loadCloud({ users: [user()], upload_tickets: [{ ...imgA.ticket, target: 'itemScan', fileID: imgA.fileID }] })
  assert.equal((await c.main(dataCall('add', { data: owned() }))).success, false)
})

test('贴纸按身份隔离，列表支持状态过滤', async () => {
  const c = loadCloud({
    users: [user()],
    stickers: [
      { _id: 's1', _openid: 'openid-1', name: '库存款', status: 'owned' },
      { _id: 's2', _openid: 'openid-1', name: '心愿款', status: 'wishlist' },
      { _id: 's3', _openid: 'openid-1', name: '已拼贴', status: 'done' },
      { _id: 's4', _openid: 'openid-2', name: '他人款', status: 'owned' }
    ]
  })
  const all = await c.main(dataCall('list', { offset: 0 }))
  assert.deepEqual(all.data.map(row => row._id).sort(), ['s1', 's2', 's3'])
  const wishes = await c.main(dataCall('list', { offset: 0, status: 'wishlist' }))
  assert.deepEqual(wishes.data.map(row => row._id), ['s2'])
  const done = await c.main(dataCall('list', { offset: 0, status: 'done' }))
  assert.deepEqual(done.data.map(row => row._id), ['s3'])
  assert.equal((await c.main(dataCall('list', { offset: 0, status: 'bad' }))).success, false)
  assert.equal((await c.main(dataCall('get', { id: 's4' }))).success, false)
})

test('贴纸分页全量读取覆盖超过一页与整页边界，缓存复用且强制刷新重新分页', async () => {
  for (const count of [21, 40, 45]) {
    const rows = Array.from({ length: count }, (_, index) => ({
      _id: `sticker-${index}`, _openid: 'openid-1', name: `贴纸${index}`,
      status: ['owned', 'done', 'wishlist'][index % 3]
    }))
    const cloud = loadCloud({ users: [user()], stickers: [
      { _id: 'foreign', _openid: 'openid-2', status: 'owned' }, ...rows
    ] })
    const offsets = []
    global.wx = { cloud: { callFunction: async ({ data }) => {
      assert.equal(data.collection, 'stickers')
      assert.equal(data.operation, 'list')
      offsets.push(data.offset)
      return { result: await cloud.main(data) }
    } } }
    delete require.cache[MODULE_PATH]
    const api = require(MODULE_PATH)
    const result = await api.listStickers()
    const expectedOffsets = Array.from({ length: Math.floor(count / 20) + 1 }, (_, index) => index * 20)
    assert.deepEqual(result.map(row => row._id), rows.map(row => row._id))
    assert.equal(new Set(result.map(row => row._id)).size, count)
    assert.deepEqual(offsets, expectedOffsets)
    await api.listStickers()
    assert.deepEqual(offsets, expectedOffsets)
    assert.equal((await api.listStickers(true)).length, count)
    assert.deepEqual(offsets, [...expectedOffsets, ...expectedOffsets])
  }
})

// ---------- ST-02 stickerUpdate 普通编辑与状态流转 ----------

const seedSticker = patch => ({
  _id: 's1', _openid: 'openid-1', name: '库存款', brand: '', series: '', channel: '', themeTag: '',
  purchasedAt: '2026-10-01', status: 'owned', doneAt: '', doneImageFileID: '',
  imageFileID: imgA.fileID, price: 15.5, quantity: 2, ...patch
})
const form = patch => ({
  name: '库存款', brand: '', series: '', channel: '', themeTag: '',
  purchasedAt: '2026-10-01', status: 'owned', doneAt: '', doneImageFileID: '',
  imageFileID: imgA.fileID, price: 15.5, quantity: 2, ...patch
})
const usedTicketA = { ...imgA.ticket, target: 'stickers/s1', fileID: imgA.fileID }

test('普通编辑保持状态并刷新 updatedAt，封面替换走票据与清理', async () => {
  const c = loadCloud({
    users: [user()],
    upload_tickets: [{ ...usedTicketA }, { ...imgB.ticket }],
    stickers: [seedSticker()]
  })
  const updated = await c.main(dataCall('update', { id: 's1', data: form({ name: '新名称', price: 20, imageFileID: imgB.fileID }) }))
  assert.equal(updated.success, true)
  const row = c.records.stickers[0]
  assert.equal(row.name, '新名称')
  assert.equal(row.price, 20)
  assert.equal(row.status, 'owned')
  assert.equal(row.imageFileID, imgB.fileID)
  assert.ok(row.updatedAt)
  assert.equal(c.records.upload_tickets[1].target, 'stickers/s1')
  assert.ok(c.deletedFiles.includes(imgA.fileID))
})

test('心愿转库存价格与日期可选，填写时仍校验合法性', async () => {
  const wish = () => seedSticker({ status: 'wishlist', price: null, quantity: 1, purchasedAt: '' })
  for (const patch of [
    { price: 0, purchasedAt: '2026-10-15', quantity: 3 },
    { price: '', purchasedAt: '' }, { price: null, purchasedAt: '' },
    { price: undefined, purchasedAt: undefined },
    { price: 0, purchasedAt: '' }, { price: 15.5, purchasedAt: '' },
    { price: null, purchasedAt: '2026-10-15' }
  ]) {
    const c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }], stickers: [wish()] })
    const r = await c.main(dataCall('update', { id: 's1', data: form({ quantity: undefined, ...patch }) }))
    assert.equal(r.success, true, JSON.stringify(patch))
    assert.equal(c.records.stickers[0].status, 'owned')
    assert.equal(c.records.stickers[0].price, patch.price === '' || patch.price == null ? null : patch.price)
    assert.equal(c.records.stickers[0].purchasedAt, patch.purchasedAt || '')
    assert.equal(c.records.stickers[0].quantity, patch.quantity || 1)
  }
  for (const patch of [
    { price: -1 }, { price: 'x' }, { price: 1e9 + 1 },
    { purchasedAt: '2026-13-01' }, { purchasedAt: shanghaiDate(1) },
    { quantity: 0 }, { quantity: 1.5 },
    { doneAt: shanghaiDate(0) }, { doneImageFileID: imgB.fileID }
  ]) {
    const c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }], stickers: [wish()] })
    const r = await c.main(dataCall('update', { id: 's1', data: form({ price: null, purchasedAt: '', ...patch }) }))
    assert.equal(r.success, false, JSON.stringify(patch))
    assert.equal(c.records.stickers[0].status, 'wishlist')
  }
})

test('标记已拼贴须完成日期与作品照齐备且作品照有票据', async () => {
  const doneData = patch => form({ status: 'done', doneAt: shanghaiDate(0), doneImageFileID: imgB.fileID, ...patch })
  // 齐备：流转成功，作品照票据归属 stickers/<id>/done
  let c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }, { ...imgB.ticket }], stickers: [seedSticker()] })
  let r = await c.main(dataCall('update', { id: 's1', data: doneData() }))
  assert.equal(r.success, true)
  assert.equal(c.records.stickers[0].status, 'done')
  assert.equal(c.records.stickers[0].doneAt, shanghaiDate(0))
  assert.equal(c.records.stickers[0].doneImageFileID, imgB.fileID)
  assert.equal(c.records.upload_tickets[1].target, 'stickers/s1/done')
  // 缺完成日期 / 缺作品照 / 完成日期为未来：拒绝且保持库存态
  for (const patch of [{ doneAt: '' }, { doneImageFileID: '' }, { doneAt: shanghaiDate(1) }, { doneAt: '2026-13-01' }]) {
    c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }, { ...imgB.ticket }], stickers: [seedSticker()] })
    r = await c.main(dataCall('update', { id: 's1', data: doneData(patch) }))
    assert.equal(r.success, false, JSON.stringify(patch))
    assert.equal(c.records.stickers[0].status, 'owned')
  }
  // 作品照无票据：归属校验拒绝
  c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }], stickers: [seedSticker()] })
  r = await c.main(dataCall('update', { id: 's1', data: doneData() }))
  assert.equal(r.success, false)
  assert.equal(c.records.stickers[0].status, 'owned')
})

test('撤销完成清除完成字段，作品照入清理链路', async () => {
  const doneSeed = () => seedSticker({ status: 'done', doneAt: '2026-10-19', doneImageFileID: imgB.fileID })
  const doneTicketB = { ...imgB.ticket, target: 'stickers/s1/done', fileID: imgB.fileID }
  let c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }, { ...doneTicketB }], stickers: [doneSeed()] })
  const r = await c.main(dataCall('update', { id: 's1', data: form({ status: 'owned' }) }))
  assert.equal(r.success, true)
  assert.equal(c.records.stickers[0].status, 'owned')
  assert.equal(c.records.stickers[0].doneAt, '')
  assert.equal(c.records.stickers[0].doneImageFileID, '')
  assert.ok(c.deletedFiles.includes(imgB.fileID))
  // 撤销时携带完成字段：拒绝且保持已拼贴态
  c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }, { ...doneTicketB }], stickers: [doneSeed()] })
  const rejected = await c.main(dataCall('update', { id: 's1', data: form({ status: 'owned', doneImageFileID: imgB.fileID }) }))
  assert.equal(rejected.success, false)
  assert.equal(c.records.stickers[0].status, 'done')
})

test('禁止已购回退心愿单与心愿直接标记完成', async () => {
  let c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }], stickers: [seedSticker()] })
  const demote = await c.main(dataCall('update', { id: 's1', data: form({ status: 'wishlist' }) }))
  assert.equal(demote.success, false)
  assert.match(demote.error, /回退为心愿单/)
  assert.equal(c.records.stickers[0].status, 'owned')
  c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }], stickers: [seedSticker({ status: 'wishlist', price: null, purchasedAt: '' })] })
  const jump = await c.main(dataCall('update', { id: 's1', data: form({ status: 'done', doneAt: shanghaiDate(0), doneImageFileID: imgB.fileID }) }))
  assert.equal(jump.success, false)
  assert.match(jump.error, /先转为库存/)
  assert.equal(c.records.stickers[0].status, 'wishlist')
})

test('已拼贴记录编辑须保留完成字段，非本人记录不可改', async () => {
  const doneSeed = () => seedSticker({ status: 'done', doneAt: '2026-10-19', doneImageFileID: imgB.fileID })
  const tickets = () => [{ ...usedTicketA }, { ...imgB.ticket, target: 'stickers/s1/done', fileID: imgB.fileID }]
  // 保留完成字段的编辑：成功
  let c = loadCloud({ users: [user()], upload_tickets: tickets(), stickers: [doneSeed()] })
  let r = await c.main(dataCall('update', { id: 's1', data: form({ name: '改名', status: 'done', doneAt: '2026-10-19', doneImageFileID: imgB.fileID }) }))
  assert.equal(r.success, true)
  assert.equal(c.records.stickers[0].name, '改名')
  assert.equal(c.records.stickers[0].doneAt, '2026-10-19')
  // 丢失完成字段：拒绝
  c = loadCloud({ users: [user()], upload_tickets: tickets(), stickers: [doneSeed()] })
  r = await c.main(dataCall('update', { id: 's1', data: form({ status: 'done' }) }))
  assert.equal(r.success, false)
  assert.match(r.error, /已拼贴需保留/)
  // 非本人记录：拒绝
  c = loadCloud({ users: [user()], upload_tickets: tickets(), stickers: [seedSticker({ _openid: 'openid-2' })] })
  r = await c.main(dataCall('update', { id: 's1', data: form() }))
  assert.equal(r.success, false)
  assert.equal(c.records.stickers[0].name, '库存款')
})

// ---------- ST-03 stickerDelete 与图片清理链路 ----------

test('删除已拼贴贴纸：记录硬删，封面图与作品照均清理', async () => {
  const c = loadCloud({
    users: [user()],
    upload_tickets: [{ ...usedTicketA }, { ...imgB.ticket, target: 'stickers/s1/done', fileID: imgB.fileID }],
    stickers: [seedSticker({ status: 'done', doneAt: '2026-10-19', doneImageFileID: imgB.fileID })]
  })
  const r = await c.main(dataCall('delete', { id: 's1' }))
  assert.equal(r.success, true)
  assert.equal(c.records.stickers.length, 0)
  assert.ok(c.deletedFiles.includes(imgA.fileID))
  assert.ok(c.deletedFiles.includes(imgB.fileID))
  assert.equal(c.records.cleanup_jobs.length, 0)
  const list = await c.main(dataCall('list', { offset: 0 }))
  assert.equal(list.data.length, 0)
})

test('删除心愿单贴纸：无完成字段同样正常', async () => {
  const c = loadCloud({
    users: [user()],
    upload_tickets: [{ ...usedTicketA }],
    stickers: [seedSticker({ status: 'wishlist', price: null, quantity: 1, purchasedAt: '' })]
  })
  const r = await c.main(dataCall('delete', { id: 's1' }))
  assert.equal(r.success, true)
  assert.equal(c.records.stickers.length, 0)
  assert.deepEqual(c.deletedFiles, [imgA.fileID])
})

test('非本人贴纸删除被拒，记录与图片保留', async () => {
  const c = loadCloud({
    users: [user()],
    upload_tickets: [{ ...usedTicketA }],
    stickers: [seedSticker({ _openid: 'openid-2' })]
  })
  const r = await c.main(dataCall('delete', { id: 's1' }))
  assert.equal(r.success, false)
  assert.equal(c.records.stickers.length, 1)
  assert.deepEqual(c.deletedFiles, [])
})

// ---------- ST-04 贴纸图片上传链路（stickers/ 目录） ----------

const imgS = (() => {
  const token = 'd'.repeat(32)
  return { fileID: `cloud://env/stickers/${token}.jpg`, ticket: { _id: token, _openid: 'openid-1', cloudPath: `stickers/${token}.jpg` } }
})()

test('prepareUpload 开放 stickers 目录，其他目录与格式仍被拒', async () => {
  const c = loadCloud({ users: [user()] })
  const ticket = await c.main({ action: 'prepareUpload', directory: 'stickers', ext: 'png' })
  assert.equal(ticket.success, true)
  assert.match(ticket.cloudPath, /^stickers\/[a-f0-9]{32}\.png$/)
  assert.equal(c.records.upload_tickets[0].cloudPath, ticket.cloudPath)
  assert.equal((await c.main({ action: 'prepareUpload', directory: 'other', ext: 'jpg' })).success, false)
  assert.equal((await c.main({ action: 'prepareUpload', directory: 'stickers', ext: 'bmp' })).success, false)
  assert.equal(c.records.upload_tickets.length, 1)
})

test('stickers 目录图片可建档，未使用的贴纸图可补偿清理', async () => {
  // stickers 目录票据建档：claimImage 认可新目录
  let c = loadCloud({ users: [user()], upload_tickets: [{ ...imgS.ticket }] })
  const added = await c.main(dataCall('add', { data: { ...owned(), imageFileID: imgS.fileID } }))
  assert.equal(added.success, true)
  assert.equal(c.records.stickers[0].imageFileID, imgS.fileID)
  assert.equal(c.records.upload_tickets[0].target, `stickers/${added._id}`)
  // 上传后放弃建档：removeImage 补偿路径对 stickers 目录生效
  c = loadCloud({ users: [user()] })
  const ticket = await c.main({ action: 'prepareUpload', directory: 'stickers', ext: 'jpg' })
  const unused = 'cloud://test-env/' + ticket.cloudPath
  const removed = await c.main({ action: 'removeImage', fileID: unused })
  assert.equal(removed.cleanupFailed, false)
  assert.deepEqual(c.deletedFiles, [unused])
})

test('客户端贴纸上传方法走 stickers 目录直传链路', async () => {
  const calls = []
  const token = 'e'.repeat(32)
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => {
        calls.push(data)
        return { result: { success: true, cloudPath: `stickers/${token}.jpg` } }
      },
      uploadFile: async ({ cloudPath, filePath }) => {
        assert.equal(cloudPath, `stickers/${token}.jpg`)
        assert.equal(filePath, '/tmp/pic.jpg')
        return { fileID: 'cloud://env/' + cloudPath }
      }
    },
    compressImage: ({ src, success }) => success({ tempFilePath: src })
  }
  delete require.cache[MODULE_PATH]
  const api = require(MODULE_PATH)
  const fileID = await api.uploadStickerImage('/tmp/pic.jpg')
  assert.equal(calls[0].action, 'prepareUpload')
  assert.equal(calls[0].directory, 'stickers')
  assert.equal(calls[0].ext, 'jpg')
  assert.equal(fileID, `cloud://env/stickers/${token}.jpg`)
})

test('客户端读写方法走 data 动作并维护缓存', async () => {
  const calls = []
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => {
        calls.push(data)
        if (data.operation === 'list') return { result: { success: true, data: [{ _id: 's1', status: 'owned' }] } }
        return { result: { success: true, _id: 'new-id' } }
      }
    }
  }
  delete require.cache[MODULE_PATH]
  const api = require(MODULE_PATH)
  const id = await api.addSticker({ name: '款', status: 'owned', imageFileID: 'cloud://x' })
  assert.equal(id, 'new-id')
  assert.deepEqual([calls[0].action, calls[0].operation, calls[0].collection], ['data', 'add', 'stickers'])
  const list = await api.listStickers()
  assert.equal(list.length, 1)
  assert.deepEqual([calls[1].action, calls[1].operation, calls[1].collection], ['data', 'list', 'stickers'])
  // 缓存有效期内重复读取不再请求
  await api.listStickers()
  assert.equal(calls.filter(call => call.operation === 'list').length, 1)
  // 删除走 delete 操作并失效缓存
  await api.deleteSticker('s1')
  assert.deepEqual([calls.at(-1).action, calls.at(-1).operation, calls.at(-1).collection, calls.at(-1).id], ['data', 'delete', 'stickers', 's1'])
  await api.listStickers()
  assert.equal(calls.filter(call => call.operation === 'list').length, 2)
})

// ---------- ST-05 贴纸建档编辑页 ----------

test('贴纸页按库存与心愿模式提交完整载荷', async () => {
  const saved = []
  const makePage = () => loadPage('sticker-edit', {
    uploadStickerImage: async path => `cloud://env/stickers/${path.slice(1)}.jpg`,
    addSticker: async data => { saved.push(data); return 'new-id' }
  })

  const ownedPage = makePage()
  await ownedPage.onLoad({})
  ownedPage.setData({
    name: ' 古风小院 ', brand: ' 芯陌 ', series: ' 四季 ', price: '15.555', quantity: '2',
    purchasedAt: '2026-10-01', channel: ' 淘宝 ', themeTag: '古风造景', imagePath: '/owned'
  })
  await ownedPage.onSave()
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0])), {
    name: '古风小院', brand: '芯陌', series: '四季', price: 15.555, quantity: 2,
    purchasedAt: '2026-10-01', channel: '淘宝', themeTag: '古风造景', status: 'owned',
    doneAt: '', imageFileID: 'cloud://env/stickers/owned.jpg', doneImageFileID: ''
  })

  const wishPage = makePage()
  await wishPage.onLoad({})
  wishPage.onStatusTap({ currentTarget: { dataset: { value: 'wishlist' } } })
  wishPage.setData({ name: '种草款', quantity: '', imageFileID: 'cloud://env/stickers/wish.jpg' })
  await wishPage.onSave()
  assert.equal(saved[1].status, 'wishlist')
  assert.equal(saved[1].price, null)
  assert.equal(saved[1].quantity, 1)
  assert.equal(saved[1].purchasedAt, '')
})

test('贴纸页前置拦截名称、封面与数量错误', async () => {
  const messages = []
  let writes = 0
  const page = loadPage('sticker-edit', { addSticker: async () => { writes++ } }, {
    showToast: ({ title }) => messages.push(title)
  })
  await page.onLoad({})
  await page.onSave()
  page.setData({ name: '款' })
  await page.onSave()
  page.setData({ imageFileID: 'cloud://env/stickers/a.jpg', quantity: '1.5' })
  await page.onSave()
  assert.deepEqual(messages, ['请填写名称', '请上传封面图', '请输入 1 至 9999 的整数数量'])
  assert.equal(writes, 0)
})

test('贴纸编辑页载入回显并保持原状态普通保存', async () => {
  let updated
  const page = loadPage('sticker-edit', {
    listStickers: async () => [{
      _id: 's1', name: '旧名', brand: '品牌', series: '系列', price: 20, quantity: 3,
      purchasedAt: '2026-10-02', channel: '展会', themeTag: '节日', status: 'done',
      imageFileID: 'cloud://env/stickers/cover.jpg', doneAt: '2026-10-20',
      doneImageFileID: 'cloud://env/stickers/done.jpg'
    }],
    updateSticker: async (id, data) => { updated = { id, data }; return {} }
  })
  await page.onLoad({ id: 's1' })
  assert.equal(page.data.name, '旧名')
  assert.equal(page.data.status, 'done')
  assert.equal(page.data.quantity, '3')
  page.onStatusTap({ currentTarget: { dataset: { value: 'wishlist' } } })
  page.setData({ name: '新名' })
  await page.onSave()
  assert.equal(page.data.status, 'done')
  assert.equal(updated.id, 's1')
  assert.equal(updated.data.name, '新名')
  assert.equal(updated.data.doneAt, '2026-10-20')
  assert.equal(updated.data.doneImageFileID, 'cloud://env/stickers/done.jpg')
})

test('已拼贴作品照点击全屏预览，无作品照不响应', async () => {
  const previews = []
  const page = loadPage('sticker-edit', {
    listStickers: async () => [{
      _id: 's1', name: '咖啡街景', status: 'done', imageFileID: 'cloud://env/stickers/cover.jpg',
      doneAt: '2026-10-20', doneImageFileID: 'cloud://env/stickers/done.jpg'
    }]
  }, { previewImage: opts => previews.push(opts.urls) })
  await page.onLoad({ id: 's1' })
  page.onPreviewDoneImage()
  assert.deepEqual(previews.map(urls => Array.from(urls)), [['cloud://env/stickers/done.jpg']])
  page.setData({ doneImageFileID: '' })
  page.onPreviewDoneImage()
  assert.equal(previews.length, 1)
})

test('贴纸封面上传失败保留表单并可原样重试', async () => {
  let attempts = 0
  let saved
  const messages = []
  const page = loadPage('sticker-edit', {
    uploadStickerImage: async () => {
      attempts++
      if (attempts === 1) throw new Error('upload failed')
      return 'cloud://env/stickers/retry.jpg'
    },
    addSticker: async data => { saved = data; return 'new-id' }
  }, { showToast: ({ title }) => messages.push(title) })
  await page.onLoad({})
  page.setData({ name: '重试款', imagePath: '/tmp/retry.jpg' })
  await page.onSave()
  assert.equal(page.data.name, '重试款')
  assert.equal(page.data.imagePath, '/tmp/retry.jpg')
  assert.equal(page.data.saving, false)
  assert.equal(saved, undefined)
  await page.onSave()
  assert.equal(attempts, 2)
  assert.equal(saved.imageFileID, 'cloud://env/stickers/retry.jpg')
  assert.deepEqual(messages, ['保存失败，请重试', '已保存'])
})

// ---------- ST-06 贴纸主页与个人页入口 ----------

const stickerRows = () => [
  { _id: 'owned', name: '古风小院', brand: '芯陌', series: '四季', status: 'owned', imageFileID: 'cloud://owned' },
  { _id: 'done', name: '咖啡街景', brand: '纸间', series: '城市', status: 'done', imageFileID: 'cloud://done' },
  { _id: 'wish', name: '海边假日', brand: '造物社', series: '自然', status: 'wishlist', imageFileID: 'cloud://wish' }
]

test('贴纸主页按库存与心愿单归类并保留已拼贴角标状态', async () => {
  const page = loadPage('stickers', { listStickers: async () => stickerRows() })
  await page.onShow()
  assert.deepEqual(Array.from(page.data.items, item => item._id), ['owned', 'done'])
  assert.equal(page.data.items[1].status, 'done')
  page.onTabTap({ currentTarget: { dataset: { value: 'wishlist' } } })
  assert.deepEqual(Array.from(page.data.items, item => item._id), ['wish'])
})

test('贴纸主页新增、卡片与个人页入口跳转正确', () => {
  const urls = []
  const wx = { navigateTo: ({ url }) => urls.push(url) }
  const page = loadPage('stickers', {}, wx)
  page.onAddTap()
  page.onItemTap({ currentTarget: { dataset: { id: 's1' } } })
  const profile = loadPage('profile', {}, wx)
  profile.onStickersTap()
  assert.deepEqual(urls, [
    '/pages/sticker-edit/sticker-edit',
    '/pages/sticker-edit/sticker-edit?id=s1',
    '/pages/stickers/stickers'
  ])
})

// ---------- ST-07 stickerStats 聚合与主页统计区 ----------

test('stickerStats 聚合库存与心愿口径、品牌与主题分布', async () => {
  const c = loadCloud({
    users: [user()],
    stickers: [
      { _id: 'a', _openid: 'openid-1', status: 'owned', brand: '芯陌', themeTag: '古风造景', price: 10, quantity: 2 },
      { _id: 'b', _openid: 'openid-1', status: 'done', brand: ' 芯陌 ', themeTag: '古风造景', price: 5.5, quantity: 2 },
      { _id: 'c', _openid: 'openid-1', status: 'owned', brand: ' ', themeTag: '', price: null },
      { _id: 'd', _openid: 'openid-1', status: 'owned', brand: '纸间', themeTag: '其他', price: 8, quantity: 1 },
      { _id: 'e', _openid: 'openid-1', status: 'wishlist', brand: '造物社', price: 30, quantity: 1 },
      { _id: 'f', _openid: 'openid-1', status: 'wishlist', price: null, quantity: 2 },
      { _id: 'g', _openid: 'openid-2', status: 'owned', brand: '他人', price: 999, quantity: 1 }
    ]
  })
  const r = await c.main({ action: 'stickerStats' })
  assert.equal(r.success, true)
  // 库存 = owned + done：20 + 11 + 0（缺价按 0、缺数量按 1）+ 8；心愿缺价不计
  assert.equal(r.stats.ownedCount, 4)
  assert.equal(r.stats.ownedSpent, 39)
  assert.equal(r.stats.doneCount, 1)
  assert.equal(r.stats.wishCount, 2)
  assert.equal(r.stats.wishTotal, 30)
  // 品牌：trim 后归组，空归「未填」，按花费降序
  assert.deepEqual(r.stats.brands, [
    { name: '芯陌', count: 2, spent: 31 },
    { name: '纸间', count: 1, spent: 8 },
    { name: '未填', count: 1, spent: 0 }
  ])
  // 主题：空标签与预设「其他」同组；计数并列按预设顺序
  assert.deepEqual(r.stats.themes, [
    { name: '古风造景', count: 2, percent: 50 },
    { name: '其他', count: 2, percent: 50 }
  ])
})

test('stickerStats 空数据返回零值，未登录被拒', async () => {
  const c = loadCloud({ users: [user()] })
  const r = await c.main({ action: 'stickerStats' })
  assert.equal(r.success, true)
  assert.deepEqual(r.stats, {
    ownedCount: 0, ownedSpent: 0, doneCount: 0, wishCount: 0, wishTotal: 0, brands: [], themes: []
  })
  c.setOpenid('stranger')
  assert.equal((await c.main({ action: 'stickerStats' })).success, false)
})

const statsFixture = () => ({
  ownedCount: 3, ownedSpent: 31, doneCount: 1, wishCount: 1, wishTotal: 30,
  brands: [{ name: '芯陌', count: 2, spent: 31 }, { name: '未填', count: 1, spent: 0 }],
  themes: [{ name: '古风造景', count: 2, percent: 100 }]
})

test('贴纸主页统计区常驻展示拥有、已贴、未贴与开销', async () => {
  const page = loadPage('stickers', { listStickers: async () => stickerRows(), stickerStats: async () => statsFixture() })
  // 数据到达前默认值为 0
  assert.deepEqual({ ...page.data.statsView }, { owned: 0, done: 0, undone: 0, spent: 0 })
  await page.onShow()
  // 拥有 = 库存（含已拼贴）3，已贴 1，未贴 = 3 - 1
  assert.deepEqual({ ...page.data.statsView }, { owned: 3, done: 1, undone: 2, spent: 31 })
  page.onTabTap({ currentTarget: { dataset: { value: 'wishlist' } } })
  assert.equal(page.data.statsView.spent, 31)
})

test('贴纸主页统计空数据默认 0，加载失败保留当前统计且不影响列表', async () => {
  const empty = loadPage('stickers', {
    listStickers: async () => [],
    stickerStats: async () => ({ ownedCount: 0, ownedSpent: 0, doneCount: 0, wishCount: 0, wishTotal: 0, brands: [], themes: [] })
  })
  await empty.onShow()
  assert.deepEqual({ ...empty.data.statsView }, { owned: 0, done: 0, undone: 0, spent: 0 })

  let statsUnavailable = true
  const failed = loadPage('stickers', {
    listStickers: async () => stickerRows(),
    stickerStats: async () => {
      if (statsUnavailable) throw Error('offline')
      return statsFixture()
    }
  })
  await failed.onShow()
  assert.deepEqual({ ...failed.data.statsView }, { owned: 0, done: 0, undone: 0, spent: 0 })
  assert.equal(failed.data.items.length, 2)
  assert.equal(failed.data.loadError, '')
  statsUnavailable = false
  await failed.onShow()
  assert.equal(failed.data.statsView.spent, 31)
  statsUnavailable = true
  await failed.onShow()
  assert.deepEqual({ ...failed.data.statsView }, { owned: 3, done: 1, undone: 2, spent: 31 })
})

// ---------- ST-08 编辑页状态动作：转正 / 标记完成 / 撤销 / 删除 ----------

const { today } = require('../utils/date')

const editRows = {
  wish: { _id: 'w1', name: '心愿款', brand: '', series: '', price: null, quantity: 1, purchasedAt: '', channel: '', themeTag: '', status: 'wishlist', doneAt: '', doneImageFileID: '', imageFileID: 'cloud://env/stickers/cover-w.jpg' },
  owned: { _id: 'o1', name: '库存款', brand: '芯陌', series: '', price: 15, quantity: 2, purchasedAt: '2026-10-01', channel: '', themeTag: '', status: 'owned', doneAt: '', doneImageFileID: '', imageFileID: 'cloud://env/stickers/cover-o.jpg' },
  done: { _id: 'd1', name: '完成款', brand: '', series: '', price: 20, quantity: 1, purchasedAt: '2026-09-01', channel: '', themeTag: '', status: 'done', doneAt: '2026-10-19', doneImageFileID: 'cloud://env/stickers/done-d.jpg', imageFileID: 'cloud://env/stickers/cover-d.jpg' }
}

test('心愿转库存允许单价与日期留空，非法填值仍被前置拦截', async () => {
  const calls = []
  const messages = []
  const makePage = () => loadPage('sticker-edit', {
    listStickers: async () => [editRows.wish],
    updateSticker: async (id, data) => { calls.push({ id, data }); return {} }
  }, { showToast: ({ title }) => messages.push(title) })
  for (const patch of [
    { price: '', purchasedAt: '' }, { price: '0', purchasedAt: '' },
    { price: '10', purchasedAt: '' }, { price: '', purchasedAt: '2026-10-20' },
    { price: '0', purchasedAt: '2026-10-20' }
  ]) {
    const page = makePage()
    await page.onLoad({ id: 'w1' })
    page.setData(patch)
    const before = calls.length
    await page.onConvert()
    assert.equal(calls.length, before + 1)
    assert.equal(calls.at(-1).id, 'w1')
    assert.equal(calls.at(-1).data.status, 'owned')
    assert.equal(calls.at(-1).data.price, patch.price === '' ? null : Number(patch.price))
    assert.equal(calls.at(-1).data.purchasedAt, patch.purchasedAt)
    assert.equal(messages.at(-1), '已保存')
  }
  for (const patch of [
    { price: '-1' }, { price: 'x' }, { price: String(1e9 + 1) },
    { purchasedAt: '2026-13-01' }, { purchasedAt: shanghaiDate(1) },
    { quantity: '0' }
  ]) {
    const page = makePage()
    await page.onLoad({ id: 'w1' })
    page.setData(patch)
    const before = calls.length
    await page.onConvert()
    assert.equal(calls.length, before)
    assert.equal(page.data.status, 'wishlist')
    assert.match(messages.at(-1), /请输入有效单价|请选择有效购入日期|请输入 1 至 9999 的整数数量/)
  }
  // 服务端拒绝：保留编辑内容，状态机不被本地改写
  const broken = loadPage('sticker-edit', {
    listStickers: async () => [editRows.wish],
    updateSticker: async () => { throw Error('x') }
  }, { showToast: ({ title }) => messages.push(title) })
  await broken.onLoad({ id: 'w1' })
  broken.setData({ price: '10', purchasedAt: '2026-10-20' })
  await broken.onConvert()
  assert.equal(broken.data.saving, false)
  assert.equal(broken.data.status, 'wishlist')
  assert.equal(broken.data.price, '10')
  assert.equal(messages.at(-1), '保存失败，请重试')
})

test('标记完成弹层：作品照必传，确认提交 done 载荷且封面不重复上传', async () => {
  const calls = [], uploads = [], messages = []
  const page = loadPage('sticker-edit', {
    listStickers: async () => [editRows.owned],
    chooseImage: async () => '/tmp/done.jpg',
    uploadStickerImage: async path => { uploads.push(path); return 'cloud://env/stickers/uploaded-done.jpg' },
    updateSticker: async (id, data) => { calls.push({ id, data }); return {} }
  }, { showToast: ({ title }) => messages.push(title) })
  await page.onLoad({ id: 'o1' })
  page.onOpenDoneSheet()
  assert.equal(page.data.doneSheet.show, true)
  assert.equal(page.data.doneSheet.doneAt, today())
  await page.onConfirmDone()
  assert.deepEqual(messages, ['请上传作品照'])
  assert.equal(calls.length, 0)
  await page.onChooseDoneImage()
  assert.equal(page.data.doneSheet.imagePath, '/tmp/done.jpg')
  // 日期类型参与共用联动，field 将确认值路由到弹层日期
  page.openDoneDatePicker()
  assert.equal(page.data.picker.target, 'date')
  assert.equal(page.data.picker.field, 'doneAt')
  const cols = page.data.picker.columns
  page.onPickerConfirm({ detail: { values: [0, 0, 0] } })
  assert.equal(page.data.doneSheet.doneAt, `${cols[0][0]}-${cols[1][0]}-${cols[2][0]}`)
  page.setData({ 'doneSheet.doneAt': today() })
  await page.onConfirmDone()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.status, 'done')
  assert.equal(calls[0].data.doneAt, today())
  assert.equal(calls[0].data.doneImageFileID, 'cloud://env/stickers/uploaded-done.jpg')
  assert.equal(calls[0].data.imageFileID, 'cloud://env/stickers/cover-o.jpg')
  assert.deepEqual(uploads, ['/tmp/done.jpg'])
  assert.equal(messages.at(-1), '已标记为已拼贴')
  // 提交失败：补偿清理已上传作品照，弹层与内容保留
  const removed = []
  const failing = loadPage('sticker-edit', {
    listStickers: async () => [editRows.owned],
    chooseImage: async () => '/tmp/done.jpg',
    uploadStickerImage: async () => 'cloud://env/stickers/up.jpg',
    removeImage: async fileID => { removed.push(fileID); return true },
    updateSticker: async () => { throw Error('x') }
  }, { showToast: ({ title }) => messages.push(title) })
  await failing.onLoad({ id: 'o1' })
  failing.onOpenDoneSheet()
  await failing.onChooseDoneImage()
  await failing.onConfirmDone()
  assert.deepEqual(removed, ['cloud://env/stickers/up.jpg'])
  assert.equal(failing.data.doneSheet.show, true)
  assert.equal(failing.data.acting, false)
  assert.equal(failing.data.doneSheet.imagePath, '/tmp/done.jpg')
  assert.equal(messages.at(-1), '操作失败，请重试')
})

test('完成日期滚轮联动年份与月份，确认只更新对应日期字段', async () => {
  const page = loadPage('sticker-edit', { listStickers: async () => [editRows.owned] })
  await page.onLoad({ id: 'o1' })
  page.onOpenDoneSheet()
  page.setData({ 'doneSheet.doneAt': '2024-02-29' })
  page.openDoneDatePicker()
  assert.equal(page.data.picker.maxDate, today())
  assert.equal(page.data.picker.columns[2].length, 29)
  page.onPickerColumnChange({ detail: { values: [page.data.picker.columns[0].indexOf('2025'), 1, 28] } })
  assert.equal(page.data.picker.columns[2].length, 28)
  assert.equal(page.data.picker.values[2], 27)
  page.onPickerConfirm({ detail: { values: page.data.picker.values } })
  assert.equal(page.data.doneSheet.doneAt, '2025-02-28')
  assert.equal(page.data.purchasedAt, '2026-10-01')

  page.setData({ 'doneSheet.doneAt': today() })
  page.openDoneDatePicker()
  const decemberValues = [page.data.picker.columns[0].indexOf('2024'), 11, 30]
  page.onPickerColumnChange({ detail: { values: decemberValues } })
  assert.equal(page.data.picker.columns[1].length, 12)
  assert.equal(page.data.picker.columns[2].length, 31)
  page.onPickerConfirm({ detail: { values: decemberValues } })
  assert.equal(page.data.doneSheet.doneAt, '2024-12-31')

  page.openDatePicker()
  page.onPickerConfirm({ detail: { values: [0, 0, 0] } })
  assert.equal(page.data.purchasedAt, '2022-01-01')
  assert.equal(page.data.doneSheet.doneAt, '2024-12-31')
})

test('撤销完成经确认框提交 owned 载荷并清除完成字段，取消不提交', async () => {
  const calls = []
  const page = loadPage('sticker-edit', {
    listStickers: async () => [editRows.done],
    updateSticker: async (id, data) => { calls.push({ id, data }); return {} }
  }, { showModal: options => options.success({ confirm: true }), showToast() {} })
  await page.onLoad({ id: 'd1' })
  page.onRevertDone()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'd1')
  assert.equal(calls[0].data.status, 'owned')
  assert.equal(calls[0].data.doneAt, '')
  assert.equal(calls[0].data.doneImageFileID, '')
  const cancelled = loadPage('sticker-edit', {
    listStickers: async () => [editRows.done],
    updateSticker: async () => { throw Error('不应调用') }
  }, { showModal: options => options.success({ confirm: false }) })
  await cancelled.onLoad({ id: 'd1' })
  cancelled.onRevertDone()
  await new Promise(resolve => setImmediate(resolve))
})

test('删除经确认框执行，取消不调用', async () => {
  const deleted = []
  const page = loadPage('sticker-edit', {
    listStickers: async () => [editRows.owned],
    deleteSticker: async id => { deleted.push(id); return {} }
  }, { showModal: options => options.success({ confirm: true }), showToast() {} })
  await page.onLoad({ id: 'o1' })
  page.onDelete()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleted, ['o1'])
  const cancelled = loadPage('sticker-edit', {
    listStickers: async () => [editRows.owned],
    deleteSticker: async id => { deleted.push(id) }
  }, { showModal: options => options.success({ confirm: false }) })
  await cancelled.onLoad({ id: 'o1' })
  cancelled.onDelete()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleted, ['o1'])
})

// ---------- ST-09 月历开销与贴纸独立开销 ----------

const { aggregate } = require('../cloudfunctions/auth/stickers')

// 月历测试用当月日期，避免跨月后断言失效
const thisMonth = day => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

test('心愿价格与日期留空转库存后计入库存且不虚增开销', async () => {
  const c = loadCloud({ users: [user()], upload_tickets: [{ ...usedTicketA }],
    stickers: [seedSticker({ status: 'wishlist', price: null, quantity: 1, purchasedAt: '' })] })
  const listStickers = async () => c.records.stickers
  const editor = loadPage('sticker-edit', {
    listStickers,
    updateSticker: async (id, data) => {
      const result = await c.main(dataCall('update', { id, data }))
      assert.equal(result.success, true, result.error)
      return result
    }
  })
  await editor.onLoad({ id: 's1' })
  await editor.onConvert()
  assert.equal(c.records.stickers[0].status, 'owned')
  assert.equal(c.records.stickers[0].price, null)
  assert.equal(c.records.stickers[0].purchasedAt, '')
  const { stats } = await c.main({ action: 'stickerStats' })
  assert.equal(stats.ownedCount, 1)
  assert.equal(stats.wishCount, 0)
  assert.equal(stats.ownedSpent, 0)
  const overview = loadPage('stickers', { listStickers, stickerStats: async () => stats })
  await overview.onShow()
  assert.deepEqual({ ...overview.data.statsView }, { owned: 1, done: 0, undone: 1, spent: 0 })
  const calendar = loadPage('calendar', { listStickers })
  calendar.onLoad()
  await calendar.loadData()
  assert.equal(calendar.data.monthTotal, 0)
  assert.equal(calendar.data.yearTotal, 0)
  assert.equal(calendar.data.selectedTotal, 0)
})

test('月历合计并入贴纸购买，心愿单与无日期贴纸不计', async () => {
  const day20 = thisMonth(20)
  const page = loadPage('calendar', {
    listItems: async () => [{ _id: 'item-1', name: '白衬衫', price: 100, purchaseDate: day20 }],
    listExpenses: async () => [{ _id: 'exp-1', category: '洗护', amount: 40, date: day20 }],
    listPlans: async () => [], listWearRecords: async () => [], listOutfits: async () => [],
    listStickers: async () => [
      { _id: 's1', status: 'owned', price: 10, quantity: 2, purchasedAt: day20 },
      { _id: 's2', status: 'done', price: 5, quantity: 1, purchasedAt: day20 },
      { _id: 's3', status: 'wishlist', price: 999, quantity: 1, purchasedAt: day20 },
      { _id: 's4', status: 'owned', price: 7, quantity: 1, purchasedAt: '' }
    ]
  })
  page.onLoad()
  await page.loadData()
  // 100（衣物）+ 40（账本）+ 20 + 5（贴纸）= 165；心愿单与无日期贴纸不影响
  assert.equal(page.data.monthTotal, 165)
  assert.equal(page.data.yearTotal, 165)
  page.onDayTap({ currentTarget: { dataset: { date: day20 } } })
  assert.equal(page.data.selectedTotal, 165)
})

test('贴纸开销独立展示并随编辑删除更新，衣橱总花费不受影响', async () => {
  let stickers = [
    { _id: 's1', status: 'owned', price: 10, quantity: 2, purchasedAt: '2026-10-01' },
    { _id: 's2', status: 'done', price: 5, quantity: 1, purchasedAt: '' },
    { _id: 's3', status: 'wishlist', price: 999, quantity: 1, purchasedAt: '2026-10-01' }
  ]
  const home = loadPage('stickers', {
    listStickers: async () => stickers,
    stickerStats: async () => aggregate(stickers)
  })
  const page = loadPage('stats', {
    listItems: async () => [{ _id: 'a', name: '衣', price: 100 }],
    listOutfits: async () => [], listExpenses: async () => [{ amount: 40 }], listWearRecords: async () => [],
    listStickers: async () => { throw Error('衣橱统计不应请求贴纸') }
  })
  await home.onShow()
  await page.loadStats()
  // 贴纸独立开销含无购入日期的已购款，心愿单不计；衣橱只计衣物与账本
  assert.equal(home.data.statsView.spent, 25)
  assert.equal(page.data.totalSpent, 140)
  assert.equal(page.data.loadError, '')
  // 编辑与删除只更新贴纸开销，衣橱总额不变
  stickers = [{ ...stickers[0], price: 20 }, stickers[1], stickers[2]]
  await home.onShow()
  await page.loadStats(true)
  assert.equal(home.data.statsView.spent, 45)
  assert.equal(page.data.totalSpent, 140)
  stickers = stickers.slice(1)
  await home.onShow()
  await page.loadStats(true)
  assert.equal(home.data.statsView.spent, 5)
  assert.equal(page.data.totalSpent, 140)
})
