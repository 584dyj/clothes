const crypto = require('crypto')
const https = require('https')
const { StringDecoder } = require('string_decoder')

function sign(data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url')
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function verify(token, secret) {
  const [payload, signature, extra] = String(token || '').split('.')
  if (!payload || !signature || extra || payload.length > 100000) throw new Error('流式凭证无效')
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('流式凭证无效')
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (!data || data.expiresAt < Date.now()) throw new Error('流式凭证已过期')
  return data
}

async function consumeTicket(ticket, _context, dbOverride) {
  let db = dbOverride
  if (!db) {
    if (!process.env.CLOUDBASE_APIKEY || !process.env.CLOUDBASE_ENV_ID) throw new Error('流式数据库凭证未配置')
    const cloudbase = require('@cloudbase/node-sdk')
    const app = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID,
      accessKey: process.env.CLOUDBASE_APIKEY })
    db = app.database()
  }
  const recordId = crypto.createHash('sha256').update('chat:' + ticket.openid).digest('hex')
  await db.runTransaction(async tx => {
    const ref = tx.collection('auth_attempts').doc(recordId)
    const res = await ref.get()
    const row = Array.isArray(res.data) ? res.data[0] : res.data
    if (!row || row.requestToken !== ticket.requestToken || row.streamUsed ||
        new Date(row.busyUntil).getTime() <= Date.now()) throw new Error('流式请求已失效或已使用')
    await ref.update({ data: { streamUsed: true } })
  })
}

function streamModel(request, key, onDelta, onRequest = () => {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(request.base.replace(/\/+$/, '') + '/chat/completions')
      if (url.protocol !== 'https:') throw new Error()
    } catch (e) { reject(new Error('AI 接口地址无效')); return }
    const body = JSON.stringify({ model: request.model, messages: request.messages,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      ...(request.disableThinking ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: 'low' }),
      max_tokens: request.maxTokens, stream: true })
    let output = '', buffer = '', ended = false, finishReason = ''
    let req
    const timer = setTimeout(() => { if (req) req.destroy(new Error('AI 服务超时，请重试')) }, 20000)
    req = https.request(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const decoder = new StringDecoder('utf8')
      res.on('data', chunk => {
        if (res.statusCode !== 200) {
          buffer += decoder.write(chunk)
          if (buffer.length > 1000) req.destroy(new Error('AI 服务暂不可用'))
          return
        }
        buffer += decoder.write(chunk)
        buffer = buffer.replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
          if (!data) continue
          if (data === '[DONE]') { ended = true; continue }
          let part
          try { part = JSON.parse(data) } catch (e) { req.destroy(new Error('AI 流式响应无效')); return }
          const choice = part.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta) {
            output += delta
            if (output.length > 2000) { req.destroy(new Error('AI 回复过长')); return }
            onDelta(delta)
          }
        }
        if (buffer.length > 200000) req.destroy(new Error('AI 流式响应过大'))
      })
      res.on('end', () => {
        clearTimeout(timer)
        if (res.statusCode !== 200) return reject(new Error('AI 服务暂不可用，请稍后重试'))
        if (!ended || finishReason !== 'stop' || !output.trim()) return reject(new Error('AI 助手回答不完整，请重试'))
        resolve(output)
      })
      res.on('error', error => { clearTimeout(timer); reject(error) })
    })
    req.on('error', error => { clearTimeout(timer); reject(error) })
    onRequest(req)
    req.end(body)
  })
}

exports.main = async (event, context, consume = consumeTicket) => {
  const secret = process.env.CHAT_STREAM_SECRET
  if (!secret || secret.length < 32 || !process.env.AI_API_KEY) return { statusCode: 500,
    headers: { 'Content-Type': 'application/json' }, body: { error: '流式对话尚未配置' } }
  let ticket
  try {
    const body = event && Object.prototype.hasOwnProperty.call(event, 'body') ? event.body : event
    const input = typeof body === 'string' ? JSON.parse(body) : body
    ticket = verify(input?.ticket, secret)
    const callerOpenId = context.extendedContext?.wechatContext?.openId || context.httpContext?.headers?.['x-wx-openid']
    if (!ticket.openid || ticket.openid !== callerOpenId ||
        !ticket.chatId || !ticket.requestToken || !ticket.request?.messages) throw new Error('流式身份无效')
  } catch (e) {
    console.error('chat-stream 凭证验证失败', e.message)
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } }
  }
  try {
    await consume(ticket, context)
  } catch (e) {
    console.error('chat-stream 凭证消费失败', e.message)
    const statusCode = e.message === '流式请求已失效或已使用' ? 409 : 500
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } }
  }
  const sse = context.sse()
  try {
    const replyText = await streamModel(ticket.request, process.env.AI_API_KEY, delta => {
      if (!sse.closed) sse.send({ event: 'delta', data: JSON.stringify({ text: delta }) })
    }, req => sse.on('close', () => req.destroy(new Error('流式连接已关闭'))))
    const proof = sign({ openid: ticket.openid, chatId: ticket.chatId, requestToken: ticket.requestToken,
      replyText, brand: ticket.brand, sources: ticket.sources, expiresAt: Date.now() + 60000 }, secret)
    if (!sse.closed) sse.end({ event: 'done', data: JSON.stringify({ proof }) })
  } catch (e) {
    console.error('流式 AI 调用失败', e)
    if (!sse.closed) sse.end({ event: 'error', data: JSON.stringify({ message: e.message || '流式回复失败' }) })
  }
}

exports.verify = verify
exports.streamModel = streamModel
exports.consumeTicket = consumeTicket
