const crypto = require('crypto')

const PAGE_SIZE = 100
const SCENE = 'idle-monthly'
const QUOTA_SCENE = 'idle-monthly-quota'
const SENT_SCENE = 'idle-monthly-sent'
const DAY_MS = 86400000
const TEXT_LIMIT = 20
const quotaId = openid => 'quota-' + crypto.createHash('sha256').update(openid).digest('hex')
// 账号+月份的持久幂等记录：同月重复运行、触发器重试或并发执行都只发送一次
const sentId = (openid, month) => `sent-${openid}-${month}`

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour12: false, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
}

function formatShanghai(date) {
  const value = shanghaiParts(date)
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`
}

function shanghaiDate(date) { return formatShanghai(date).slice(0, 10) }

function cutoffDate(date) {
  const value = shanghaiParts(date)
  const cutoff = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)) - 90 * DAY_MS)
  const pad = number => String(number).padStart(2, '0')
  return `${cutoff.getUTCFullYear()}-${pad(cutoff.getUTCMonth() + 1)}-${pad(cutoff.getUTCDate())}`
}

function trimText(value, limit = TEXT_LIMIT) {
  return Array.from(String(value || '')).slice(0, limit).join('')
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function summarize(items) {
  const names = items.map(item => trimText(item.name || '未命名', TEXT_LIMIT)).filter(Boolean)
  const total = names.length
  if (!total) return ''
  let take = Math.min(3, total)
  const suffix = () => total > take ? `等${total}件` : ''
  const build = () => names.slice(0, take).join('、') + suffix()
  while (take > 2 && Array.from(build()).length > TEXT_LIMIT) take--
  const tail = suffix()
  return trimText(names.slice(0, take).join('、'), TEXT_LIMIT - Array.from(tail).length) + tail
}

async function listAll(db, collection, where) {
  const result = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await db.collection(collection).where(where).skip(offset).limit(PAGE_SIZE).get()
    result.push(...res.data)
    if (res.data.length < PAGE_SIZE) return result
  }
}

async function buildReport(db, openid, now) {
  const cutoff = cutoffDate(now)
  const today = shanghaiDate(now)
  const [items, records] = await Promise.all([
    listAll(db, 'clothes', { _openid: openid }),
    listAll(db, 'wear_records', { _openid: openid })
  ])
  const validRecords = records.filter(record => validDate(record.date) && record.date <= today)
  if (!validRecords.some(record => record.date >= cutoff)) return null

  const lastWorn = Object.create(null)
  validRecords.forEach(record => (record.itemIds || []).forEach(id => {
    if (!lastWorn[id] || record.date > lastWorn[id]) lastWorn[id] = record.date
  }))
  const idle = items.filter(item => validDate(item.purchaseDate) &&
      item.purchaseDate < cutoff && (!lastWorn[item._id] || lastWorn[item._id] < cutoff))
    .sort((a, b) => (lastWorn[a._id] || a.purchaseDate).localeCompare(lastWorn[b._id] || b.purchaseDate))
  if (!idle.length) return null
  return { count: idle.length, summary: summarize(idle) }
}

async function claim(db, id, consumedAt) {
  const month = formatShanghai(consumedAt).slice(0, 7)
  return db.runTransaction(async tx => {
    const ref = tx.collection('subscriptions').doc(id)
    const res = await ref.get()
    const row = Array.isArray(res.data) ? res.data[0] : res.data
    if (!row || row.consumedAt) return false
    const markerRef = tx.collection('subscriptions').doc(sentId(row._openid, month))
    const markerRes = await markerRef.get()
    const marker = Array.isArray(markerRes.data) ? markerRes.data[0] : markerRes.data
    if (marker) return false
    const quotaRef = tx.collection('subscriptions').doc(quotaId(row._openid))
    const quotaRes = await quotaRef.get()
    const quota = Array.isArray(quotaRes.data) ? quotaRes.data[0] : quotaRes.data
    await ref.update({ data: { consumedAt } })
    await markerRef.set({ data: { _openid: row._openid, scene: SENT_SCENE, month, createdAt: consumedAt } })
    if (quota && quota.scene === QUOTA_SCENE) {
      const unused = Number.isInteger(quota.unused) ? quota.unused : 0
      await quotaRef.update({ data: { unused: Math.max(0, unused - 1), updatedAt: consumedAt } })
    }
    return true
  })
}

async function restoreClaim(db, id, restoredAt) {
  const month = formatShanghai(restoredAt).slice(0, 7)
  return db.runTransaction(async tx => {
    const ref = tx.collection('subscriptions').doc(id)
    const res = await ref.get()
    const row = Array.isArray(res.data) ? res.data[0] : res.data
    if (!row || !row.consumedAt) return
    const quotaRef = tx.collection('subscriptions').doc(quotaId(row._openid))
    const quotaRes = await quotaRef.get()
    const quota = Array.isArray(quotaRes.data) ? quotaRes.data[0] : quotaRes.data
    await ref.update({ data: { consumedAt: db.command.remove() } })
    // 删除月度幂等记录，同月重跑可再次尝试发送
    await tx.collection('subscriptions').doc(sentId(row._openid, month)).remove()
    if (quota && quota.scene === QUOTA_SCENE) {
      const unused = Number.isInteger(quota.unused) ? quota.unused : 0
      await quotaRef.update({ data: { unused: Math.min(12, unused + 1), updatedAt: restoredAt } })
    }
  })
}

function errorCode(error) {
  const message = String(error && (error.message || error.errMsg) || '')
  if (message.includes('43101')) return 43101
  return Number(error && (error.errCode || error.errcode || error.code))
}

async function sendReport({ db, cloud, subscription, report, templateId, now }) {
  if (!await claim(db, subscription._id, now)) return 'claimed'
  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: subscription._openid,
      templateId,
      page: 'pages/stats/stats',
      data: {
        thing1: { value: '衣橱闲置月报' },
        thing4: { value: '近90天未记录穿着' },
        number16: { value: report.count },
        thing29: { value: report.summary },
        time23: { value: formatShanghai(now) }
      }
    })
    if (result && Number(result.errCode || result.errcode || 0)) {
      const error = new Error(result.errMsg || result.errmsg || '订阅消息发送失败')
      error.errCode = result.errCode || result.errcode
      throw error
    }
    return 'sent'
  } catch (error) {
    if (errorCode(error) === 43101) {
      await db.collection('subscriptions').doc(subscription._id).remove()
      return 'expired'
    }
    await restoreClaim(db, subscription._id, now)
    throw error
  }
}

async function handle({ db, cloud, templateId, now = new Date() }) {
  if (!templateId) throw new Error('REPORT_TMPL_ID 未配置')
  const seen = new Set()
  const summary = { success: true, scanned: 0, sent: 0, skipped: 0, expired: 0, failed: 0 }
  let cursor = ''
  for (;;) {
    const where = cursor ? { _id: db.command.gt(cursor) } : {}
    const res = await db.collection('subscriptions').where(where).orderBy('_id', 'asc').limit(PAGE_SIZE).get()
    for (const subscription of res.data) {
      if (subscription.scene !== SCENE) continue
      summary.scanned++
      if (subscription.consumedAt || !subscription._openid || seen.has(subscription._openid)) continue
      seen.add(subscription._openid)
      try {
        const report = await buildReport(db, subscription._openid, now)
        if (!report) {
          summary.skipped++
          continue
        }
        const state = await sendReport({ db, cloud, subscription, report, templateId, now })
        if (state === 'sent') summary.sent++
        if (state === 'expired') summary.expired++
      } catch (error) {
        summary.failed++
        console.error('闲置月报发送失败', subscription._openid, error)
      }
    }
    if (res.data.length < PAGE_SIZE) return summary
    cursor = res.data[res.data.length - 1]._id
  }
}

module.exports = { handle, buildReport, summarize, formatShanghai, cutoffDate }
