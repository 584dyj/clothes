const crypto = require('crypto')
const { CATEGORIES, ACCESSORY_TYPES } = require('./categories')

async function readDoc(ref) {
  try {
    const res = await ref.get()
    return Array.isArray(res.data) ? res.data[0] || null : res.data || null
  } catch (e) {
    if (/document.*(not exist|not found)|文档不存在/i.test(e.message || e.errMsg || '')) return null
    throw e
  }
}

const jobId = fileID => crypto.createHash('sha256').update(fileID).digest('hex')

async function queueImage(tx, openid, fileID) {
  if (!fileID) return
  await tx.collection('cleanup_jobs').doc(jobId(fileID)).set({
    data: { _openid: openid, kind: 'image', fileID, state: 'pending', updatedAt: new Date() }
  })
}

async function claimImage(tx, openid, fileID, previous, target) {
  if (!fileID || fileID === previous) return
  if (typeof fileID !== 'string' || fileID.length > 1024) throw new Error('图片无效')
  const match = fileID.match(/^cloud:\/\/[^/]+\/(?:wardrobe|avatars|stickers)\/([a-f0-9]{32})\.(jpg|jpeg|png|webp|gif)$/)
  if (!match) throw new Error('请重新上传图片')
  const ref = tx.collection('upload_tickets').doc(match[1])
  const ticket = await readDoc(ref)
  const scannedItem = ticket && ticket.target === 'itemScan' && ticket.fileID === fileID && target.startsWith('clothes/')
  if (!ticket || ticket._openid !== openid || !fileID.endsWith('/' + ticket.cloudPath) ||
      (ticket.target && !scannedItem) || ticket.cancelled) throw new Error('图片不属于当前账号或已使用')
  await ref.update({ data: { fileID, target } })
}

const FIELDS = {
  clothes: ['name', 'category', 'subcategory', 'size', 'color', 'brand', 'purchaseDate', 'note', 'imageFileID'],
  outfits: ['name', 'occasion', 'note', 'imageFileID'],
  expenses: ['category', 'date', 'note', 'itemId'],
  wear_records: ['date', 'note', 'outfitId'],
  outfit_plans: ['date', 'note', 'outfitId'],
  stickers: ['name', 'brand', 'series', 'channel', 'themeTag', 'purchasedAt', 'status', 'doneAt', 'imageFileID', 'doneImageFileID']
}

const COLLECTIONS = Object.keys(FIELDS)

const EXPENSE_CATEGORIES = ['服饰', '鞋包', '洗护', '修改', '其他']
// 造景贴纸：心愿单 / 库存 / 已拼贴；done 的完成字段（doneAt、doneImageFileID）由后续流转动作开放
const STICKER_STATUS = ['wishlist', 'owned', 'done']
const STICKER_THEME_TAGS = ['古风造景', '街景造景', '自然造景', '室内造景', '美食造景', '节日造景', '其他']
const MAX_YEAR = 2030
const WEAR_DUPLICATE = '同一天已记录相同衣物组合'
const WEAR_RESCAN = 'WEAR_RESCAN'
const WEAR_SCAN_PAGE_SIZE = 100

function validDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value &&
    Number(value.slice(0, 4)) >= 2022 && Number(value.slice(0, 4)) <= MAX_YEAR
}

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

const wardrobeMetaId = openid => crypto.createHash('sha256').update('wardrobe:' + openid).digest('hex')
// ponytail: 借现有元数据集合存组合占位；若版本文档成为写入热点，再迁移到独立集合。
const wearKey = (openid, date, itemIds) => 'wear-key-' + crypto.createHash('sha256')
  .update(JSON.stringify([openid, date, [...new Set(itemIds)].sort()])).digest('hex')

async function hasSameWearRecord(db, openid, date, itemIds, excludedId) {
  const key = wearKey(openid, date, itemIds)
  for (let offset = 0; ; offset += WEAR_SCAN_PAGE_SIZE) {
    const res = await db.collection('wear_records').where({ _openid: openid, date })
      .orderBy('createdAt', 'desc').orderBy('_id', 'desc').skip(offset).limit(WEAR_SCAN_PAGE_SIZE).get()
    if (res.data.some(row => row._id !== excludedId && Array.isArray(row.itemIds) &&
      wearKey(openid, row.date, row.itemIds) === key)) return true
    if (res.data.length < WEAR_SCAN_PAGE_SIZE) return false
  }
}

