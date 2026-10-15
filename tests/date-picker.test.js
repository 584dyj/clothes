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

test('实穿日期滚轮只提供今天及以前的日期', () => {
  const picker = { target: 'date', ...datePicker.buildDateColumns('2027-01-01', '2026-10-15') }
  assert.equal(picker.columns[0].at(-1), '2026')
  assert.equal(picker.columns[1].at(-1), '10')
  assert.equal(picker.columns[2].at(-1), '15')
  assert.deepEqual(picker.values, [4, 9, 14])
  const page = { data: { picker }, setData(patch) {
    this.data.picker.columns = patch['picker.columns']
    this.data.picker.values = patch['picker.values']
  } }
  datePicker.onPickerColumnChange.call(page, { detail: { values: [3, 9, 14] } })
  assert.equal(page.data.picker.columns[1].length, 12)
  assert.equal(page.data.picker.columns[2].length, 31)
})
