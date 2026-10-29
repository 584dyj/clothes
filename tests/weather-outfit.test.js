const test = require('node:test')
const assert = require('node:assert/strict')
const { buildRecommendation, replaceItem, temperatureRank, ROLES } = require('../cloudfunctions/weather-alert/outfit')
const { ROLES: authRoles } = require('../cloudfunctions/auth/categories')
const { loadPage } = require('./support/page')
const weather = (tempMin = 14, tempMax = 20, textDay = '阴') => ({ tempMin, tempMax, textDay })
const item = (_id, category, seasons = ['春秋'], color = '黑色') => ({ _id, category, seasons, color, name: _id })
const wardrobe = () => [item('top1', '长袖'), item('top2', '衬衫'), item('top3', '长袖'),
  item('pants', '长裤'), item('shoe', '鞋', []), item('outer', '外套')]
const options = { date: '2026-10-10', openid: 'u1' }

test('推荐照片点击全屏预览且不改勾选，卡片其他区域仍可切换选择', () => {
  const previews = []
  const page = loadPage('weather-outfit', {}, { previewImage: options => previews.push(options) })
  page.setData({ loading: false, selectedCount: 1, items: [
    { _id: 'photo', imageFileID: 'cloud://photo', available: true, selected: true },
    { _id: 'empty', imageFileID: '', available: true, selected: false }
  ] })
  const tap = id => ({ currentTarget: { dataset: { id } } })
  page.onPreviewImage(tap('photo'))
  assert.equal(previews[0].urls[0], 'cloud://photo')
  assert.equal(page.data.items[0].selected, true)
  assert.equal(page.data.selectedCount, 1)
  page.onPreviewImage(tap('empty')); page.onPreviewImage(tap('missing'))
  assert.equal(previews.length, 1)
  page.onItemTap(tap('photo'))
  assert.equal(page.data.items[0].selected, false)
  assert.equal(page.data.selectedCount, 0)
  page.setData({ saved: true })
  page.onPreviewImage(tap('photo'))
  assert.equal(previews.length, 2)
  const markup = require('node:fs').readFileSync(require.resolve('../pages/weather-outfit/weather-outfit.wxml'), 'utf8')
  assert.match(markup, /<image[^>]*catchtap="onPreviewImage"/)
})

test('独立部署的搭配角色与已有分类一致，保暖衣只作内搭', () => {
  const expected = { top: 'top', bottom: 'bottom', outer: 'outer', layer: 'layer', dress: 'dress', shoes: 'shoes', accessory: 'extra', bag: 'extra' }
  for (const [category, role] of Object.entries(authRoles)) {
    assert.equal(ROLES[category], category === '保暖衣' ? 'inner' : expected[role], category)
  }
})

test('马甲只按季节入选，不设额外温度阈值，包含历史春秋标签', () => {
  for (const high of [5, 8, 12, 13, 17, 18, 23, 27, 28, 35]) {
    for (const seasons of [['冬'], ['春秋'], ['夏'], ['春'], ['秋'], []]) {
      assert.equal(temperatureRank(item('vest', '马甲', seasons), weather(2, high)),
        temperatureRank(item('pants', '长裤', seasons), weather(2, high)))
    }
  }
  assert.equal(temperatureRank(item('summer-vest', '马甲', ['夏']), weather(25, 35)), 0)
  assert.notEqual(temperatureRank(item('spring-vest', '马甲', ['春秋']), weather(2, 20)), null)
})

test('马甲仅在完整主体上叠穿，不能填补上衣或低温保暖外套缺口', () => {
  const items = [item('top', '毛衣', ['冬']), item('pants', '长裤', ['冬']), item('shoe', '鞋', []),
    item('vest-a', '马甲', ['冬']), item('vest-b', '马甲', ['冬'])]
  const result = buildRecommendation(weather(2, 7), items, options)
  assert.equal(result.items.filter(row => row.category === '马甲').length, 1)
  assert.ok(result.missing.includes('保暖外套'))
  assert.match(result.reason, /马甲用于叠穿/)
  const withCoat = buildRecommendation(weather(2, 7), [...items, item('coat', '羽绒服', ['冬'])], options)
  assert.ok(withCoat.itemIds.includes('coat'))
  assert.equal(withCoat.items.filter(row => row.category === '马甲').length, 1)
  assert.deepEqual(withCoat.missing, [])
  const withoutTop = buildRecommendation(weather(2, 7), items.filter(row => row._id !== 'top'), options)
  assert.ok(!withoutTop.items.some(row => row.category === '马甲'))
  assert.ok(withoutTop.missing.includes('上装'))
  const alone = buildRecommendation(weather(2, 7), [items[3]], options)
  assert.deepEqual(alone.itemIds, [])
  const withDress = buildRecommendation(weather(), [item('dress', '连衣裙'), item('vest', '马甲')], options)
  assert.ok(withDress.itemIds.includes('dress') && withDress.itemIds.includes('vest'))
})