async function releaseWearKey(tx, key, recordId) {
  const ref = tx.collection('wardrobe_meta').doc(key)
  const marker = await readDoc(ref)
  if (marker && marker.recordId === recordId) await ref.remove()
}

function cleanItemIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some(id => typeof id !== 'string' || !id || id.length > 100)) throw new Error('请选择 1 至 100 件衣物')
  return [...new Set(value)]
}

function cleanData(collection, input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效')
  const data = {}
  for (const key of FIELDS[collection]) {
    const value = input[key] === undefined ? '' : input[key]
    if (typeof value !== 'string' || value.length > (key === 'note' ? 2000 : key.endsWith('FileID') ? 1024 : 100)) throw new Error('字段格式或长度无效')
    data[key] = value.trim()
  }
  if (collection === 'clothes') {
    if (!data.name) throw new Error('名称不能为空')
    if (!CATEGORIES.includes(data.category)) throw new Error('类别无效')
    if (data.category === '配饰' && !ACCESSORY_TYPES.includes(data.subcategory)) throw new Error('配饰类型无效')
    if (data.category !== '配饰') data.subcategory = ''
    if (!Array.isArray(input.seasons) || input.seasons.some(s => !['春秋', '夏', '冬'].includes(s))) throw new Error('季节无效')
    data.seasons = [...new Set(input.seasons)]
    if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0 || input.price > 1e9) throw new Error('价格无效')
    data.price = Math.round(input.price * 100) / 100
    if (data.purchaseDate && !validDateString(data.purchaseDate)) throw new Error('购买日期无效')
  } else if (collection === 'outfits') {
    if (!data.name) throw new Error('名称不能为空')
    data.itemIds = cleanItemIds(input.itemIds)
  } else if (collection === 'expenses') {
    if (!EXPENSE_CATEGORIES.includes(data.category)) throw new Error('账本分类无效')
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1e9) throw new Error('金额无效')
    data.amount = Math.round(input.amount * 100) / 100
    if (!validDateString(data.date)) throw new Error('日期无效')
  } else if (collection === 'wear_records') {
    if (!validDateString(data.date)) throw new Error('日期无效')
    if (data.date > shanghaiToday()) throw new Error('不能记录未来日期')
    data.itemIds = cleanItemIds(input.itemIds)
  } else if (collection === 'stickers') {
    if (!data.name) throw new Error('名称不能为空')
    if (!data.imageFileID) throw new Error('请上传封面图')
    if (!STICKER_STATUS.includes(data.status)) throw new Error('状态无效')
    if (data.themeTag && !STICKER_THEME_TAGS.includes(data.themeTag)) throw new Error('主题标签无效')
    if (data.purchasedAt && !validDateString(data.purchasedAt)) throw new Error('购入日期无效')
    if (data.purchasedAt && data.purchasedAt > shanghaiToday()) throw new Error('购入日期不能是未来')
    if (data.doneAt && (!validDateString(data.doneAt) || data.doneAt > shanghaiToday())) throw new Error('完成日期无效')
    if (input.price === undefined || input.price === null || input.price === '') data.price = null
    else if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0 || input.price > 1e9) throw new Error('价格无效')
    else data.price = Math.round(input.price * 100) / 100
    if (input.quantity === undefined || input.quantity === null || input.quantity === '') data.quantity = 1
    else if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 9999) throw new Error('数量无效')
    else data.quantity = input.quantity
    // 状态机：建档只允许心愿单/库存；编辑按 SPEC 3.1 流转表裁决
    const from = previous && previous.status
    if (!previous) {
      // 建档只允许心愿单或库存；已拼贴须经标记完成流转
      if (data.status === 'done') throw new Error('状态无效')
      if (data.doneAt || data.doneImageFileID) throw new Error('建档时不支持完成字段')
    } else if (from === data.status) {
      // 普通编辑：已拼贴态必须保留完成字段，其余状态不允许携带
      if (data.status === 'done') {
        if (!data.doneAt || !data.doneImageFileID) throw new Error('已拼贴需保留完成日期与作品照')
      } else if (data.doneAt || data.doneImageFileID) throw new Error('非已拼贴状态不支持完成字段')
    } else if (from === 'wishlist' && data.status === 'owned') {
      // 心愿转正与直接建档库存同规则：价格和购入日期可留空
      if (data.doneAt || data.doneImageFileID) throw new Error('非已拼贴状态不支持完成字段')
    } else if (from === 'owned' && data.status === 'done') {
      // 标记已拼贴：完成日期与作品照缺一不可（作品照归属由调用方票据校验）
      if (!data.doneAt || !data.doneImageFileID) throw new Error('标记已拼贴需同时提供完成日期与作品照')
    } else if (from === 'done' && data.status === 'owned') {
      // 撤销完成：完成字段清空，被清作品照由调用方入清理队列
      if (data.doneAt || data.doneImageFileID) throw new Error('撤销完成请勿携带完成字段')
    } else {
      // owned → wishlist 已购不回退心愿；wishlist → done 须先转正
      throw new Error(data.status === 'wishlist' ? '已购物品不能回退为心愿单' : '请先转为库存再标记拼贴完成')
    }
  } else {
    if (!validDateString(data.date)) throw new Error('日期无效')
    if (!data.outfitId) throw new Error('请选择穿搭')
  }
  return data
}

