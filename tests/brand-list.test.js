const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { loadCloud } = require('./support/cloud')

function client(callFunction) {
  let now = Date.now()
  const module = { exports: {} }, file = require.resolve('../utils/db')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: createRequire(file),
    wx: { cloud: { callFunction } }, Date: class extends Date { static now() { return now } }, console: { error() {} } })
  return { api: module.exports, advance: () => { now += 30001 } }
}

test('品牌接口只聚合本人品牌，清理空白和大小写，支持超过一页的唯一品牌', async () => {
  const clothes = Array.from({ length: 210 }, (_, index) => ({ _id: `c${index}`, _openid: 'openid-1',
    brand: `Brand${String(index).padStart(3, '0')}`, imageFileID: 'private-image' }))
  for (const [index, brand] of [' nike ', 'NIKE', 'nike', 'adidas', '', ' ', null, 10, {}, undefined].entries()) {
    clothes.push({ _id: `extra${index}`, _openid: 'openid-1', brand })
  }
  clothes.push({ _id: 'foreign', _openid: 'openid-2', brand: 'private-brand' })
  const cloud = loadCloud({ users: [{ _id: 'u1', openid: 'openid-1' }, { _id: 'u2', openid: 'openid-2' }], clothes })
  const result = await cloud.main({ action: 'listBrands', openid: 'openid-2' })
  assert.equal(result.success, true)
  assert.equal(result.brands.length, 212)
  assert.ok(result.brands.every(brand => typeof brand === 'string' && brand === brand.trim() && brand))
  assert.equal(new Set(result.brands.map(brand => brand.toLowerCase())).size, 212)
  assert.ok(result.brands.includes('Brand209'))
  assert.ok(!result.brands.includes('private-brand'))
  const queries = cloud.calls.filter(call => call.operation === 'aggregate')
  assert.equal(queries.length, 3)
  assert.ok(queries.every(call => call.collection === 'clothes' && call.stages[0].match._openid === 'openid-1'))
  assert.deepEqual(queries[0].stages[1], { group: { _id: '$brand' } })
  assert.ok(!cloud.calls.some(call => call.collection === 'clothes' && call.operation === 'get'))
  cloud.setOpenid('openid-2')
  assert.deepEqual(Array.from((await cloud.main({ action: 'listBrands' })).brands), ['private-brand'])
  await cloud.main({ action: 'logout' })
  assert.match((await cloud.main({ action: 'listBrands' })).error, /登录状态已失效/)
})

test('大量重复衣物只返回去重品牌，空衣橱及聚合失败不会伪装成旧结果', async () => {
  const cloud = loadCloud({ users: [{ _id: 'u', openid: 'openid-1' }], clothes:
    Array.from({ length: 5000 }, (_, index) => ({ _id: `c${index}`, _openid: 'openid-1', brand: index % 2 ? 'nike' : 'adidas' })) })
  assert.deepEqual(Array.from((await cloud.main({ action: 'listBrands' })).brands), ['adidas', 'nike'])
  assert.equal(cloud.calls.filter(call => call.operation === 'aggregate').length, 1)
  cloud.records.clothes = []
  assert.deepEqual(Array.from((await cloud.main({ action: 'listBrands' })).brands), [])
  cloud.faults.before = (name, operation) => { if (operation === 'aggregate') throw Error('database unavailable') }
  const failed = await cloud.main({ action: 'listBrands' })
  assert.equal(failed.success, false)
  assert.equal(failed.brands, undefined)
})

test('品牌缓存复用并发读取与空结果，过期、强刷和衣物写入后重新获取', async () => {
  let requests = 0, brands = []
  const { api, advance } = client(async ({ data }) => {
    if (data.action === 'listBrands') { requests++; return { result: { success: true, brands: brands.slice() } } }
    assert.equal(data.action, 'data')
    assert.equal(data.collection, 'clothes')
    brands = data.operation === 'delete' ? [] : [data.data.brand]
    return { result: { success: true, _id: 'saved' } }
  })
  await Promise.all([api.listBrands(), api.listBrands()])
  await api.listBrands()
  assert.equal(requests, 1)
  advance()
  await api.listBrands()
  assert.equal(requests, 2)
  await api.listBrands(true)
  assert.equal(requests, 3)
  await api.addItem({ brand: 'nike' })
  assert.deepEqual(Array.from(await api.listBrands()), ['nike'])
  await api.updateItem('saved', { brand: 'adidas' })
  assert.deepEqual(Array.from(await api.listBrands()), ['adidas'])
  await api.deleteItem('saved')
  assert.deepEqual(Array.from(await api.listBrands()), [])
  assert.equal(requests, 6)
})

test('写入、强刷及清缓存后，旧品牌请求的成功或失败不会覆盖最新缓存', async () => {
  for (const phase of ['write', 'force', 'account', 'failed']) {
    let finish, requests = 0
    const { api } = client(({ data }) => {
      if (data.action !== 'listBrands') return Promise.resolve({ result: { success: true } })
      requests++
      if (requests === 1) return new Promise((resolve, reject) => {
        finish = () => phase === 'failed' ? reject(Error('old request failed')) : resolve({ result: { success: true, brands: ['old'] } })
      })
      return Promise.resolve({ result: { success: true, brands: ['new'] } })
    })
    const pending = api.listBrands()
    if (phase === 'write') await api.updateItem('id', { brand: 'new' })
    else if (phase === 'force') await api.listBrands(true)
    else api.clearCache()
    finish()
    assert.deepEqual(Array.from(await pending), ['new'])
    assert.deepEqual(Array.from(await api.listBrands()), ['new'])
    assert.equal(requests, 2)
  }
})

test('品牌读取失败不缓存错误，衣物写入失败也会使品牌缓存失效', async () => {
  let fail = true, reads = 0
  const { api } = client(async ({ data }) => {
    if (data.action === 'listBrands') {
      reads++
      if (fail) throw Error('offline')
      return { result: { success: true, brands: ['nike'] } }
    }
    throw Error('write response lost')
  })
  await assert.rejects(api.listBrands(), /offline/)
  fail = false
  assert.deepEqual(Array.from(await api.listBrands()), ['nike'])
  assert.equal(reads, 2)
  await assert.rejects(api.updateItem('id', { brand: 'new' }), /write response lost/)
  await api.listBrands()
  assert.equal(reads, 3)
})
