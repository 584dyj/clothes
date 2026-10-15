function cleanScanFields(value, options) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
  const category = options.categories.includes(item.category) ? item.category : ''
  return {
    name: text(item.name, 60),
    category,
    subcategory: category === '配饰' && options.accessoryTypes.includes(item.subcategory) ? item.subcategory : '',
    color: options.colors.includes(item.color) ? item.color : '',
    seasons: Array.isArray(item.seasons) ? [...new Set(item.seasons)].filter(value => options.seasons.includes(value)) : [],
    brand: text(item.brand, 30)
  }
}

module.exports = { cleanScanFields }
