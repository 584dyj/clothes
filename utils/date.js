const MIN_YEAR = 2022
const MAX_YEAR = 2030

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return year >= MIN_YEAR && year <= MAX_YEAR && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

// 客户端「今天」（Asia/Shanghai）：与统计页、实穿页同一口径，写实穿记录时统一用它。
function today() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

module.exports = { validDate, today, MIN_YEAR, MAX_YEAR }
