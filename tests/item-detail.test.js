const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')

// harness 的 setTimeout 默认为空操作，异步等待统一走 setImmediate
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }
// 页面在 vm 沙箱中运行，其产出的数组/对象带 vm 原型，严格比较前先转换为普通对象
const plain = value => JSON.parse(JSON.stringify(value))

const item = (overrides = {}) => ({
  _id: 'pants', name: '黑裤子', category: '下装', subcategory: '', size: 'L',
  color: '黑', brand: '无印', seasons: ['春秋', '冬'], price: 199,
  purchaseDate: '2026-01-01', note: '', imageFileID: 'cloud://pants', ...overrides
})

const coat = () => ({ _id: 'coat', name: '大衣', imageFileID: 'cloud://coat' })

function detailDb(overrides = {}) {
  return {
    getItem: async () => item(),
    listOutfits: async () => [],
    listItems: async () => [item(), coat()],
    ...overrides
  }
}

async function openDetail(db, wx = {}, id = 'pants', auth = {}) {
  const page = loadPage('item-detail', db, wx, auth)
  await page.onLoad({ id })
  await page.onShow()
  await flush()
  return page
}

// ---------- 入口（VIEW-03） ----------

test('衣橱与分类入口进入同一详情页且 id 正确编码，新增入口保持不变', () => {
  const routes = []
  const wx = { navigateTo: ({ url }) => routes.push(url) }
  const wardrobe = loadPage('wardrobe', {}, wx)
  wardrobe.onItemTap({ currentTarget: { dataset: { id: 'a/b' } } })
  assert.equal(routes[0], '/pages/item-detail/item-detail?id=a%2Fb')
  wardrobe.onAddTap()
  assert.equal(routes[1], '/pages/item-edit/item-edit')

  const category = loadPage('category', {}, wx)
  category.onItemTap({ currentTarget: { dataset: { id: 'pants' } } })
  assert.equal(routes[2], '/pages/item-detail/item-detail?id=pants')
})

test('月历衣物进入详情，账本与计划入口不变', () => {
  const routes = []
  const calendar = loadPage('calendar', {}, { navigateTo: ({ url }) => routes.push(url) })
  calendar.onItemTap({ currentTarget: { dataset: { id: 'pants' } } })
  calendar.onExpenseTap({ currentTarget: { dataset: { id: 'exp-1' } } })
  calendar.onPlanTap({ currentTarget: { dataset: { id: 'plan-1' } } })
  assert.equal(routes[0], '/pages/item-detail/item-detail?id=pants')
  assert.equal(routes[1], '/pages/expense-edit/expense-edit?id=exp-1')
  assert.equal(routes[2], '/pages/plan-edit/plan-edit?id=plan-1')
})

// ---------- 主记录（VIEW-01） ----------

test('非法 id 直接进入不可用态，不发任何数据请求', async () => {
  let calls = 0
  const db = detailDb({ getItem: async () => { calls++ }, listOutfits: async () => { calls++; return [] }, listItems: async () => { calls++; return [] } })
  for (const options of [{}, { id: '' }, { id: 'x'.repeat(101) }]) {
    const page = loadPage('item-detail', db)
    await page.onLoad(options)
    await page.onShow()
    await flush()
    assert.equal(page.data.unavailable, true)
    assert.equal(page.data.ready, false)
  }
  assert.equal(calls, 0)
})

test('主记录字段渲染：0 价格显示、空价格标记未填写、配饰子类与季节拼接', async () => {
  const zero = await openDetail(detailDb({ getItem: async () => item({ price: 0 }) }))
  assert.equal(zero.data.item.hasPrice, true)
  assert.equal(zero.data.item.priceText, '¥0.00')
  assert.equal(zero.data.item.seasonsText, '春秋 / 冬')

  const legacy = await openDetail(detailDb({ getItem: async () => item({ price: undefined }) }))
  assert.equal(legacy.data.item.hasPrice, false)

  const accessory = await openDetail(detailDb({
    getItem: async () => item({ category: '配饰', subcategory: '帽子', price: 19.9 })
  }))
  assert.equal(accessory.data.item.categoryText, '配饰 / 帽子')
  assert.equal(accessory.data.item.priceText, '¥19.90')
})

