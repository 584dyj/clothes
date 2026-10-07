const test = require('node:test')
const assert = require('node:assert/strict')
const { loadCloud } = require('./support/cloud')
const { loadPage } = require('./support/page')
const chatApi = require('../cloudfunctions/auth/chat')
const streamApi = require('../cloudfunctions/chat-stream')
const https = require('node:https')
const { EventEmitter } = require('node:events')

const env = { AI_API_BASE: 'https://api.deepseek.com', AI_API_KEY: 'test-key', AI_MODEL: 'deepseek-flash' }
const user = () => ({ _id: 'user', openid: 'openid-1', username: 'alice', autoLoginEnabled: true })
const item = (_id, category) => ({ _id, _openid: 'openid-1', name: '衬衫', category, seasons: ['春秋'], color: '蓝色', price: 99 })
const ticketId = 'a'.repeat(32)
const fileID = `cloud://env/wardrobe/${ticketId}.jpg`
const ticket = () => ({ _id: ticketId, _openid: 'openid-1', cloudPath: `wardrobe/${ticketId}.jpg` })
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] })

test('对话发送新建会话，带衣橱画像并保存多轮上下文', async () => {
  const cloud = loadCloud({ users: [user()], clothes: [item('own', '上衣'), item('lower', '下装'), item('foreign', '上衣')] })
  cloud.records.clothes[2]._openid = 'openid-2'
  const seen = []
  const request = async args => {
    const turn = seen.length
    seen.push(args)
    assert.equal(args.model, 'deepseek-flash')
    assert.equal(args.disableThinking, true)
    assert.equal(args.json, false)
    assert.equal(args.messages[0].role, 'system')
    assert.equal(args.messages[0].content.includes('foreign'), false)
    assert.equal(args.messages[0].content.includes('own'), true)
    assert.match(args.messages[0].content, /构思 2 至 3 套候选/)
    assert.match(args.messages[0].content, /回答示例/)
    assert.equal(args.messages.at(-1).content, turn === 0 ? '今天约会穿什么好？' : '那配什么鞋？')
    return reply('建议穿白衬衫配长裤。')
  }
  const first = await chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', text: '今天约会穿什么好？' } }, request, env)
  assert.equal(first.success, true)
  assert.equal(cloud.records.ai_chats.length, 1)
  assert.equal(cloud.records.ai_chats[0].title, '约会穿搭')
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].text, '建议穿白衬衫配长裤。')

  const second = await chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', chatId: first.chatId, text: '那配什么鞋？' } }, request, env)
  assert.equal(second.messages.length, 4)
  assert.equal(second.messages.at(-1).role, 'assistant')
  assert.equal(cloud.records.ai_chats[0].messages.length, 4)
})
test('对话携带图片时校验票据并转 base64 发送，历史消息只传文本', async () => {
  const cloud = loadCloud({ users: [user()], upload_tickets: [ticket()] })
  let captured
  const request = async args => {
    captured = args
    return reply('这件外套适合春秋通勤穿。')
  }
  const result = await chatApi.handle({ db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1', event: { action: 'chatSend', text: '看看这件', imageFileID: fileID } }, request, env)
  assert.equal(result.success, true)
  assert.deepEqual(cloud.downloads, [fileID])
  const last = captured.messages.at(-1).content
  assert.equal(last[0].text, '看看这件')
  assert.equal(last[1].type, 'image_url')
  assert.equal(last[1].image_url.url, `data:image/jpeg;base64,${Buffer.from('fake-image-bytes').toString('base64')}`)
  assert.equal(cloud.records.upload_tickets[0].target, 'chat')
})

test('对话图片校验他人票据、格式或已用票据', async () => {
  const cloud = loadCloud({ users: [user()], upload_tickets: [ticket()] })
  const ctx = { db: cloud.db, cloud: cloud.cloudService, openid: 'openid-1' }
  cloud.records.upload_tickets[0]._openid = 'openid-2'
  await assert.rejects(chatApi.handle({ ...ctx, event: { action: 'chatSend', text: 'x', imageFileID: fileID } }, async () => reply('r'), env), /不属于当前账号|已使用/)
  cloud.records.upload_tickets[0]._openid = 'openid-1'
  await assert.rejects(chatApi.handle({ ...ctx, event: { action: 'chatSend', text: 'x', imageFileID: 'cloud://env/wardrobe/zzz.jpg' } }, async () => reply('r'), env), /重新上传/)
  cloud.records.upload_tickets[0].target = 'chat'
  await assert.rejects(chatApi.handle({ ...ctx, event: { action: 'chatSend', text: 'x', imageFileID: fileID } }, async () => reply('r'), env), /已使用/)
  assert.equal(cloud.downloads.length, 0)
})

test('回复完成后可立即开启第二个会话，生成中仍拒绝并发', async () => {
  const cloud = loadCloud({ users: [user()] })
  const ctx = { db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', text: 'hi' } }
  const first = await chatApi.handle(ctx, async () => reply('ok'), env)
  const second = await chatApi.handle({ ...ctx, event: { action: 'chatSend', text: 'again' } }, async () => reply('ok'), env)
  assert.notEqual(second.chatId, first.chatId)
  assert.equal(cloud.records.ai_chats.length, 2)
  // 生成中并发锁
  cloud.records.auth_attempts[0].busyUntil = new Date(Date.now() + 10000)
  await assert.rejects(chatApi.handle({ ...ctx, event: { action: 'chatSend', text: 'x' } }, async () => reply('ok'), env), /正在生成/)
})

test('对话模型失败释放忙锁并保留用户消息，可重试', async () => {
  const cloud = loadCloud({ users: [user()] })
  const ctx = { db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', text: 'hi' } }
  let calls = 0
  const request = async () => { if (calls++ === 0) throw Error('offline'); return reply('ok') }
  await assert.rejects(chatApi.handle(ctx, request, env), /offline/)
  assert.equal(cloud.records.ai_chats[0].messages.length, 1)
  assert.equal(cloud.records.auth_attempts[0].busyUntil, null)
  const retry = await chatApi.handle({ ...ctx, event: { action: 'chatSend', chatId: cloud.records.ai_chats[0]._id, text: 'hi' } }, request, env)
  assert.equal(retry.success, true)
  assert.equal(retry.messages.length, 3)
})

test('文字对话经签名凭证流式输出并保存最终回复', async () => {
  const cloud = loadCloud({ users: [user()], clothes: [item('own', '上衣')] })
  const streamEnv = { ...env, CHAT_STREAM_SECRET: 'test-stream-secret-at-least-32-bytes' }
  const start = await chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1',
    event: { action: 'chatStart', text: '今天怎么搭配？' } }, undefined, streamEnv)
  assert.equal(cloud.records.ai_chats[0].messages.length, 1)
  const original = https.request
  const oldKey = process.env.AI_API_KEY, oldSecret = process.env.CHAT_STREAM_SECRET
  process.env.AI_API_KEY = 'test-key'
  process.env.CHAT_STREAM_SECRET = 'test-stream-secret-at-least-32-bytes'
  https.request = (url, options, callback) => {
    assert.match(String(url), /chat\/completions$/)
    const req = new EventEmitter()
    req.end = body => {
      assert.equal(JSON.parse(body).stream, true)
      const res = new EventEmitter()
      res.statusCode = 200
      callback(res)
      process.nextTick(() => {
        const payload = Buffer.from('data: {"choices":[{"delta":{"content":"蓝色衬衫"}}]}\n\ndata: {"choices":[{"delta":{"content":"配深色长裤"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        res.emit('data', payload.subarray(0, 11))
        res.emit('data', payload.subarray(11))
        res.emit('end')
      })
    }
    return req
  }
  try {
    const events = []
    const rejected = await streamApi.main({ data: JSON.stringify({ ticket: start.ticket }) }, {
      extendedContext: { wechatContext: { openId: 'other' } }, sse: () => { throw Error('不应开启流') } }, async () => {})
    assert.equal(rejected.statusCode, 403)
    const dbFailure = await streamApi.main({ ticket: start.ticket }, {
      extendedContext: { wechatContext: { openId: 'openid-1' } } }, async () => { throw Error('数据库暂不可用') })
    assert.equal(dbFailure.statusCode, 500)
    await streamApi.main({ body: JSON.stringify({ ticket: start.ticket }) }, { extendedContext: { wechatContext: { openId: 'openid-1' } },
      sse: () => ({ closed: false, on() {}, send: event => events.push(event), end: event => events.push(event) }) },
    async ticket => streamApi.consumeTicket(ticket, null, cloud.db))
    assert.equal(events.filter(event => event.event === 'delta').length, 2)
    const proof = JSON.parse(events.at(-1).data).proof
    const result = await chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1',
      event: { action: 'chatFinish', proof } }, undefined, streamEnv)
    assert.equal(result.messages.at(-1).text, '蓝色衬衫配深色长裤')
    assert.equal(cloud.records.auth_attempts[0].busyUntil, null)
    await assert.rejects(streamApi.consumeTicket(streamApi.verify(start.ticket, streamEnv.CHAT_STREAM_SECRET), null, cloud.db), /已失效或已使用/)
    await assert.rejects(chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1',
      event: { action: 'chatFinish', proof } }, undefined, streamEnv), /流式会话已失效/)
  } finally {
    https.request = original
    if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey
    if (oldSecret === undefined) delete process.env.CHAT_STREAM_SECRET; else process.env.CHAT_STREAM_SECRET = oldSecret
  }
})

