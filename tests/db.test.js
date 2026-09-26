const test = require('node:test')
const assert = require('node:assert/strict')

const MODULE_PATH = require.resolve('../utils/db')

const { loadCloud } = require('./support/cloud')
test('文字对话按 SSE 分块显示，含跨块 UTF-8 中文', async () => {
  const actions = [], deltas = []
  global.wx = { cloud: {
    callFunction: async ({ data }) => {
      actions.push(data.action)
      if (data.action === 'chatStart') return { result: { success: true, ticket: 'signed-ticket' } }
      if (data.action === 'chatFinish') {
        assert.equal(data.proof, 'signed-proof')
        return { result: { success: true, chatId: 'c1', title: '搭配', messages: [{ role: 'assistant', text: '蓝色衬衫' }] } }
      }
      throw Error('unexpected action ' + data.action)
    },
    callHTTPFunction: options => {
      assert.equal(options.name, 'chat-stream')
      assert.equal(options.config.env, 'cloud1-d3gxekd39e66fd769')
      assert.equal(options.enableChunked, true)
      const bytes = Buffer.from('event: delta\ndata: {"text":"蓝色"}\n\nevent: delta\ndata: {"text":"衬衫"}\n\nevent: done\ndata: {"proof":"signed-proof"}\n\n')
      const cut = bytes.indexOf(Buffer.from('蓝')) + 1
      process.nextTick(() => {
        options.onHeadersReceived({ statusCode: 200 })
        for (const part of [bytes.subarray(0, cut), bytes.subarray(cut, cut + 8), bytes.subarray(cut + 8)]) {
          options.onChunkedReceived({ data: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) })
        }
        options.success({ statusCode: 200 })
      })
    }
  } }
  delete require.cache[MODULE_PATH]
  const api = require(MODULE_PATH)
  const result = await api.chatSend({ text: '怎么搭配' }, delta => deltas.push(delta))
  assert.deepEqual(deltas, ['蓝色', '衬衫'])
  assert.deepEqual(actions, ['chatStart', 'chatFinish'])
  assert.equal(result.chatId, 'c1')
})

test('流式服务返回 400 时保留响应原因并释放会话', async () => {
  const actions = []
  global.wx = { cloud: {
    callFunction: async ({ data }) => {
      actions.push(data.action)
      return { result: { success: true, ticket: 'signed-ticket' } }
    },
    callHTTPFunction: options => {
      process.nextTick(() => {
        options.onHeadersReceived({ statusCode: 400 })
        const bytes = Buffer.from('{"error":"请求参数无效"}')
        options.onChunkedReceived({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
        options.success({ statusCode: 400 })
      })
    }
  } }
  delete require.cache[MODULE_PATH]
  const api = require(MODULE_PATH)
  await assert.rejects(api.chatSend({ text: '你好' }), /流式服务返回 400：请求参数无效/)
  assert.deepEqual(actions, ['chatStart', 'chatCancel'])
})

test('清理状态兼容旧 profile，并读取新版本待处理状态', async () => {
  let profile = { username: 'alice' }
  global.wx = { cloud: { callFunction: async ({ data }) => {
    assert.equal(data.action, 'profile')
    return { result: { success: true, profile } }
  } } }
  delete require.cache[MODULE_PATH]
  const api = require(MODULE_PATH)
  assert.equal((await api.cleanupStatus()).pendingCleanup, false)
  profile.pendingCleanup = true
  assert.equal((await api.cleanupStatus()).pendingCleanup, true)
  global.wx.cloud.callFunction = async () => { throw Error('offline') }
  await assert.rejects(api.cleanupStatus(), /offline/)
})

test('profile 清理状态忽略待核验和其他账号任务', async () => {
  const jobs = [{ _id: 'review', _openid: 'openid-1', state: 'review' }, { _id: 'other', _openid: 'openid-2', state: 'pending' }]
  const { api } = loadDb({ cleanup_jobs: jobs })
  assert.equal((await api.cleanupStatus()).pendingCleanup, false)
  const next = loadDb({ cleanup_jobs: [...jobs, { _id: 'own', _openid: 'openid-1', state: 'pending' }] })
  assert.equal((await next.api.cleanupStatus()).pendingCleanup, true)
})

function loadDb(records) {
  records.users = [{ _id: 'u', username: 'alice', openid: 'openid-1' }]
  for (const name of ['clothes', 'outfits']) for (const row of records[name] || []) row._openid = 'openid-1'
  const cloud = loadCloud(records)
  const queryCalls = []
  global.wx = { cloud: { callFunction: async ({ data }) => {
    if (data.operation === 'list') queryCalls.push({ offset: data.offset })
    return { result: await cloud.main(data) }
  } } }
  delete require.cache[MODULE_PATH]
  return { api: require(MODULE_PATH), queryCalls, deletedFiles: cloud.deletedFiles }
}

test('listItems 自动分页读取全部衣物并归一化旧值', async () => {
  const records = {
    clothes: Array.from({ length: 45 }, (_, index) => ({
      _id: `item-${index}`,
      category: index === 0 ? '外套' : '上衣',
      seasons: index === 0 ? ['春', '秋'] : ['冬']
    }))
  }
  const { api, queryCalls } = loadDb(records)

  const items = await api.listItems()

  assert.equal(items.length, 45)
  assert.deepEqual(queryCalls.map(call => call.offset), [0, 20, 40])
  assert.equal(items[0].category, '上衣')
  assert.deepEqual(items[0].seasons, ['春秋'])
})

test('listItems 在缓存期内复用结果，force 会重新读取全部数据', async () => {
  const records = { clothes: [{ _id: 'item-1', category: '鞋', seasons: [] }] }
  const { api, queryCalls } = loadDb(records)

  await api.listItems()
  await api.listItems()
  assert.equal(queryCalls.length, 1)

  records.clothes.push({ _id: 'item-2', _openid: 'openid-1', category: '包', seasons: [] })
  const refreshed = await api.listItems(true)
  assert.equal(queryCalls.length, 2)
  assert.equal(refreshed.length, 2)
})

test('deleteItem 删除衣物并清理全部穿搭引用', async () => {
  const records = {
    clothes: [{ _id: 'item-1', imageFileID: 'cloud://item-1.jpg' }, { _id: 'item-2' }],
    outfits: [
      { _id: 'outfit-1', itemIds: ['item-1', 'item-2'] },
      { _id: 'outfit-2', itemIds: ['item-1'] },
      { _id: 'outfit-3', itemIds: ['item-2'] }
    ]
  }
  const { api, deletedFiles } = loadDb(records)

  const result = await api.deleteItem('item-1', 'cloud://item-1.jpg')

  assert.equal(result.cleanupFailed, true)
  assert.deepEqual(records.clothes.map(item => item._id), ['item-2'])
  assert.deepEqual(records.outfits.map(outfit => outfit.itemIds), [['item-2'], [], ['item-2']])
  assert.deepEqual(deletedFiles, [])
  assert.equal(records.cleanup_jobs[0].state, 'review')
})
