// 校验 AI 模型可用性（部署前 / 接入新模型 / 排障时使用）。
// 密钥从环境变量读取，不内嵌、不写入代码库。
// 用法:
//   AI_API_KEY=sk-xxx node tools/verify-ai.js
//   AI_API_KEY=sk-xxx node tools/verify-ai.js --image   # 附加图像输入验证
//   AI_API_BASE/AI_MODEL 可覆盖默认值
const https = require('https')

const base = (process.env.AI_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '')
const model = process.env.AI_MODEL || 'deepseek-flash'
const key = process.env.AI_API_KEY

function request(path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
        : { Authorization: `Bearer ${key}` }
    }, res => {
      let out = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { out += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(out)) } catch (e) { reject(new Error('非 JSON 响应: ' + out.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')))
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function main() {
  if (!key) {
    console.error('未设置 AI_API_KEY。请先导出密钥，例如：\n  AI_API_KEY=sk-xxx node tools/verify-ai.js [--image]')
    process.exit(1)
  }
  const withImage = process.argv.includes('--image')
  console.log('目标:', base, ' 模型:', model)

  const models = await request('/models')
  const found = (models.data || []).find(item => item.id === model)
  if (!found) {
    console.error('未找到模型', model, '；可用模型:', (models.data || []).map(item => item.id).join(', '))
    process.exit(1)
  }
  const modalities = found.input_modalities || []
  console.log('模型存在:', found.id, found.name, ' 输入能力:', modalities.join('/') || '(未知)')
  if (withImage && !modalities.includes('image')) {
    console.error('该模型不支持图像输入，照片功能不可用')
    process.exit(1)
  }

  const text = await request('/chat/completions', {
    model,
    messages: [{ role: 'user', content: 'reply with JSON {"ok":true} only' }],
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    max_tokens: 50
  })
  const content = text.choices && text.choices[0] && text.choices[0].message.content
  console.log('文本 JSON 输出:', content)

  if (withImage) {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const img = await request('/chat/completions', {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image in one word' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
        ]
      }],
      max_tokens: 80
    })
    console.log('图像输入识别:', (img.choices && img.choices[0] && img.choices[0].message.content) || '(无内容)')
  }
  console.log('验证通过')
}

main().catch(e => { console.error('验证失败:', e.message); process.exit(1) })