test('对话历史截断到保留上限，超出 20 条丢弃最旧', async () => {
  const cloud = loadCloud({ users: [user()], ai_chats: [{ _id: 'chat-1', _openid: 'openid-1', title: '旧', messages: Array.from({ length: 19 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `m${index}` })) }] })
  let captured
  const result = await chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', chatId: 'chat-1', text: 'new' } }, async args => { captured = args; return reply('r') }, env)
  assert.equal(result.messages.length, 20)
  assert.equal(result.messages.at(-1).text, 'r')
  assert.equal(result.messages[0].text, 'm1')
  const texts = captured.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => typeof m.content === 'string' ? m.content : m.content[0].text)
  assert.equal(texts.at(-1), 'new')
})

test('对话配置缺失与空内容拒绝', async () => {
  const cloud = loadCloud({ users: [user()] })
  const ctx = { db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', text: 'hi' } }
  await assert.rejects(chatApi.handle(ctx, async () => reply('r'), {}), /尚未配置/)
  await assert.rejects(chatApi.handle({ ...ctx, event: { action: 'chatSend', text: '  ' } }, async () => reply('r'), env), /请输入内容/)
})

test('对话拒绝被截断的回复', () => {
  assert.throws(() => chatApi.cleanReply({ choices: [{ finish_reason: 'length', message: { content: '说到一半' } }] }), /不完整/)
})

test('AI_THINKING 开启时使用低强度推理请求预算', async () => {
  const cloud = loadCloud({ users: [user()] })
  await chatApi.handle({ db: cloud.db, cloud, openid: 'openid-1', event: { action: 'chatSend', text: '通勤怎么穿？' } },
    async args => {
      assert.equal(args.disableThinking, false)
      assert.equal(args.maxTokens, 1600)
      return reply('选衬衫和长裤。')
    }, { ...env, AI_THINKING: '1' })
})

test('会话列表/读取/改名/删除均校验归属，越权被拒', async () => {
  const cloud = loadCloud({ users: [user()], ai_chats: [
    { _id: 'own', _openid: 'openid-1', title: '我的', messages: [{ role: 'user', text: 'a' }] },
    { _id: 'foreign', _openid: 'openid-2', title: '别人', messages: [] }
  ] })
  const base = { db: cloud.db, cloud, openid: 'openid-1' }
  const list = await chatApi.handle({ ...base, event: { action: 'chatList' } })
  assert.equal(list.chats.length, 1)
  assert.equal(list.chats[0]._id, 'own')
  assert.equal((await chatApi.handle({ ...base, event: { action: 'chatGet', chatId: 'own' } })).chat.messages.length, 1)
  await assert.rejects(chatApi.handle({ ...base, event: { action: 'chatGet', chatId: 'foreign' } }), /不存在或无权访问/)
  await assert.rejects(chatApi.handle({ ...base, event: { action: 'chatRename', chatId: 'foreign', title: '非法修改' } }), /不存在或无权访问/)
  await assert.rejects(chatApi.handle({ ...base, event: { action: 'chatRename', chatId: 'own', title: '  ' } }), /1 至 24 个字符/)
  await chatApi.handle({ ...base, event: { action: 'chatRename', chatId: 'own', title: '  春日通勤  ' } })
  assert.equal((await chatApi.handle({ ...base, event: { action: 'chatGet', chatId: 'own' } })).chat.title, '春日通勤')
  await assert.rejects(chatApi.handle({ ...base, event: { action: 'chatDelete', chatId: 'foreign' } }), /不存在或无权访问/)
  assert.equal((await chatApi.handle({ ...base, event: { action: 'chatDelete', chatId: 'own' } })).success, true)
  assert.equal(cloud.records.ai_chats.length, 1)
})

test('助手页加载会话、发送、切换与删除', async () => {
  const sessions = [{ _id: 'c1', title: '搭配' }, { _id: 'c2', title: '购物' }]
  const page = loadPage('assistant', {
    chatList: async () => sessions,
    chatGet: async () => ({ title: '搭配', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '你好' }] }),
    chatSend: async payload => ({ chatId: payload.chatId || 'new-1', title: '新会话', messages: [{ role: 'user', text: payload.text }] }),
    chatDelete: async id => {},
    uploadImage: async () => 'cloud://env/wardrobe/x.jpg',
    chooseImage: async () => { throw Error('cancel') }
  }, { showModal: opts => opts.success({ confirm: true }), showToast() {},
    testSetTimeout: setTimeout, testClearTimeout: clearTimeout })
  await page.onShow()
  assert.equal(page.data.sessions.length, 2)
  assert.equal(page.data.title, '新会话')

  page.onSessionTap({ currentTarget: { dataset: { id: 'c1' } } })
  assert.equal(page.data.currentId, '')
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(page.data.currentId, 'c1')
  assert.equal(page.data.messages.length, 2)
  assert.equal(page.data.messages[0].displayText, 'hi')

  page.onNewSession()
  page.onInput({ detail: { value: 'hello' } })
  await page.onSend()
  assert.equal(page.data.currentId, 'new-1')
  assert.equal(page.data.title, '新会话')
  assert.equal(page.data.messages[0].text, 'hello')
  assert.equal(page.data.messages[0].displayText, 'hello')
  assert.equal(page.data.input, '')

  page.onSessionLongPress({ currentTarget: { dataset: { id: 'c2' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.sessions.length, 1)
})

test('助手页发送带图片时先上传再交给云函数', async () => {
  const sources = []
  const page = loadPage('assistant', {
    chatList: async () => [],
    chatGet: async () => ({ title: 'x', messages: [] }),
    chatSend: async payload => ({ chatId: 'n1', title: 'x', messages: [{ role: 'user', text: payload.text, imageFileID: payload.imageFileID }] }),
    chatDelete: async () => {},
    uploadImage: async () => 'cloud://env/wardrobe/uploaded.jpg',
    chooseImage: async source => { sources.push(source[0]); return '/tmp/pic.jpg' }
  }, { showToast() {} })
  await page.onShow()
  await page.onChooseAlbum()
  assert.deepEqual(sources, ['album'])
  assert.equal(page.data.imagePath, '/tmp/pic.jpg')
  page.onInput({ detail: { value: '看看这件' } })
  await page.onSend()
  assert.equal(page.data.messages[0].imageFileID, 'cloud://env/wardrobe/uploaded.jpg')
})

test('助手拍照、图片预览和长按删除入口', async () => {
  const sources = [], previews = [], deleted = []
  const page = loadPage('assistant', {
    chooseImage: async source => { sources.push(source[0]); return '/tmp/camera.jpg' },
    chatDelete: async id => { deleted.push(id) }
  }, { previewImage: options => previews.push(options), showModal: options => options.success({ confirm: true }) })
  page.setData({ sessions: [{ _id: 'c1', title: '穿搭' }], currentId: 'c1' })
  await page.onTakePhoto()
  assert.deepEqual(sources, ['camera'])
  page.onPreviewSelectedImage()
  assert.equal(previews[0].current, '/tmp/camera.jpg')
  page.onPreviewImage({ currentTarget: { dataset: { fileid: 'cloud://env/wardrobe/a.jpg' } } })
  assert.equal(previews[1].current, 'cloud://env/wardrobe/a.jpg')
  page.onSessionLongPress({ currentTarget: { dataset: { id: 'c1' } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleted, ['c1'])
  assert.equal(page.data.currentId, '')
  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /bindlongpress="onSessionLongPress"/)
  assert.doesNotMatch(markup, /catchtap="onDeleteSession"/)
})

test('单个图片入口可选择拍照或相册', async () => {
  const sources = []
  const page = loadPage('assistant', { chooseImage: async source => { sources.push(source[0]); return '/tmp/pic.jpg' } },
    { showActionSheet: options => {
      assert.deepEqual(Array.from(options.itemList), ['拍照', '从相册选择'])
      options.success({ tapIndex: sources.length })
    } })
  page.onChooseImage()
  await new Promise(resolve => setImmediate(resolve))
  page.onChooseImage()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sources, ['camera', 'album'])
})

test('点击模板立即显示用户消息与等待状态，输入框保持空白', async () => {
  let complete, sent
  const page = loadPage('assistant', {
    chatSend: payload => { sent = payload; return new Promise(resolve => { complete = resolve }) },
    chatList: async () => []
  })
  const pending = page.onSuggestionTap({ currentTarget: { dataset: { text: '根据我的衣橱推荐一套通勤穿搭' } } })
  assert.equal(page.data.input, '')
  assert.equal(page.data.sending, true)
  assert.equal(page.data.currentId, '')
  assert.equal(page.data.messages[0].role, 'user')
  assert.equal(page.data.messages[0].text, '根据我的衣橱推荐一套通勤穿搭')
  assert.equal(page.data.messages[0].displayText, page.data.messages[0].text)
  assert.equal(page.data.scrollIntoView, 'msg-thinking')
  assert.equal(sent.text, '根据我的衣橱推荐一套通勤穿搭')
  await page.loadSessions()
  assert.equal(page.data.messages[0].text, sent.text)
  complete({ chatId: 'c1', title: '通勤', messages: [{ role: 'user', text: sent.text }] })
  await pending
  assert.equal(page.data.input, '')
})

test('助手顶部显示购买评估入口', () => {
  const page = loadPage('assistant')
  assert.equal(page.data.activeMode, 'outfit')
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  assert.equal(page.data.activeMode, 'purchase')

  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /穿搭推荐/)
  assert.match(markup, /购买评估/)
  assert.doesNotMatch(markup, /新品查询/)
})

test('会话列表隐藏旧品牌搜索记录，新会话仍标记为 outfit', async () => {
  const brandChats = Array.from({ length: 50 }, (_, index) => ({
    _id: `brand-${index}`, _openid: 'openid-1', title: '旧品牌会话', kind: 'brand',
    updatedAt: new Date(2026, 0, 2), messages: []
  }))
  const cloud = loadCloud({ users: [user()], ai_chats: [
    { _id: 'legacy', _openid: 'openid-1', title: '旧会话', updatedAt: new Date(2026, 0, 1), messages: [] },
    ...brandChats
  ] })
  const ctx = { db: cloud.db, cloud, openid: 'openid-1' }
  const outfit = await chatApi.handle({ ...ctx, event: { action: 'chatSend', text: '通勤怎么穿？' } }, async () => reply('穿衬衫。'), env)
  assert.equal(cloud.records.ai_chats.find(c => c._id === outfit.chatId).kind, 'outfit')
  const list = await chatApi.handle({ ...ctx, event: { action: 'chatList' } })
  assert.deepEqual(list.chats.map(chat => chat._id).sort(), ['legacy', outfit.chatId].sort())
  assert.equal(list.chats.some(chat => Object.hasOwn(chat, 'kind')), false)
})

test('购买评估模式隐藏会话栏，返回穿搭后恢复会话列表', async () => {
  const sessions = [
    { _id: 'o1', title: '通勤穿搭' },
    { _id: 'old', title: '旧会话' }
  ]
  const page = loadPage('assistant', { chatList: async () => sessions })
  await page.onShow()
  assert.deepEqual(page.data.visibleSessions.map(s => s._id), ['o1', 'old'])
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  assert.equal(page.data.activeMode, 'purchase')
  page.onModeTap({ currentTarget: { dataset: { mode: 'outfit' } } })
  assert.deepEqual(page.data.visibleSessions.map(s => s._id), ['o1', 'old'])
  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /wx:for="\{\{visibleSessions\}\}"/)
  assert.doesNotMatch(markup, /session-bar[^>]*wx:if/)
})

