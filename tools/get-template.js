// 查询订阅消息模板的字段名（部署天气提醒前核对模板结构时使用）。
// 小程序 AppSecret 从环境变量读取，不内嵌、不写入代码库。
// 用法:
//   WX_APPID=wx... WX_SECRET=... node tools/get-template.js <模板ID>   # 查指定模板字段
//   WX_APPID=wx... WX_SECRET=... node tools/get-template.js            # 列出我的全部模板
// 注意：获取 access_token 要求调用方公网 IP 在公众平台「开发设置 → IP 白名单」内，
// 报 40164 时把本机公网 IP 加入白名单后重试。
const https = require('https')

const appid = process.env.WX_APPID
const secret = process.env.WX_SECRET

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
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
  if (!appid || !secret) {
    console.error('未设置 WX_APPID / WX_SECRET。例如：\n  WX_APPID=wx... WX_SECRET=... node tools/get-template.js [模板ID]')
    process.exit(1)
  }
  const target = process.argv[2] || ''

  const token = await request({
    host: 'api.weixin.qq.com',
    path: `/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`,
    method: 'GET'
  })
  if (!token.access_token) {
    console.error('获取 access_token 失败:', JSON.stringify(token),
      '\n若为 40164（invalid ip），请把本机公网 IP 加入公众平台 IP 白名单。')
    process.exit(1)
  }

  const list = await request({
    host: 'api.weixin.qq.com',
    path: `/wxaapi/newtmpl/gettemplate?access_token=${token.access_token}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {})
  if (!Array.isArray(list.data)) {
    console.error('查询模板列表失败:', JSON.stringify(list))
    process.exit(1)
  }

  const typeName = type => ({ 2: '一次性订阅', 3: '长期订阅' }[type] || `类型${type}`)
  if (!target) {
    console.log(`共 ${list.data.length} 个模板：`)
    for (const item of list.data) console.log(`- ${item.priTmplId}  ${item.title}（${typeName(item.type)}）`)
    return
  }

  const found = list.data.find(item => item.priTmplId === target)
  if (!found) {
    console.error('我的模板中未找到该 ID；现有模板：')
    for (const item of list.data) console.log(`- ${item.priTmplId}  ${item.title}`)
    process.exit(1)
  }
  console.log('模板:', found.title, `（${typeName(found.type)}）`)
  console.log('内容:', found.content)
  const fields = [...String(found.content).matchAll(/\{\{(\w+)\.DATA\}\}/g)].map(match => match[1])
  console.log('字段:', fields.join(', ') || '(未解析到字段)')
  if (found.example) console.log('示例:', found.example)
}

main().catch(e => { console.error('查询失败:', e.message); process.exit(1) })
