const crypto = require('crypto')
const { FIELDS, cleanData, readDoc, claimImage, bumpWardrobeVersion, wearKey, hasSameWearRecord, wardrobeMetaId } = require('./data')
const COLLECTIONS = ['clothes', 'outfits', 'expenses', 'wear_records', 'outfit_plans', 'stickers']
const EXTRA = { clothes: ['seasons', 'price'], outfits: ['itemIds'], expenses: ['amount'],
  wear_records: ['itemIds'], outfit_plans: [], stickers: ['price', 'quantity'] }
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const sourceOf = (openid, env = '') => hash(`clothes-backup:${env}:${openid}`)
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 100
const mappedId = (source, ownSource, collection, id) => {
  if (!validId(id)) throw new Error('备份记录 ID 无效')
  return source === ownSource ? id : 'restored-' + hash(`${ownSource}:${source}:${collection}:${id}`)
}

async function exportPage({ db, openid, event }) {
  if (!COLLECTIONS.includes(event.collection) || !Number.isInteger(event.offset) || event.offset < 0) throw new Error('备份分页参数无效')
  const { data } = await db.collection(event.collection).where({ _openid: openid })
    .orderBy('createdAt', 'desc').orderBy('_id', 'desc').skip(event.offset).limit(20).get()
  return { success: true, records: data.map(record => ({ collection: event.collection, id: record._id,
    data: Object.fromEntries([...FIELDS[event.collection], ...EXTRA[event.collection]]
      .filter(key => record[key] !== undefined).map(key => [key, record[key]])),
    createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : null,
    updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null })) }
}

function validateRecords(records, source, ownSource) {
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(source) || !Array.isArray(records) || records.length > 20) throw new Error('备份批次无效')
  return records.map(row => {
    if (!row || !COLLECTIONS.includes(row.collection)) throw new Error('备份包含不支持的数据类型')
    const id = mappedId(source, ownSource, row.collection, row.id)
    const data = cleanData(row.collection, row.data, row.collection === 'stickers' ? { status: row.data?.status } : null, true)
    for (const field of ['createdAt', 'updatedAt']) {
      if (row[field] != null && !Number.isFinite(new Date(row[field]).getTime())) throw new Error('备份时间无效')
    }
    if (data.itemIds) data.itemIds = data.itemIds.map(value => mappedId(source, ownSource, 'clothes', value))
    if (data.itemId) data.itemId = mappedId(source, ownSource, 'clothes', data.itemId)
    if (data.outfitId) data.outfitId = mappedId(source, ownSource, 'outfits', data.outfitId)
    return { ...row, id, data }
  })
}

async function restoreImage(tx, openid, source, original, fileID) {
  const target = 'restore/' + hash(source + ':' + original)
  const match = typeof fileID === 'string' && fileID.match(/\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp|gif)$/)
  const ticket = match && await readDoc(tx.collection('upload_tickets').doc(match[1]))
  if (ticket && ticket._openid === openid && ticket.fileID === fileID && ticket.target === target && !ticket.cancelled) return
  await claimImage(tx, openid, fileID, '', target)
}

async function restoreBatch({ db, user, openid, event, ownSource }) {
  const rows = validateRecords(event.records, event.source, ownSource), images = event.images
  if (!images || typeof images !== 'object' || Array.isArray(images) || Object.keys(images).length > 40) throw new Error('备份图片映射无效')
  for (let attempt = 0; ; attempt++) {
    const version = (await readDoc(db.collection('wardrobe_meta').doc(wardrobeMetaId(openid))))?.version || 0
    const duplicates = new Set()
    for (const row of rows.filter(row => row.collection === 'wear_records')) {
      if (await hasSameWearRecord(db, openid, row.data.date, row.data.itemIds, row.id)) duplicates.add(row.id)
    }
    try {
      return await db.runTransaction(async tx => {
        const active = await readDoc(tx.collection('users').doc(user._id))
        if (!active || active.openid !== openid || active.autoLoginEnabled === false) throw new Error('登录状态已失效')
        let restored = 0, skipped = 0, changed = false
        const attached = new Set()
        for (const row of rows) {
          const ref = tx.collection(row.collection).doc(row.id), existing = await readDoc(ref)
          if (existing) {
            if (existing._openid !== openid) throw new Error('备份记录 ID 与其他账号冲突')
            skipped++; continue
          }
          const data = { ...row.data }
          if (row.collection === 'wear_records') {
            const key = wearKey(openid, data.date, data.itemIds), marker = await readDoc(tx.collection('wardrobe_meta').doc(key))
            if (duplicates.has(row.id) || (marker && marker.recordId !== row.id)) throw new Error('备份实穿组合与已有记录冲突，请先核对记录')
            await tx.collection('wardrobe_meta').doc(key).set({ data: { _openid: openid, recordId: row.id, date: data.date } })
          }
          for (const field of ['imageFileID', 'doneImageFileID']) {
            if (!data[field]) continue
            const original = data[field], fileID = images[original]
            if (!fileID) throw new Error('备份图片缺失，请重新选择完整备份')
            await restoreImage(tx, openid, event.source, original, fileID)
            data[field] = fileID
            attached.add(fileID)
          }
          await ref.set({ data: { ...data, _openid: openid,
            createdAt: row.createdAt ? new Date(row.createdAt) : db.serverDate(),
            ...(row.updatedAt ? { updatedAt: new Date(row.updatedAt) } : {}) } })
          changed ||= row.collection === 'clothes' || row.collection === 'wear_records'
          restored++
        }
        if (changed) await bumpWardrobeVersion(tx, openid, version)
        return { success: true, restored, skipped, images: [...attached] }
      })
    } catch (error) {
      if (attempt < 2 && /WEAR_RESCAN|DATABASE_TRANSACTION_CONFLICT|DATABASE_DUPLICATE_WRITE|E11000/.test(String(error.message || error.errMsg || error.code || ''))) continue
      throw error
    }
  }
}

async function handle(context) {
  const { event, openid, env } = context, ownSource = sourceOf(openid, env)
  if (event.action === 'backupInfo') return { success: true, source: ownSource, collections: COLLECTIONS }
  if (event.action === 'backupExport') return exportPage(context)
  if (event.action === 'backupValidate') {
    const rows = validateRecords(event.records, event.source, ownSource)
    const existing = []
    for (const row of rows) {
      const record = await readDoc(context.db.collection(row.collection).doc(row.id))
      if (record && record._openid !== openid) throw new Error('备份记录 ID 与其他账号冲突')
      existing.push(!!record)
    }
    return { success: true, existing }
  }
  return restoreBatch({ ...context, ownSource })
}

module.exports = { handle, sourceOf }