test('等待回复时可切模式/看其他会话，后台完成不覆盖当前视图', async () => {
  let complete, listCalls = 0
  const history = [{ _id: 'c1', title: '旧会话', kind: 'outfit' }]
  const page = loadPage('assistant', {
    chatList: async () => listCalls++ === 0 ? history : [{ _id: 'new-1', title: '约会穿搭', kind: 'outfit' }, ...history],
    chatGet: async () => ({ title: '旧会话', messages: [{ role: 'user', text: 'old' }, { role: 'assistant', text: '旧的回复' }] }),
    chatSend: payload => new Promise(resolve => {
      complete = () => resolve({ chatId: 'new-1', title: '约会穿搭',
        messages: [{ role: 'user', text: payload.text }, { role: 'assistant', text: '新回复' }] })
    })
  }, { testSetTimeout: setTimeout, testClearTimeout: clearTimeout })
  await page.onShow()
  page.onNewSession()
  page.onInput({ detail: { value: '约会穿什么' } })
  const pending = page.onSend()
  assert.equal(page.data.sending, true)
  assert.equal(page.data.awaitingReply, true)

  // 发送中切到购买评估：不被拦截，视图清空，等待气泡消失
  page.onModeTap({ currentTarget: { dataset: { mode: 'purchase' } } })
  assert.equal(page.data.activeMode, 'purchase')
  assert.equal(page.data.messages.length, 0)
  assert.equal(page.data.awaitingReply, false)

  // 后台完成：不覆盖当前视图，但会话列表已刷新
  complete()
  await pending
  assert.equal(page.data.activeMode, 'purchase')
  assert.equal(page.data.messages.length, 0)
  assert.equal(page.data.currentId, '')
  assert.equal(page.data.sending, false)
  page.onModeTap({ currentTarget: { dataset: { mode: 'outfit' } } })
  assert.deepEqual(page.data.visibleSessions.map(s => s._id), ['new-1', 'c1'])

  // 发送中查看其他会话：同样不被拦截，完成后不串视图
  listCalls = 0
  page.onInput({ detail: { value: '通勤呢' } })
  const second = page.onSend()
  assert.equal(page.data.awaitingReply, true)
  page.onSessionTap({ currentTarget: { dataset: { id: 'c1' } } })
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(page.data.currentId, 'c1')
  assert.equal(page.data.messages.length, 2)
  assert.equal(page.data.messages[1].text, '旧的回复')
  complete()
  await second
  assert.equal(page.data.currentId, 'c1')
  assert.equal(page.data.messages[1].text, '旧的回复')
})