test('不存在或无权访问显示不可用，其他失败可重试恢复', async () => {
  const gone = await openDetail(detailDb({ getItem: async () => { throw new Error('记录不存在或无权访问') } }))
  assert.equal(gone.data.unavailable, true)
  assert.equal(gone.data.loadError, '')
  assert.equal(gone.data.ready, false)

  let attempts = 0
  const flaky = await openDetail(detailDb({
    getItem: async () => { attempts++; if (attempts === 1) throw new Error('网络超时'); return item() }
  }))
  assert.equal(flaky.data.unavailable, false)
  assert.equal(flaky.data.loadError, '衣物加载失败，请重试')
  assert.equal(flaky.data.ready, false)
  await flaky.onRetry()
  await flush()
  assert.equal(flaky.data.ready, true)
  assert.equal(flaky.data.item.name, '黑裤子')
  assert.equal(attempts, 2)
})

test('登录失败时主记录与关联各自进入错误态，不发数据请求', async () => {
  let calls = 0
  const page = await openDetail(detailDb({
    getItem: async () => { calls++ },
    listOutfits: async () => { calls++; return [] },
    listItems: async () => { calls++; return [] }
  }), {}, 'pants', { ensureLogin: async () => false })
  assert.equal(page.data.loadError, '登录校验未完成，请重试')
  assert.equal(page.data.relatedError, '登录校验未完成，请重试')
  assert.equal(page.data.ready, false)
  assert.equal(calls, 0)
})

// ---------- 关联穿搭（VIEW-02） ----------

test('关联筛选：包含才匹配、套内去重、套间不合并、空穿搭不匹配，第 21 与 41 条历史记录也展示', async () => {
  const outfits = Array.from({ length: 45 }, (_, i) => ({ _id: `fit-${i}`, name: `搭配${i}`, itemIds: [`other-${i}`] }))
  outfits[20] = { _id: 'fit-20', name: '', occasion: '上班', note: '通勤备注', imageFileID: 'cloud://photo', itemIds: ['pants', 'coat', 'pants'] }
  outfits[40] = { _id: 'fit-40', name: '周末', itemIds: ['coat', 'pants'] }
  outfits.push({ _id: 'fit-empty', name: '空穿搭', itemIds: [] })
  let listCalls = 0
  const page = await openDetail(detailDb({ listOutfits: async () => { listCalls++; return outfits } }))

  assert.equal(listCalls, 1) // 全量一次拉取，不使用首页分页
  assert.equal(page.data.relatedTotal, 2)
  assert.equal(page.data.outfits.length, 2)
  const [first, second] = page.data.outfits
  // 服务端原顺序保留；套内重复 id 只显示一次且保留原顺序
  assert.equal(first._id, 'fit-20')
  assert.equal(first.name, '未命名穿搭')
  assert.equal(first.occasion, '上班')
  assert.equal(first.note, '通勤备注')
  assert.equal(first.imageFileID, 'cloud://photo')
  assert.deepEqual(Array.from(first.items, part => part.id), ['pants', 'coat'])
  assert.equal(first.items[0].isCurrent, true)
  assert.equal(first.items[1].isCurrent, false)
  // 单品构成相同的另一套保留为不同卡片
  assert.equal(second._id, 'fit-40')
  assert.deepEqual(Array.from(second.items, part => part.id), ['coat', 'pants'])
})

test('超过 10 套本地批次追加，总数准确且触底不再发请求', async () => {
  const outfits = Array.from({ length: 12 }, (_, i) => ({ _id: `fit-${i}`, name: `搭配${i}`, itemIds: ['pants'] }))
  let listCalls = 0
  const page = await openDetail(detailDb({ listOutfits: async () => { listCalls++; return outfits } }))
  assert.equal(page.data.relatedTotal, 12)
  assert.equal(page.data.outfits.length, 10)
  assert.equal(page.data.hasMore, true)

  page.onReachBottom()
  assert.equal(page.data.outfits.length, 12)
  assert.equal(page.data.hasMore, false)
  page.onReachBottom()
  assert.equal(page.data.outfits.length, 12)
  assert.equal(listCalls, 1)
})

test('失效引用占位不丢整套，只浏览与放大图片不产生任何写操作', async () => {
  const writes = []
  const previews = []
  const db = detailDb({
    listOutfits: async () => [{ _id: 'fit-1', name: '一套', itemIds: ['pants', 'ghost', 'coat'] }]
  })
  for (const name of ['addItem', 'updateItem', 'deleteItem', 'addOutfit', 'updateOutfit', 'deleteOutfit', 'addWearRecord']) {
    db[name] = async () => { writes.push(name) }
  }
  const page = await openDetail(db, { previewImage: opts => previews.push(opts.urls) })
  const parts = page.data.outfits[0].items
  assert.deepEqual(Array.from(parts, part => part.id), ['pants', 'ghost', 'coat'])
  assert.equal(parts[1].available, false)
  assert.equal(parts[0].available, true)

  page.onPreviewMain()
  page.onPreviewItemImage({ currentTarget: { dataset: { url: 'cloud://coat' } } })
  page.onPreviewOutfitPhoto({ currentTarget: { dataset: { url: '' } } }) // 无照片无动作
  page.onReachBottom()
  assert.deepEqual(plain(previews), [['cloud://pants'], ['cloud://coat']])
  assert.deepEqual(writes, [])
})