async function activeUser(tx, user, openid) {
  const current = await readDoc(tx.collection('users').doc(user._id))
  if (!current || current.openid !== openid || current.autoLoginEnabled === false) throw new Error('登录状态已失效')
}

// 衣物或穿着记录每次增删改递增版本号，驱动衣橱画像缓存（ai_cache）失效重建。
async function bumpWardrobeVersion(tx, openid, expectedVersion) {
  const ref = tx.collection('wardrobe_meta').doc(wardrobeMetaId(openid))
  const current = await readDoc(ref)
  const version = current && current.version || 0
  if (expectedVersion !== undefined && version !== expectedVersion) throw new Error(WEAR_RESCAN)
  await ref.set({ data: { _openid: openid, version: version + 1, updatedAt: new Date() } })
}

async function saveAvatar({ db, user, openid, avatarFileID }) {
  await db.runTransaction(async tx => {
    await activeUser(tx, user, openid)
    const current = await readDoc(tx.collection('users').doc(user._id))
    await claimImage(tx, openid, avatarFileID, current.avatarFileID, 'users/' + user._id)
    await tx.collection('users').doc(user._id).update({ data: { avatarFileID } })
    if (current.avatarFileID !== avatarFileID) await queueImage(tx, openid, current.avatarFileID)
  })
}