test('切走再切回时对话内容保持显示，不等待重新加载', async () => {
  let getCalls = 0
  const page = loadPage('assistant', {
    chatList: async () => [{ _id: 'c1', title: '旧会话', kind: 'outfit' }],
    chatGet: async () => { getCalls++; return { title: '旧会话', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] } }
  }, { testSetTimeout: setTimeout, testClearTimeout: clearTimeout })
  await page.onShow()
  page.onSessionTap({ currentTarget: { dataset: { id: 'c1' } } })
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(page.data.messages.length, 2)
  // 切走再切回：重新拉取会话期间已有气泡应保持显示
  page.onHide()
  const showing = page.onShow()
  assert.equal(page.data.messages.length, 2)
  await showing
  assert.equal(page.data.messages.length, 2)
  assert.equal(getCalls, 2)
})

test('等待回复中切走再切回，待回复气泡保留', async () => {
  let complete
  const page = loadPage('assistant', {
    chatList: async () => [],
    chatSend: () => new Promise(resolve => { complete = () => resolve({ chatId: 'n1', title: 't', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'ok' }] }) })
  })
  await page.onShow()
  page.onInput({ detail: { value: 'hi' } })
  const pending = page.onSend()
  assert.equal(page.data.awaitingReply, true)
  page.onHide()
  await page.onShow()
  assert.equal(page.data.messages.length, 1)
  assert.equal(page.data.messages[0].role, 'user')
  assert.equal(page.data.awaitingReply, true)
  // 切回时强制滚到最新消息，规避滚动位置异常导致的气泡不可见
  assert.equal(page.data.scrollIntoView, 'msg-end')
  complete()
  await pending
  assert.equal(page.data.messages.length, 2)
})