test('更换马甲只替换叠穿层，保留内层及保暖外套，季节不匹配时不替换', () => {
  const items = [item('top', '毛衣', ['冬']), item('pants', '长裤', ['冬']), item('coat', '羽绒服', ['冬']),
    item('vest-a', '马甲', ['冬']), item('vest-b', '马甲', ['冬'])]
  const current = buildRecommendation(weather(2, 7), items, options)
  const vestId = current.items.find(row => row.category === '马甲')._id
  const changed = replaceItem(weather(2, 7), items, current, vestId, options)
  assert.ok(changed)
  assert.ok(!changed.itemIds.includes(vestId))
  assert.ok(['top', 'pants', 'coat'].every(id => changed.itemIds.includes(id)))
  const unavailable = items.map(row => row.category === '马甲' && row._id !== vestId ? { ...row, seasons: ['夏'] } : row)
  assert.equal(replaceItem(weather(2, 7), unavailable, current, vestId, options), null)
})

test('配饰换这件保持子类别，袜子不会自动换成围巾或包袋', () => {
  const items = [item('top', '毛衣', ['冬']), item('pants', '长裤', ['冬']), item('shoe', '鞋', []),
    { ...item('sock-a', '配饰', []), subcategory: '袜子' }]
  const current = buildRecommendation(weather(2, 7), items, options)
  const scarf = { ...item('scarf', '配饰', []), subcategory: '围巾' }
  const bag = item('bag', '包袋', [])
  assert.equal(replaceItem(weather(2, 7), [...items, scarf, bag], current, 'sock-a', options), null)
  const changed = replaceItem(weather(2, 7), [...items, scarf, bag, { ...item('sock-b', '配饰', []), subcategory: '袜子' }], current, 'sock-a', options)
  assert.ok(changed.itemIds.includes('sock-b'))
  assert.ok(!changed.itemIds.includes('scarf'))
  assert.ok(!changed.itemIds.includes('bag'))
})

test('20℃即使降温8℃也排除羽绒服，错误季节标签不能绕过类别限制', () => {
  for (const seasons of [['冬'], ['春秋'], ['夏'], []]) {
    const result = buildRecommendation(weather(), [...wardrobe(), item('down', '羽绒服', seasons)],
      { ...options, trigger: { type: 'drop', delta: 8 } })
    assert.ok(!result.itemIds.includes('down'))
    assert.match(result.advice, /降温8度/)
    assert.ok(result.bodyKey)
  }
})

test('温度资格覆盖所有区间边界，冬季毛衣及短装不进入不适温候选', () => {
  for (const high of [7, 8, 12]) assert.notEqual(temperatureRank(item('down', '羽绒服', ['冬']), weather(2, high)), null)
  for (const high of [13, 17, 18, 22, 23, 27, 28]) assert.equal(temperatureRank(item('down', '羽绒服', ['春秋']), weather(10, high)), null)
  for (const high of [18, 22]) assert.equal(temperatureRank(item('sweater', '毛衣', ['冬']), weather(14, high)), null)
  for (const high of [23, 27, 28, 35]) assert.equal(temperatureRank(item('sweater', '毛衣', ['夏']), weather(20, high)), null)
  for (const category of ['短袖', '短裤', '短裙']) assert.equal(temperatureRank(item('short', category, ['冬']), weather(2, 12)), null)
  assert.equal(temperatureRank(item('summer', '短袖', ['夏']), weather(25, 28)), 0)
  assert.equal(temperatureRank(item('winter', '长裤', ['冬']), weather(25, 28)), null)
})

test('冷天允许羽绒服和内搭，保暖衣无法单独充当上装', () => {
  const items = [item('top', '毛衣', ['冬']), item('pants', '长裤', ['冬']), item('down', '羽绒服', ['冬']),
    item('inner', '保暖衣', ['冬']), item('shoe', '鞋', [])]
  const result = buildRecommendation(weather(2, 7), items, options)
  assert.deepEqual(new Set(result.itemIds), new Set(items.map(row => row._id)))
  assert.deepEqual(result.missing, [])
  const innerOnly = buildRecommendation(weather(2, 7), [items[3]], options)
  assert.equal(innerOnly.bodyKey, '')
  assert.ok(innerOnly.missing.includes('上装与下装或连衣裙'))
})

test('下雨仍生成完整穿搭，鞋无季节也可用；大温差分层，20℃不选冬季外套', () => {
  const result = buildRecommendation(weather(2, 20, '小雨'), [...wardrobe(), item('coat', '外套', ['冬'])], options)
  assert.equal(result.itemIds.length, 4)
  assert.ok(result.itemIds.includes('shoe'))
  assert.ok(result.itemIds.includes('outer'))
  assert.ok(!result.itemIds.includes('coat'))
  assert.match(result.reason, /早晚增减/)
  assert.match(result.reason, /昼夜温差/)
  assert.match(result.reason, /带伞/)
  assert.deepEqual(result.missing, [])
})

test('完整连衣裙优先于残缺组合，最多一件点缀，暖天不用围巾', () => {
  const result = buildRecommendation(weather(19, 25), [item('top', '长袖'), item('dress', '连衣裙', ['夏']),
    item('shoe', '鞋', []), item('bag', '包袋'), { ...item('scarf', '配饰'), subcategory: '围巾' },
    item('home', '家居服'), item('misc', '其他'), item('charm', '挂件')], options)
  assert.deepEqual(result.itemIds, ['dress', 'shoe', 'bag'])
  assert.deepEqual(result.missing, [])
})

