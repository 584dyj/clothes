// 连续打卡统计：纯客户端计算，数据来自 wear_records。
const { validDate } = require('./date')

function shiftDay(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00')
  date.setDate(date.getDate() + days)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// 有效打卡日期集合：剔除非法日期与晚于今天的记录
function validDates(records, today) {
  const set = new Set()
  for (const record of records || []) {
    const date = record && record.date
    if (validDate(date) && date <= today) set.add(date)
  }
  return set
}

// 连续打卡天数：今天尚未打卡不断签，从今天或昨天起向前逐日计数
function streakDays(records, today) {
  const dates = validDates(records, today)
  let cursor = dates.has(today) ? today : shiftDay(today, -1)
  let count = 0
  while (dates.has(cursor)) {
    count++
    cursor = shiftDay(cursor, -1)
  }
  return count
}

// 本月打卡天数（不同日期数）
function monthDays(records, today) {
  const month = today.slice(0, 7)
  let count = 0
  for (const date of validDates(records, today)) if (date.startsWith(month)) count++
  return count
}

module.exports = { streakDays, monthDays }