test('关联失败与空态分离，重试仅重关联且不影响已成功主记录的编辑入口', async () => {
  let getItemCalls = 0, outfitCalls = 0, fail = true
  const navs = []
  const page = await openDetail(detailDb({
    getItem: async () => { getItemCalls++; return item() },
    listOutfits: async () => { outfitCalls++; if (fail) throw new Error('offline'); return [{ _id: 'fit-1', name: '一套', itemIds: ['pants'] }] }
  }), { navigateTo: opts => { navs.push(opts); opts.complete() } })
  assert.equal(page.data.relatedError, '相关穿搭加载失败，点击重试')
  assert.equal(page.data.relatedReady, false)
  assert.equal(page.data.ready, true) // 主记录成功，编辑入口可用
  page.onEditTap()
  assert.equal(navs.length, 1)

  fail = false
  await page.onRelatedRetry()
  await flush()
  assert.equal(page.data.relatedError, '')
  assert.equal(page.data.relatedTotal, 1)
  assert.equal(outfitCalls, 2)
  assert.equal(getItemCalls, 1) // 重试没有重载主记录
})

test('读取成功但无匹配显示空态，主记录失败时关联区独立加载', async () => {
  const empty = await openDetail(detailDb({ listOutfits: async () => [{ _id: 'fit-1', itemIds: ['other'] }] }))
  assert.equal(empty.data.relatedReady, true)
  assert.equal(empty.data.relatedTotal, 0)
  assert.equal(empty.data.relatedError, '')

  const broken = await openDetail(detailDb({
    getItem: async () => { throw new Error('网络超时') },
    listOutfits: async () => [{ _id: 'fit-1', name: '一套', itemIds: ['pants'] }]
  }))
  assert.equal(broken.data.loadError, '衣物加载失败，请重试')
  assert.equal(broken.data.ready, false)
  assert.equal(broken.data.relatedReady, true)
  assert.equal(broken.data.relatedTotal, 1)
})

// ---------- 刷新与回程（VIEW-02 / VIEW-03） ----------

test('每次 onShow 重读主记录与关联，编辑保存后详情刷新', async () => {
  let getItemCalls = 0, outfitCalls = 0, name = '黑裤子'
  const page = await openDetail(detailDb({
    getItem: async () => { getItemCalls++; return item({ name }) },
    listOutfits: async () => { outfitCalls++; return [] }
  }))
  assert.equal(page.data.item.name, '黑裤子')

  name = '黑裤子（改）'
  await page.onShow() // 模拟编辑保存后返回
  await flush()
  assert.equal(page.data.item.name, '黑裤子（改）')
  assert.equal(getItemCalls, 2)
  assert.equal(outfitCalls, 2) // 不被衣物版本或缓存短路
})

test('快速刷新旧响应被丢弃，卸载后完成不回填', async () => {
  const pending = []
  const page = loadPage('item-detail', detailDb({ getItem: () => new Promise(resolve => pending.push(resolve)) }))
  await page.onLoad({ id: 'pants' })
  const s1 = page.onShow()
  await flush(2)
  const s2 = page.onShow()
  await flush(2)
  assert.equal(pending.length, 2)
  pending[1](item({ name: '新' }))
  await flush()
  pending[0](item({ name: '旧' })) // 旧请求晚返回，不得覆盖
  await flush()
  assert.equal(page.data.item.name, '新')
  assert.equal(page.data.loadError, '')
  await Promise.all([s1, s2])

  const pending2 = []
  const gone = loadPage('item-detail', detailDb({ getItem: () => new Promise(resolve => pending2.push(resolve)) }))
  await gone.onLoad({ id: 'pants' })
  const s3 = gone.onShow()
  await flush(2)
  gone.onUnload()
  pending2[0](item())
  await flush()
  assert.equal(gone.data.item, null)
  await s3
})