async function retryCleanup({ db, cloud, openid }) {
  const jobs = await db.collection('cleanup_jobs').where({ _openid: openid, state: 'pending' }).limit(5).get()
  let failed = 0
  for (const job of jobs.data) {
    try {
      if (job.kind === 'references') {
        // ponytail: 按 20 条清理，保留空穿搭供用户补选或删除。
        const affected = await db.collection('outfits').where({ _openid: openid, itemIds: db.command.all([job.itemId]) }).limit(20).get()
        for (const outfit of affected.data) {
          await db.collection('outfits').doc(outfit._id).update({ data: { itemIds: db.command.pull(job.itemId) } })
        }
        const remaining = await db.collection('outfits').where({ _openid: openid, itemIds: db.command.all([job.itemId]) }).limit(1).get()
        if (remaining.data.length) continue
      } else if (job.kind === 'plans') {
        // 删除穿搭后清理其日历计划，每轮最多 20 条，未完成时保留任务。
        const affected = await db.collection('outfit_plans').where({ _openid: openid, outfitId: job.outfitId }).limit(20).get()
        for (const plan of affected.data) {
          await db.collection('outfit_plans').doc(plan._id).remove()
        }
        const remaining = await db.collection('outfit_plans').where({ _openid: openid, outfitId: job.outfitId }).limit(1).get()
        if (remaining.data.length) continue
      } else {
        const match = job.fileID.match(/\/([a-f0-9]{32})\.[a-z]+$/)
        const ticket = match && await readDoc(db.collection('upload_tickets').doc(match[1]))
        if (!ticket || ticket._openid !== openid || ticket.fileID !== job.fileID) {
          // 旧客户端可写任意 fileID；缺少服务端归属证明时不能用管理员权限删除。
          await db.collection('cleanup_jobs').doc(job._id).update({ data: { state: 'review', lastError: '旧图片需管理员核验归属后清理', updatedAt: new Date() } })
          continue
        }
        for (const [collection, field] of [['clothes', 'imageFileID'], ['outfits', 'imageFileID'], ['users', 'avatarFileID'], ['stickers', 'imageFileID'], ['stickers', 'doneImageFileID']]) {
          const refs = await db.collection(collection).where({ [field]: job.fileID }).limit(1).get()
          if (refs.data.length) throw new Error('图片仍被记录引用，已保留')
        }
        const res = await cloud.deleteFile({ fileList: [job.fileID] })
        if (!res.fileList || res.fileList.length !== 1 || res.fileList[0].status !== 0) throw new Error('云存储未确认删除成功')
      }
      await db.collection('cleanup_jobs').doc(job._id).remove()
    } catch (e) {
      failed++
      await db.collection('cleanup_jobs').doc(job._id).update({ data: { lastError: e.message, updatedAt: new Date() } })
    }
  }
  const remaining = await db.collection('cleanup_jobs').where({ _openid: openid, state: 'pending' }).limit(1).get()
  const review = await db.collection('cleanup_jobs').where({ _openid: openid, state: 'review' }).limit(1).get()
  return { success: true, pendingCleanup: remaining.data.length > 0, cleanupFailed: failed > 0 || remaining.data.length > 0 || review.data.length > 0, reviewRequired: review.data.length > 0 }
}

