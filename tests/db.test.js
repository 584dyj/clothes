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
      assert.equal(options.config.env, require('../utils/config').CLOUD_ENV)
      assert.equal(options.method, 'POST')
      assert.deepEqual(options.header, { 'Content-Type': 'application/json' })
      assert.deepEqual(options.data, { ticket: 'signed-ticket' })
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

test('文字流式凭证缺失时停止调用 HTTP 函数', async () => {
  let called = false
  global.wx = { cloud: {
    callFunction: async () => ({ result: { success: true } }),
    callHTTPFunction: () => { called = true }
  } }
  delete require.cache[MODULE_PATH]
  const api = require(MODULE_PATH)
  await assert.rejects(api.chatSend({ text: '你好' }), /流式凭证签发失败/)
  assert.equal(called, false)
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

test('listItems 分页和 getItem 保留 19 类，清理非配饰子类并归一化季节', async () => {
  const { CATEGORIES } = require('../cloudfunctions/auth/categories')
  const records = {
    clothes: Array.from({ length: 45 }, (_, index) => ({
      _id: `item-${index}`,
      category: CATEGORIES[index % CATEGORIES.length],
      subcategory: CATEGORIES[index % CATEGORIES.length] === '配饰' ? '袜子' : '帽子',
      price: index + 0.5,
      seasons: index === 0 ? ['春', '秋'] : ['冬']
    }))
  }
  const { api, queryCalls } = loadDb(records)
  const originals = new Map(records.clothes.map(item => [item._id, item]))

  const items = await api.listItems()

  assert.equal(items.length, 45)
  assert.deepEqual(queryCalls.map(call => call.offset), [0, 20, 40])
  for (const item of items) {
    const source = originals.get(item._id)
    assert.equal(item.category, source.category)
    assert.equal(item.subcategory, source.category === '配饰' ? '袜子' : '')
    assert.equal(item.price, source.price)
    assert.deepEqual(await api.getItem(item._id), item)
  }
  assert.deepEqual(items.find(item => item._id === 'item-0').seasons, ['春秋'])
  assert.equal(records.clothes[0].subcategory, '帽子')
})

test('listItems 在缓存期内复用结果，force 会重新读取全部数据', async () => {
  const records = { clothes: [{ _id: 'item-1', category: '鞋', seasons: [] }] }
  const { api, queryCalls } = loadDb(records)

  await api.listItems()
  await api.listItems()
  assert.equal(queryCalls.length, 1)

  records.clothes.push({ _id: 'item-2', _openid: 'openid-1', category: '包袋', seasons: [] })
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

test('衣橱变化使在途流式和图片回复失效，普通读取与改回后新请求正常', async () => {
  for (const phase of ['delta', 'finish', 'photo', 'refresh', 'wear', 'wearRefresh', 'read']) {
    const actions = [], deltas = []
    let stream, finishResult, photoResult
    let category = '衬衫'
    const result = { success: true, chatId: 'c1', title: '搭配', messages: [{ role: 'assistant', text: '当前搭配' }] }
    global.wx = { cloud: {
      callFunction: async ({ data }) => {
        actions.push(data.action)
        if (data.action === 'data') {
          if (data.operation === 'list') return { result: { success: true, data: [{ _id: 'one', category, seasons: [] }] } }
          if (data.collection === 'clothes') category = data.data.category
          return { result: { success: true } }
        }
        if (data.action === 'chatStart') return { result: { success: true, chatId: 'c1', title: '搭配', ticket: 'ticket' } }
        if (data.action === 'chatCancel') return { result: { success: true } }
        if (data.action === 'chatSend') return new Promise(resolve => { photoResult = () => resolve({ result }) })
        if (phase === 'finish') return new Promise(resolve => { finishResult = () => resolve({ result }) })
        return { result }
      },
      callHTTPFunction: options => { stream = options }
    } }
    delete require.cache[MODULE_PATH]
    const api = require(MODULE_PATH)
    if (phase === 'read') {
      await api.updateItem('one', { category: '其他' })
      await api.updateItem('one', { category: '衬衫' })
    }
    const version = api.getWardrobeVersion()
    const pending = api.chatSend({ text: '怎么搭配', imageFileID: phase === 'photo' ? 'cloud://photo' : '' }, delta => deltas.push(delta))
    const completion = phase === 'read' ? pending : assert.rejects(pending, /衣橱已更新，请重新发送/)
    await new Promise(resolve => setImmediate(resolve))
    const emit = (event, data) => {
      const bytes = Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      stream.onChunkedReceived({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
    }
    if (phase !== 'photo') emit('delta', { text: '前半段' })
    if (phase === 'finish') {
      emit('done', { proof: 'proof' })
      await new Promise(resolve => setImmediate(resolve))
    }
    if (phase === 'refresh') await api.listItems(true)
    else if (phase === 'wearRefresh') await api.listWearRecords(true)
    else if (phase === 'wear') await api.updateWearRecord('wear-1', { date: '2026-10-15', itemIds: ['one'] })
    else if (phase === 'read') {
      await api.listItems()
      await api.listItems()
      await api.listWearRecords()
      assert.equal(api.getWardrobeVersion(), version)
      assert.equal((await api.listItems())[0].category, '衬衫')
    } else await api.updateItem('one', { category: '其他' })
    if (phase === 'photo') photoResult()
    else if (phase === 'finish') finishResult()
    else if (phase === 'delta') emit('delta', { text: '失效后半段' })
    else emit('done', { proof: 'proof' })
    await completion
    assert.deepEqual(deltas, phase === 'photo' ? [] : ['前半段'])
    if (!['read', 'photo'].includes(phase)) assert.equal(actions.at(-1), 'chatCancel')
  }
})

test('返回助手或切回穿搭撤回过期临时回复并保留历史，上传期间变化不发模型', async () => {
  const { loadPage } = require('./support/page')
  const history = [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '历史回答' }]
  for (const entry of ['show', 'mode', 'wear', 'upload']) {
    let clothesVersion = 0, wearVersion = 0, reply, delta, uploaded, calls = 0
    const removed = []
    const page = loadPage('assistant', {
      getWardrobeVersion: () => clothesVersion + wearVersion,
      chatList: async () => [],
      uploadImage: () => new Promise(resolve => { uploaded = () => resolve('cloud://new-photo') }),
      removeImage: async fileID => { removed.push(fileID) },
      chatSend: async (payload, onDelta) => {
        calls++
        delta = onDelta
        return new Promise(resolve => { reply = () => resolve({ chatId: 'c1', title: '搭配', messages: [...history, { role: 'assistant', text: '旧推荐' }] }) })
      }
    })
    page.setData({ currentId: 'c1', messages: history, input: '新问题', imagePath: entry === 'upload' ? '/tmp/photo.jpg' : '' })
    const pending = page.onSend()
    if (entry !== 'upload') {
      delta('旧推荐')
      assert.equal(page.data.messages.at(-1).role, 'assistant')
    }
    if (entry === 'wear') wearVersion++
    else clothesVersion++
    if (entry === 'show' || entry === 'wear') await page.onShow()
    if (entry === 'mode') {
      page.setData({ activeMode: 'purchase' })
      page.onModeTap({ currentTarget: { dataset: { mode: 'outfit' } } })
    }
    if (entry !== 'upload') {
      assert.deepEqual(Array.from(page.data.messages, item => item.text), ['旧问题', '历史回答', '新问题'])
      assert.equal(page.data.streaming, false)
      assert.equal(page.data.sendError, '衣橱已更新，请重新发送')
      reply()
    } else uploaded()
    await pending
    assert.deepEqual(Array.from(page.data.messages, item => item.text), ['旧问题', '历史回答', '新问题'])
    assert.equal(page.data.sendError, '衣橱已更新，请重新发送')
    assert.equal(page.data.sending, false)
    assert.deepEqual(removed, entry === 'upload' ? ['cloud://new-photo'] : [])
    assert.equal(calls, entry === 'upload' ? 0 : 1)
  }
})
