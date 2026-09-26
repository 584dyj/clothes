const test = require('node:test')
const assert = require('node:assert/strict')
const datePicker = require('../utils/date-picker')

test('共用日期滚轮在闰年切换年份时收紧日期', () => {
  const picker = { target: 'date', ...datePicker.buildDateColumns('2024-02-29') }
  assert.equal(picker.columns[2].length, 29)
  const page = { data: { picker }, setData(patch) {
    this.data.picker.columns = patch['picker.columns']
    this.data.picker.values = patch['picker.values']
  } }
  const values = [picker.columns[0].indexOf('2025'), 1, 28]
  datePicker.onPickerColumnChange.call(page, { detail: { values } })
  assert.equal(page.data.picker.columns[2].length, 28)
  assert.equal(page.data.picker.values[2], 27)
})