async function handle(context) {
  const { db, cloud, user, openid, event } = context
  if (event.action === 'prepareUpload') {
    if (!['wardrobe', 'avatars', 'stickers'].includes(event.directory) || !['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(event.ext)) throw new Error('图片格式无效')
    const id = crypto.randomBytes(16).toString('hex')
    const cloudPath = `${event.directory}/${id}.${event.ext}`
    await db.collection('upload_tickets').doc(id).set({ data: { _openid: openid, cloudPath, createdAt: new Date() } })
    return { success: true, cloudPath }
  }
  if (event.action === 'retryCleanup') return retryCleanup(context)
  if (event.action === 'removeImage') {
    const fileID = event.fileID
    if (typeof fileID !== 'string' || fileID.length > 1024) throw new Error('图片无效')
    await db.runTransaction(async tx => {
      const queued = await readDoc(tx.collection('cleanup_jobs').doc(jobId(fileID)))
      if (queued && queued._openid === openid) return
      const match = fileID.match(/^cloud:\/\/[^/]+\/(?:wardrobe|avatars|stickers)\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp|gif)$/)
      const ticket = match && await readDoc(tx.collection('upload_tickets').doc(match[1]))
      if (!ticket || ticket._openid !== openid || !fileID.endsWith('/' + ticket.cloudPath)) throw new Error('无权删除此图片')
      // 已提交图片的删除必须由替换或删除记录创建清理任务，防止响应丢失后的错误回滚。
      if (ticket.target && ticket.target !== 'itemScan') return
      await tx.collection('upload_tickets').doc(match[1]).update({ data: { cancelled: true, fileID } })
      await queueImage(tx, openid, fileID)
    })
    return retryCleanup(context)
  }

  const { collection, operation, id } = event
  if (!COLLECTIONS.includes(collection)) throw new Error('集合无效')
  // stickers 全操作已开放（ST-01 读取建档、ST-02 编辑流转、ST-03 删除清理）
  if (operation === 'list') {
    if (!Number.isInteger(event.offset) || event.offset < 0) throw new Error('分页参数无效')
    const where = { _openid: openid }
    if (collection === 'stickers' && event.status !== undefined) {
      if (!STICKER_STATUS.includes(event.status)) throw new Error('状态无效')
      where.status = event.status
    }
    const res = await db.collection(collection).where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc').skip(event.offset).limit(20).get()
    return { success: true, data: res.data }
  }
  if (!['get', 'add', 'update', 'delete'].includes(operation) && !(collection === 'wear_records' && operation === 'linkOutfit')) throw new Error('操作无效')
  if (operation !== 'add' && (typeof id !== 'string' || !id || id.length > 100)) throw new Error('记录 ID 无效')
  if (operation === 'get') {
    const record = await readDoc(db.collection(collection).doc(id))
    if (!record || record._openid !== openid) throw new Error('记录不存在或无权访问')
    return { success: true, data: record }
  }
  if (operation === 'linkOutfit') {
    const outfitId = event.outfitId
    if (typeof outfitId !== 'string' || !outfitId || outfitId.length > 100) throw new Error('穿搭 ID 无效')
    for (let attempt = 0; ; attempt++) {
      try {
        await db.runTransaction(async tx => {
          await activeUser(tx, user, openid)
          const wear = await readDoc(tx.collection('wear_records').doc(id))
          const outfit = await readDoc(tx.collection('outfits').doc(outfitId))
          if (!wear || wear._openid !== openid) throw new Error('穿着记录不存在或无权访问')
          if (!outfit || outfit._openid !== openid) throw new Error('穿搭不存在或无权访问')
          const wearIds = Array.isArray(wear.itemIds) ? [...new Set(wear.itemIds)].sort() : []
          const outfitIds = Array.isArray(outfit.itemIds) ? [...new Set(outfit.itemIds)].sort() : []
          if (!wearIds.length || wearIds.length !== outfitIds.length || wearIds.some((itemId, index) => itemId !== outfitIds[index])) {
            throw new Error('穿搭衣物与实穿记录不一致，请刷新后重试')
          }
          if (wear.outfitId === outfitId) return
          await tx.collection('wear_records').doc(id).update({ data: { outfitId } })
          await bumpWardrobeVersion(tx, openid)
        })
        return { success: true, _id: id }
      } catch (error) {
        const message = String(error.code || error.errCode || '') + ' ' + String(error.message || error.errMsg || '')
        const retryable = /DATABASE_TRANSACTION_CONFLICT|DATABASE_DUPLICATE_WRITE|E11000/.test(message)
        if (retryable && attempt < 2) continue
        if (retryable) throw new Error('穿着记录正在更新，请重试')
        throw error
      }
    }
  }
  const targetId = operation === 'add' ? crypto.randomBytes(16).toString('hex') : id
  const wearData = collection === 'wear_records' && operation !== 'delete' ? cleanData(collection, event.data) : null
  const nextWearKey = wearData && wearKey(openid, wearData.date, wearData.itemIds)
  for (let attempt = 0; ; attempt++) {
    // 兼容只支持按 ID 读取的事务。先扫描旧记录，再用版本和确定性占位封住扫描到提交之间的竞态。
    const scannedVersion = wearData
      ? (await readDoc(db.collection('wardrobe_meta').doc(wardrobeMetaId(openid))))?.version || 0
      : undefined
    const duplicate = wearData && await hasSameWearRecord(db, openid, wearData.date, wearData.itemIds, targetId)
    try {
      await db.runTransaction(async tx => {
        await activeUser(tx, user, openid)
        const ref = tx.collection(collection).doc(targetId)
        const previous = operation === 'add' ? null : await readDoc(ref)
        if (operation !== 'add' && (!previous || previous._openid !== openid)) throw new Error('记录不存在或无权访问')
        if (operation === 'delete') {
          await ref.remove()
          await queueImage(tx, openid, previous.imageFileID)
          // 贴纸：作品照随删除一并入清理队列（空值由 queueImage 跳过）
          if (collection === 'stickers') await queueImage(tx, openid, previous.doneImageFileID)
          if (collection === 'clothes') {
            await tx.collection('cleanup_jobs').doc('refs-' + targetId).set({ data: { _openid: openid, kind: 'references', itemId: targetId, state: 'pending' } })
            await bumpWardrobeVersion(tx, openid)
          }
          if (collection === 'wear_records') {
            await bumpWardrobeVersion(tx, openid)
            await releaseWearKey(tx, wearKey(openid, previous.date, previous.itemIds || []), targetId)
          }
          if (collection === 'outfits') {
            await tx.collection('cleanup_jobs').doc('plans-' + targetId).set({ data: { _openid: openid, kind: 'plans', outfitId: targetId, state: 'pending' } })
          }
          return
        }
        const data = wearData || cleanData(collection, event.data, previous)
        const previousWearKey = collection === 'wear_records' && previous
          ? wearKey(openid, previous.date, previous.itemIds || []) : null
        const changedWearKey = nextWearKey && nextWearKey !== previousWearKey
        if (changedWearKey && duplicate) throw new Error(WEAR_DUPLICATE)
        if (collection === 'outfits' || collection === 'wear_records') {
          for (const itemId of data.itemIds) {
            const item = await readDoc(tx.collection('clothes').doc(itemId))
            if (!item || item._openid !== openid) throw new Error('所选衣物已删除或无权访问，请重新加载')
          }
        }
        if (collection === 'expenses' && data.itemId) {
          const item = await readDoc(tx.collection('clothes').doc(data.itemId))
          if (!item || item._openid !== openid) throw new Error('关联衣物已删除或无权访问')
        }
        if ((collection === 'wear_records' || collection === 'outfit_plans') && data.outfitId) {
          const outfit = await readDoc(tx.collection('outfits').doc(data.outfitId))
          if (!outfit || outfit._openid !== openid) throw new Error('所选穿搭已删除或无权访问')
        }
        await claimImage(tx, openid, data.imageFileID, previous && previous.imageFileID, collection + '/' + targetId)
        // 贴纸作品照与封面图同规则：换图认领新票据、旧图入清理队列（撤销完成时清空亦触发入队）
        if (collection === 'stickers') {
          await claimImage(tx, openid, data.doneImageFileID, previous && previous.doneImageFileID, collection + '/' + targetId + '/done')
        }
        if (previous) await ref.update({ data: collection === 'stickers' ? { ...data, updatedAt: db.serverDate() } : data })
        else await ref.set({ data: { ...data, _openid: openid, createdAt: db.serverDate() } })
        if (collection === 'clothes' || collection === 'wear_records') {
          await bumpWardrobeVersion(tx, openid, changedWearKey ? scannedVersion : undefined)
        }
        if (changedWearKey) {
          const marker = await readDoc(tx.collection('wardrobe_meta').doc(nextWearKey))
          if (marker && marker.recordId !== targetId) throw new Error(WEAR_DUPLICATE)
          if (!marker) await tx.collection('wardrobe_meta').add({
            data: { _id: nextWearKey, _openid: openid, recordId: targetId, date: data.date }
          })
          if (previousWearKey) await releaseWearKey(tx, previousWearKey, targetId)
        }
        if (previous && previous.imageFileID !== data.imageFileID) await queueImage(tx, openid, previous.imageFileID)
        if (collection === 'stickers' && previous && previous.doneImageFileID !== data.doneImageFileID) await queueImage(tx, openid, previous.doneImageFileID)
      })
      break
    } catch (error) {
      const message = String(error.code || error.errCode || '') + ' ' + String(error.message || error.errMsg || '')
      const retryable = message.includes(WEAR_RESCAN) || /DATABASE_TRANSACTION_CONFLICT|DATABASE_DUPLICATE_WRITE|E11000/.test(message)
      if (wearData && retryable && attempt < 2) continue
      if (wearData && retryable) throw new Error('穿着记录正在更新，请重试')
      throw error
    }
  }
  // 提交后的清理失败必须返回已提交状态，不能让客户端把保存当作失败。
  let cleanupFailed = false
  try { cleanupFailed = (await retryCleanup(context)).cleanupFailed } catch (e) { cleanupFailed = true; console.error(e) }
  return { success: true, _id: targetId, cleanupFailed }
}

module.exports = { handle, saveAvatar, readDoc }