test('无实穿打卡也按推荐历史连续三天轮换主体，同日及输入倒序均稳定', () => {
  const history = []
  for (const date of ['2026-10-10', '2026-10-11', '2026-10-12']) {
    const context = { ...options, date, history }
    const result = buildRecommendation(weather(), wardrobe(), context)
    assert.ok(!history.some(row => row.bodyKey === result.bodyKey))
    assert.deepEqual(buildRecommendation(weather(), wardrobe().reverse(), context), result)
    history.push({ ...result, date })
  }
  assert.equal(new Set(history.map(row => row.bodyKey)).size, 3)
})

test('昨天的主体有替代时必须更换，只有适温一套时允许重复并解释', () => {
  const items = wardrobe().filter(row => !['top2', 'top3'].includes(row._id))
  const first = buildRecommendation(weather(), items, options)
  const history = [{ ...first, date: '2026-10-09' }]
  const repeat = buildRecommendation(weather(), items, { ...options, history })
  assert.equal(repeat.repeated, true)
  assert.equal(repeat.bodyKey, first.bodyKey)
  assert.match(repeat.reason, /组合较少/)
  const changed = buildRecommendation(weather(), [...items, item('new', '长袖')], { ...options, history })
  assert.notEqual(changed.bodyKey, first.bodyKey)
  assert.ok(changed.itemIds.includes('shoe')) // 鞋、外套允许重复
})

test('近期实穿上装降低优先级，未来及七天前记录不影响结果', () => {
  const first = buildRecommendation(weather(), wardrobe(), options)
  const topId = first.items.find(row => ROLES[row.category] === 'top')._id
  const avoided = buildRecommendation(weather(), wardrobe(), { ...options,
    wearRecords: [{ date: '2026-10-09', itemIds: [topId] }] })
  assert.ok(!avoided.itemIds.includes(topId))
  const ignored = buildRecommendation(weather(), wardrobe(), { ...options,
    history: [{ ...first, date: '2026-10-11' }, { ...first, date: '2026-10-01' }],
    wearRecords: [{ date: '2026-10-11', itemIds: [topId] }] })
  assert.deepEqual(ignored, first)
})

test('夏季和春秋组合都适温时，有替代仍更换昨天主体，不被季节偏好锁死', () => {
  const items = [item('summer-dress', '连衣裙', ['夏']), item('top', '衬衫'), item('pants', '长裤'), item('shoe', '鞋', [])]
  const result = buildRecommendation(weather(19, 25), items, { ...options,
    history: [{ date: '2026-10-09', bodyKey: 'summer-dress', itemIds: ['summer-dress', 'shoe'] }] })
  assert.equal(result.bodyKey, 'pants|top')
})

test('所有主体近期用过时先避开昨天，再选最久未推荐的组合', () => {
  const result = buildRecommendation(weather(), wardrobe(), { ...options, history: [
    { date: '2026-10-09', bodyKey: 'pants|top1', itemIds: ['pants', 'top1'] },
    { date: '2026-10-08', bodyKey: 'pants|top2', itemIds: ['pants', 'top2'] },
    { date: '2026-10-05', bodyKey: 'pants|top3', itemIds: ['pants', 'top3'] }
  ] })
  assert.equal(result.bodyKey, 'pants|top3')
})

test('轮换不绕过温度限制，缺项如实提示，配色优先减少多种亮色', () => {
  const items = [item('red', '长袖', ['春秋'], '红色'), item('black', '长袖'), item('pants', '长裤', ['春秋'], '蓝色'),
    item('down', '羽绒服', ['春秋'])]
  const result = buildRecommendation(weather(), items, options)
  assert.ok(result.itemIds.includes('black'))
  assert.ok(!result.itemIds.includes('down'))
  assert.deepEqual(result.missing, ['鞋', '春秋外套'])
  assert.match(result.reason, /请自行补齐/)
})

test('落地页展示完整理由与缺项，旧数据仍可展示摘要，选择和保存继续有效', async () => {
  let rec = { weather: weather(), reason: '早晚增减外套', missing: ['鞋'],
    items: [item('top', '长袖'), item('gone', '长裤')] }
  let saved
  const page = loadPage('weather-outfit', { getWeatherRecommendation: async () => rec,
    listItems: async () => [item('top', '长袖')], addOutfit: async data => { saved = data; return 'outfit' } })
  await page.onLoad({ date: options.date })
  assert.equal(page.data.reason, rec.reason)
  assert.equal(page.data.missingText, '鞋')
  assert.equal(page.data.selectedCount, 1)
  await page.onSaveOutfit()
  assert.deepEqual(Array.from(saved.itemIds), ['top'])
  rec = { advice: '旧摘要', items: [] }
  await page.onRetry()
  assert.equal(page.data.reason, '')
  assert.equal(page.data.advice, '旧摘要')
  assert.equal(page.data.missingText, '')
})
