// 沿用服务端返回的品牌写法，不自动合并别名或维护独立品牌库。
module.exports = function brandSuggestions(brands = [], input = '') {
  const query = input.trim().toLowerCase()
  if (!query) return []
  const seen = new Set(), result = []
  for (const value of brands) {
    if (typeof value !== 'string') continue
    const brand = value.trim(), key = brand.toLowerCase()
    if (!key.includes(query) || seen.has(key)) continue
    seen.add(key)
    result.push(brand)
    if (result.length === 8) break
  }
  return result
}
