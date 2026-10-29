// 兼容历史数字字符串；空值与无效值不代表 0 元。
function priceOf(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
  const price = Number(value)
  return Number.isFinite(price) && price >= 0 ? price : null
}

const centsOf = value => Math.round((priceOf(value) ?? 0) * 100)

module.exports = { priceOf, centsOf }
