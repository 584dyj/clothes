/**
 * 轻量 Markdown → rich-text nodes 转换（AI 助手回复渲染用）。
 * 只支持回复中常见语法：标题、加粗、行内代码、无序/有序列表、引用、分割线、段落。
 * 流式输出中的未闭合标记按原文输出，不抛错。
 * rich-text 不应用 WXSS class，节点样式一律内联；字号等可继承属性由气泡容器级联。
 */

const STYLE = {
  paragraph: 'margin:8rpx 0;',
  quote: 'margin:8rpx 0;padding-left:16rpx;border-left:4rpx solid rgba(0,0,0,0.15);',
  list: 'margin:8rpx 0;padding-left:40rpx;',
  listItem: 'margin:4rpx 0;',
  strong: 'font-weight:600;',
  code: 'font-family:monospace;background:rgba(0,0,0,0.07);border-radius:6rpx;padding:0 8rpx;',
  hr: 'border:none;border-top:1rpx solid rgba(0,0,0,0.12);margin:16rpx 0;'
}

// 标题随级别递减字号：h1 34rpx、最小 28rpx
const headingStyle = level => `font-weight:600;font-size:${Math.max(36 - level * 2, 28)}rpx;line-height:1.4;margin:14rpx 0 6rpx;`

// 行内语法：**加粗** / __加粗__ / `代码`；未闭合标记保持原文
function inlineNodes(text) {
  const nodes = []
  const pattern = /(\*\*|__)(?=\S)([\s\S]+?\S)\1|`([^`]+)`/g
  let last = 0
  let match
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[3] !== undefined) {
      nodes.push({ name: 'span', attrs: { style: STYLE.code }, children: [{ type: 'text', text: match[3] }] })
    } else {
      nodes.push({ name: 'span', attrs: { style: STYLE.strong }, children: [{ type: 'text', text: match[2] }] })
    }
    last = pattern.lastIndex
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes.length ? nodes : [{ type: 'text', text: '' }]
}

function toNodes(markdown) {
  const blocks = []
  let list = null
  const flushList = () => {
    if (!list) return
    blocks.push({
      name: list.ordered ? 'ol' : 'ul',
      attrs: { style: STYLE.list },
      children: list.items.map(item => ({ name: 'li', attrs: { style: STYLE.listItem }, children: inlineNodes(item) }))
    })
    list = null
  }
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim()
    const heading = line.match(/^(#{1,6})\s+(\S.*)$/)
    const bullet = line.match(/^[-*•]\s+(\S.*)$/)
    const orderedItem = line.match(/^\d{1,2}[.、)]\s*(\S.*)$/)
    const quote = line.match(/^>\s?(.*)$/)
    if (!line || line.startsWith('```')) {
      flushList() // 空行与代码围栏标记只作分段，围栏本身不渲染
    } else if (/^([-*_])\1{2,}$/.test(line)) {
      flushList()
      blocks.push({ name: 'hr', attrs: { style: STYLE.hr } })
    } else if (heading) {
      flushList()
      blocks.push({ name: 'div', attrs: { style: headingStyle(heading[1].length) }, children: inlineNodes(heading[2]) })
    } else if (bullet) {
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] } }
      list.items.push(bullet[1])
    } else if (orderedItem) {
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] } }
      list.items.push(orderedItem[1])
    } else if (quote) {
      flushList()
      blocks.push({ name: 'div', attrs: { style: STYLE.quote }, children: inlineNodes(quote[1]) })
    } else {
      flushList()
      blocks.push({ name: 'div', attrs: { style: STYLE.paragraph }, children: inlineNodes(line) })
    }
  }
  flushList()
  return blocks.length ? blocks : [{ name: 'div', children: [{ type: 'text', text: '' }] }]
}

module.exports = { toNodes }
