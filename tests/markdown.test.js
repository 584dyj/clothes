const test = require('node:test')
const assert = require('node:assert/strict')
const markdown = require('../utils/markdown')

// 提取纯文本内容，便于断言结构之外的文案
function textOf(nodes) {
  return nodes.map(node => node.type === 'text' ? node.text : textOf(node.children || [])).join('')
}

test('段落与换行：每行一个块，空行只分段', () => {
  const nodes = markdown.toNodes('蓝色衬衫配西裤\n\n三色以内')
  assert.equal(nodes.length, 2)
  assert.ok(nodes.every(node => node.name === 'div'))
  assert.equal(textOf(nodes), '蓝色衬衫配西裤三色以内')
})

test('标题按级别递减字号，井号被剥离', () => {
  const nodes = markdown.toNodes('## 通勤方案')
  assert.equal(nodes.length, 1)
  assert.match(nodes[0].attrs.style, /font-weight:600/)
  assert.match(nodes[0].attrs.style, /font-size:32rpx/)
  assert.equal(textOf(nodes), '通勤方案')
})

test('加粗与行内代码转为带内联样式的 span，未闭合标记保留原文', () => {
  const nodes = markdown.toNodes('选**黑色**简洁鞋款，配 `直筒` 裤型')
  const spans = nodes[0].children.filter(node => node.name === 'span')
  assert.equal(spans.length, 2)
  assert.match(spans[0].attrs.style, /font-weight:600/)
  assert.equal(textOf(spans.slice(0, 1)), '黑色')
  assert.match(spans[1].attrs.style, /monospace/)
  // 流式输出中常见的未闭合加粗：不解析、不丢字
  const partial = markdown.toNodes('选**黑色简洁')
  assert.equal(textOf(partial), '选**黑色简洁')
})

test('无序与有序列表分组为 ul/ol，混排时重新分组', () => {
  const nodes = markdown.toNodes('- 衬衫\n- 西裤\n1. 先塞衣角\n2. 再选鞋')
  assert.deepEqual(nodes.map(node => node.name), ['ul', 'ol'])
  assert.equal(nodes[0].children.length, 2)
  assert.equal(nodes[1].children.length, 1 + 1)
  assert.ok(nodes[0].children.every(item => item.name === 'li'))
  assert.equal(textOf(nodes), '衬衫西裤先塞衣角再选鞋')
})

test('引用、分割线与代码围栏标记', () => {
  const nodes = markdown.toNodes('> 三色以内\n---\n```\ncode\n```')
  assert.equal(nodes[0].name, 'div')
  assert.match(nodes[0].attrs.style, /border-left/)
  assert.equal(textOf(nodes.slice(0, 1)), '三色以内')
  assert.equal(nodes[1].name, 'hr')
  // 围栏行本身不渲染，内容行按普通段落保留
  assert.equal(nodes[2].name, 'div')
  assert.equal(textOf(nodes.slice(2)), 'code')
})

test('空输入回退为单个空块', () => {
  for (const input of ['', null, undefined]) {
    const nodes = markdown.toNodes(input)
    assert.equal(nodes.length, 1)
    assert.equal(textOf(nodes), '')
  }
})
