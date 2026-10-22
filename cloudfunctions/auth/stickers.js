// 造景贴纸统计聚合。口径与 SPEC 3.3/3.4 同源：库存 = owned + done，心愿 = wishlist；
// 月历开销复用同一线条金额规则，贴纸主页独立展示 ownedSpent，改这里必须同步改读取侧。
const THEME_TAGS = ['古风造景', '街景造景', '自然造景', '室内造景', '美食造景', '节日造景', '其他']
const PAGE_SIZE = 100

const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100

// 线条金额 = 单价 × 数量：缺 price 按 0（心愿缺价因此自然不计），缺 quantity 按 1
function lineTotal(record) {
  const price = Number.isFinite(record.price) ? record.price : 0
  const quantity = Number.isInteger(record.quantity) && record.quantity > 0 ? record.quantity : 1
  return price * quantity
}

function aggregate(records) {
  const stocked = records.filter(r => r.status === 'owned' || r.status === 'done')
  const wishes = records.filter(r => r.status === 'wishlist')
  const brandMap = new Map()
  for (const r of stocked) {
    const name = (r.brand || '').trim() || '未填'
    const row = brandMap.get(name) || { name, count: 0, spent: 0 }
    row.count += 1
    row.spent += lineTotal(r)
    brandMap.set(name, row)
  }
  const brands = [...brandMap.values()]
    .map(row => ({ ...row, spent: roundMoney(row.spent) }))
    .sort((a, b) => b.spent - a.spent || b.count - a.count || (a.name < b.name ? -1 : 1))
  const themeMap = new Map()
  for (const r of stocked) {
    // 空标签与未知值并入预设「其他」，不重复计组
    const name = THEME_TAGS.includes(r.themeTag) ? r.themeTag : '其他'
    themeMap.set(name, (themeMap.get(name) || 0) + 1)
  }
  const themes = [...themeMap.entries()]
    .map(([name, count]) => ({ name, count, percent: stocked.length ? Math.round(count / stocked.length * 100) : 0 }))
    .sort((a, b) => b.count - a.count || THEME_TAGS.indexOf(a.name) - THEME_TAGS.indexOf(b.name))
  return {
    ownedCount: stocked.length,
    ownedSpent: roundMoney(stocked.reduce((sum, r) => sum + lineTotal(r), 0)),
    doneCount: records.filter(r => r.status === 'done').length,
    wishCount: wishes.length,
    wishTotal: roundMoney(wishes.reduce((sum, r) => sum + lineTotal(r), 0)),
    brands,
    themes
  }
}

async function stats({ db, openid }) {
  const records = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await db.collection('stickers').where({ _openid: openid }).skip(offset).limit(PAGE_SIZE).get()
    records.push(...res.data)
    if (res.data.length < PAGE_SIZE) break
  }
  return { success: true, stats: aggregate(records) }
}

module.exports = { stats, aggregate, lineTotal, THEME_TAGS }