test('下拉刷新强制重读两个列表并结束动画，失败同样结束', async () => {
  const forces = { outfits: [], items: [] }
  let stopped = 0
  const page = await openDetail(detailDb({
    listOutfits: async force => { forces.outfits.push(force); return [] },
    listItems: async force => { forces.items.push(force); return [] }
  }), { stopPullDownRefresh: () => { stopped++ } })
  await page.onPullDownRefresh()
  assert.deepEqual(forces.outfits, [false, true])
  assert.deepEqual(forces.items, [false, true])
  assert.equal(stopped, 1)

  let stopped2 = 0
  const failing = await openDetail(detailDb({
    listOutfits: async force => { if (force) throw new Error('offline'); return [] }
  }), { stopPullDownRefresh: () => { stopped2++ } })
  await failing.onPullDownRefresh()
  assert.equal(stopped2, 1)
  assert.equal(failing.data.relatedError, '相关穿搭加载失败，点击重试')
})

test('编辑导航防连点与完成恢复，主记录未就绪禁止编辑', async () => {
  const navs = []
  const page = await openDetail(detailDb(), { navigateTo: opts => navs.push(opts) })
  page.onEditTap()
  page.onEditTap() // 导航中，被拦截
  assert.equal(navs.length, 1)
  assert.equal(navs[0].url, '/pages/item-edit/item-edit?id=pants')
  navs[0].complete()
  assert.equal(page.data.navigating, false)
  page.onEditTap()
  assert.equal(navs.length, 2)

  const broken = await openDetail(detailDb({ getItem: async () => { throw new Error('网络超时') } }),
    { navigateTo: opts => navs.push(opts) })
  broken.onEditTap()
  assert.equal(navs.length, 2) // 未就绪，没有新导航
})

test('删除事件匹配时回退一次并兜底，id 不匹配正常刷新', async () => {
  const navs = [], tabs = []
  const page = await openDetail(detailDb(), {
    navigateTo: opts => { navs.push(opts); opts.complete() },
    switchTab: opts => tabs.push(opts.url)
  })
  page.onEditTap()
  navs[0].events.itemDeleted({ id: 'other' }) // 负载不匹配：不标记删除
  await page.onShow()
  await flush()
  assert.equal(page.data.item.name, '黑裤子')
  assert.equal(tabs.length, 0)

  page.onEditTap()
  navs[1].events.itemDeleted({ id: 'pants' })
  await page.onShow() // 无上一页：switchTab 兜底
  assert.deepEqual(tabs, ['/pages/wardrobe/wardrobe'])
  await page.onShow() // 只回退一次
  assert.equal(tabs.length, 1)

  let backs = 0
  const withStack = await openDetail(detailDb(), {
    navigateTo: opts => { navs.push(opts); opts.complete() },
    navigateBack: () => { backs++ },
    getCurrentPages: () => [{}, {}]
  })
  withStack.onEditTap()
  navs[2].events.itemDeleted({ id: 'pants' })
  await withStack.onShow()
  assert.equal(backs, 1) // 有上一页：回退到真实来源
})

test('item-edit 删除成功与清理待重试都发送事件，删除失败不发送', async () => {
  async function deleteFlow(deleteImpl, withChannel) {
    const emitted = []
    const page = loadPage('item-edit', {
      getItem: async () => ({ _id: 'pants', name: '黑裤子', category: '下装' }),
      deleteItem: deleteImpl
    }, { showModal: opts => opts.success({ confirm: true }) })
    await page.onLoad({ id: 'pants' })
    if (withChannel) page.getOpenerEventChannel = () => ({ emit: (name, payload) => emitted.push([name, payload]) })
    page.onDelete()
    await flush()
    return emitted
  }

  assert.deepEqual(plain(await deleteFlow(async () => ({}), true)), [['itemDeleted', { id: 'pants' }]])
  assert.deepEqual(plain(await deleteFlow(async () => ({ cleanupFailed: true }), true)), [['itemDeleted', { id: 'pants' }]])
  assert.deepEqual(await deleteFlow(async () => { throw new Error('offline') }, true), [])
  await deleteFlow(async () => ({}), false) // 无事件通道监听者：保持原行为不报错
})

test('主图加载失败切换占位且不再响应预览', async () => {
  const previews = []
  const page = await openDetail(detailDb(), { previewImage: opts => previews.push(opts.urls) })
  page.onPreviewMain()
  assert.deepEqual(plain(previews), [['cloud://pants']])
  page.onMainImageError()
  assert.equal(page.data.item.imageBroken, true)
  page.onPreviewMain()
  assert.equal(previews.length, 1)
})
