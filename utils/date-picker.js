const { validDate, MIN_YEAR, MAX_YEAR } = require('./date')

function daysIn(year, month) {
  const count = new Date(Number(year), Number(month), 0).getDate()
  return Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, '0'))
}

function buildDateColumns(dateStr, maxDate = '') {
  const years = []
  const end = validDate(maxDate) ? maxDate : ''
  for (let year = MIN_YEAR; year <= (end ? Number(end.slice(0, 4)) : MAX_YEAR); year++) years.push(String(year))
  const now = new Date()
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const selected = validDate(dateStr) && (!end || dateStr <= end) ? dateStr : end || fallback
  const [year, month, day] = selected.split('-')
  const monthCount = end && year === end.slice(0, 4) ? Number(end.slice(5, 7)) : 12
  const months = Array.from({ length: monthCount }, (_, index) => String(index + 1).padStart(2, '0'))
  const dayCount = end && selected.slice(0, 7) === end.slice(0, 7) ? Number(end.slice(8, 10)) : daysIn(year, month).length
  const days = Array.from({ length: dayCount }, (_, index) => String(index + 1).padStart(2, '0'))
  return { columns: [years, months, days], maxDate: end,
    values: [Math.max(years.indexOf(year), 0), Math.max(months.indexOf(month), 0), Math.max(days.indexOf(day), 0)] }
}

function onPickerColumnChange(e) {
  const { picker } = this.data
  if (picker.target !== 'date') return
  const values = e.detail.values
  const year = picker.columns[0][values[0]]
  const monthCount = picker.maxDate && year === picker.maxDate.slice(0, 4) ? Number(picker.maxDate.slice(5, 7)) : 12
  const months = Array.from({ length: monthCount }, (_, index) => String(index + 1).padStart(2, '0'))
  const monthIndex = Math.min(values[1], months.length - 1)
  const month = months[monthIndex]
  const dayCount = picker.maxDate && `${year}-${month}` === picker.maxDate.slice(0, 7)
    ? Number(picker.maxDate.slice(8, 10)) : daysIn(year, month).length
  const days = Array.from({ length: dayCount }, (_, index) => String(index + 1).padStart(2, '0'))
  if (months.length !== picker.columns[1].length || days.length !== picker.columns[2].length) {
    this.setData({
      'picker.columns': [picker.columns[0], months, days],
      'picker.values': [values[0], monthIndex, Math.min(values[2], days.length - 1)]
    })
  }
}

module.exports = { buildDateColumns, daysIn, onPickerColumnChange }
