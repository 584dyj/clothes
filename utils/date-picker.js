const { validDate, MIN_YEAR, MAX_YEAR } = require('./date')

function daysIn(year, month) {
  const count = new Date(Number(year), Number(month), 0).getDate()
  return Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, '0'))
}

function buildDateColumns(dateStr) {
  const years = []
  for (let year = MIN_YEAR; year <= MAX_YEAR; year++) years.push(String(year))
  const months = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'))
  const date = validDate(dateStr) ? new Date(dateStr.replace(/-/g, '/')) : new Date()
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const days = daysIn(year, month)
  const day = String(Math.min(date.getDate(), days.length)).padStart(2, '0')
  return { columns: [years, months, days],
    values: [Math.max(years.indexOf(year), 0), months.indexOf(month), days.indexOf(day)] }
}

function onPickerColumnChange(e) {
  const { picker } = this.data
  if (picker.target !== 'date') return
  const values = e.detail.values
  const days = daysIn(picker.columns[0][values[0]], picker.columns[1][values[1]])
  if (days.length !== picker.columns[2].length) {
    this.setData({
      'picker.columns': [picker.columns[0], picker.columns[1], days],
      'picker.values': [values[0], values[1], Math.min(values[2], days.length - 1)]
    })
  }
}

module.exports = { buildDateColumns, daysIn, onPickerColumnChange }
