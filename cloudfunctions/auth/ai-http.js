const https = require('https')

// 推荐与照片对话的一次性请求；普通文字对话由 chat-stream HTTP 云函数接收 SSE。
// json: 要求 JSON 输出（response_format）；disableThinking: 发送 thinking.disabled。
function requestChat({ base, key, model, messages, json = false, disableThinking = false, maxTokens = 800 }) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(base.replace(/\/+$/, '') + '/chat/completions')
      if (url.protocol !== 'https:') throw new Error('AI 接口必须使用 HTTPS')
    } catch (e) { reject(new Error('AI 接口地址无效')); return }
    const body = JSON.stringify({
      model,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(disableThinking ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: 'low' }),
      max_tokens: maxTokens,
      stream: false
    })
    let timer
    const finish = (error, result) => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const req = https.request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let output = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        output += chunk
        if (output.length > 200000) req.destroy(new Error('AI 响应过大'))
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('AI 接口返回状态', res.statusCode)
          finish(new Error('AI 服务暂不可用，请稍后重试'))
          return
        }
        try { finish(null, JSON.parse(output)) } catch (e) { finish(new Error('AI 服务响应无效')) }
      })
    })
    timer = setTimeout(() => req.destroy(new Error('AI 服务超时，请重试')), 20000)
    req.setTimeout(20000, () => req.destroy(new Error('AI 服务超时，请重试')))
    req.on('error', finish)
    req.end(body)
  })
}

module.exports = { requestChat }
