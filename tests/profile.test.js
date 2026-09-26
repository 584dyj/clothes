const test = require('node:test')
const assert = require('node:assert/strict')

let page
global.Page = definition => { page = definition }
require('../pages/profile/profile')

test('最贵衣物按数值价格计算', () => {
  const result = page.findMostExpensive([
    { name: '外套', price: '399.9', imageFileID: 'cloud://coat' },
    { name: '衬衫', price: 199 }
  ])

  assert.deepEqual(result, { name: '外套', price: 399.9, imageFileID: 'cloud://coat' })
})

test('最常用品牌按衣物件数计算并忽略空品牌', () => {
  const result = page.findFavoriteBrand([
    { brand: '品牌 A' },
    { brand: '品牌 B' },
    { brand: '品牌 A' },
    { brand: '  ' }
  ])

  assert.deepEqual(result, { name: '品牌 A', count: 2, initial: '品' })
})

test('空衣橱返回空偏好', () => {
  assert.equal(page.findMostExpensive([]), null)
  assert.equal(page.findFavoriteBrand([]), null)
})