test('页面重建后清掉已失效的会话记录', async () => {
  const storage = { assistantView: { currentId: 'b1' } }
  const page = loadPage('assistant', {
    chatList: async () => [],
    chatGet: async () => { throw Error('不应读取已失效会话') }
  }, {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value }
  })
  await page.onShow()
  assert.equal(page.data.activeMode, 'outfit')
  assert.equal(page.data.currentId, '')
  assert.equal(page.data.messages.length, 0)
  assert.equal(page.data.visibleSessions.length, 0)
  assert.equal(storage.assistantView, '')
})

test('会话列表刷新失败时保留当前对话不清屏', async () => {
  let fails = false
  const page = loadPage('assistant', {
    chatList: async () => {
      if (fails) throw Error('offline')
      return [{ _id: 'c1', title: '旧会话', kind: 'outfit' }]
    },
    chatGet: async () => ({ title: '旧会话', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] })
  }, { testSetTimeout: setTimeout, testClearTimeout: clearTimeout })
  await page.onShow()
  page.onSessionTap({ currentTarget: { dataset: { id: 'c1' } } })
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(page.data.messages.length, 2)
  fails = true
  await page.onShow()
  assert.equal(page.data.loadError, '')
  assert.equal(page.data.messages.length, 2)
})

test('发送失败后在对话区保留可见错误原因', async () => {
  const error = new Error('AI 服务暂不可用')
  error.chatId = 'failed-chat'
  error.chatTitle = '通勤穿搭'
  const page = loadPage('assistant', { chatSend: async () => { throw error } }, { showToast() {} })
  await page.onSuggestionTap({ currentTarget: { dataset: { text: '通勤怎么搭配？' } } })
  assert.match(page.data.sendError, /AI 服务暂不可用/)
  assert.equal(page.data.sending, false)
  assert.equal(page.data.messages[0].text, '通勤怎么搭配？')
  assert.equal(page.data.currentId, 'failed-chat')
  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /\{\{item\.displayText\}\}/)
  assert.match(markup, /\{\{sendError\}\}/)
})

test('重新打开仅有用户消息的会话时说明回复尚未完成', async () => {
  const page = loadPage('assistant', { chatGet: async () => ({ title: '通勤穿搭', messages: [{ role: 'user', text: '怎么搭配' }] }) })
  await page.loadChat('c1')
  assert.equal(page.data.messages[0].displayText, '怎么搭配')
  assert.match(page.data.sendError, /尚未收到回复/)
})

test('双击同一会话弹窗改名，单击仍切换会话', async () => {
  let saved, modal
  const page = loadPage('assistant', {
    chatGet: async () => ({ title: saved?.title || '第二会话', messages: [] }),
    chatRename: async (id, title) => { saved = { id, title } }
  }, { showModal: options => { modal = options }, showToast() {},
    testSetTimeout: setTimeout, testClearTimeout: clearTimeout })
  page.setData({ sessions: [{ _id: 'c1', title: '旧标题' }, { _id: 'c2', title: '第二会话' }], currentId: 'c1', title: '旧标题' })
  page.onSessionTap({ currentTarget: { dataset: { id: 'c2' } } })
  assert.equal(page.data.currentId, 'c1')
  assert.equal(modal, undefined)
  page.onSessionTap({ currentTarget: { dataset: { id: 'c2' } } })
  assert.equal(page.data.currentId, 'c1')
  assert.equal(modal.editable, true)
  assert.equal(modal.content, '第二会话')
  modal.success({ confirm: true, content: '  秋季通勤  ' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(saved, { id: 'c2', title: '秋季通勤' })
  assert.equal(page.data.currentId, 'c1')
  assert.equal(page.data.title, '旧标题')
  assert.equal(page.data.sessions[1].title, '秋季通勤')
  page.onSessionTap({ currentTarget: { dataset: { id: 'c2' } } })
  assert.equal(page.data.currentId, 'c1')
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(page.data.currentId, 'c2')
  assert.equal(page.data.title, '秋季通勤')
  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.doesNotMatch(markup, /session-rename|rename-bar/)
})

test('品牌会话入口隐藏，输入栏只属于穿搭推荐', () => {
  const fs = require('node:fs'), path = require('node:path')
  const markup = fs.readFileSync(path.join(__dirname, '../pages/assistant/assistant.wxml'), 'utf8')
  assert.match(markup, /activeMode === 'purchase'/)
  assert.match(markup, /class="input-bar"/)
  assert.doesNotMatch(markup, /继续追问这个品牌|data-mode="brand"/)
})

test('相机权限被拒时提供打开设置入口', async () => {
  let opened = false
  const page = loadPage('assistant', { chooseImage: async () => { throw { errMsg: 'chooseMedia:fail auth deny' } } },
    { showModal: options => options.success({ confirm: true }), openSetting: () => { opened = true } })
  await page.onTakePhoto()
  assert.equal(opened, true)
})

test('助手收到流式片段时立即更新回复气泡', async () => {
  const page = loadPage('assistant', { chatSend: async (payload, onDelta) => {
    onDelta('你好')
    assert.equal(page.data.messages[1].displayText, '你好')
    onDelta('，可以这样搭配')
    return { chatId: 'c1', title: '搭配', messages: [
      { role: 'user', text: payload.text }, { role: 'assistant', text: '你好，可以这样搭配' }] }
  }, chatList: async () => [] })
  page.onInput({ detail: { value: '怎么搭配' } })
  await page.onSend()
  assert.equal(page.data.messages[1].displayText, '你好，可以这样搭配')
})

test('auth 入口校验登录后路由到对话模块', async () => {
  const original = chatApi.handle
  const seen = []
  chatApi.handle = async context => { seen.push(context.openid); return { success: true, chats: [] } }
  try {
    const cloud = loadCloud({ users: [user()] })
    assert.equal((await cloud.main({ action: 'chatList' })).success, true)
    await cloud.db.collection('users').doc('user').update({ data: { autoLoginEnabled: false } })
    assert.match((await cloud.main({ action: 'chatList' })).error, /登录状态已失效/)
    assert.deepEqual(seen, ['openid-1'])
  } finally { chatApi.handle = original }
})
