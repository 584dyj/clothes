const crypto = require('crypto')

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
  const match = fileID.match(/^cloud:\/\/[^/]+\/(?:wardrobe|avatars)\/([a-f0-9]{32})\.(jpg|jpeg|png|webp|gif)$/)
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
  outfit_plans: ['date', 'note', 'outfitId']
}

const COLLECTIONS = Object.keys(FIELDS)

const EXPENSE_CATEGORIES = ['服饰', '鞋包', '洗护', '修改', '其他']
const MAX_YEAR = 2030

function validDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value &&
    Number(value.slice(0, 4)) >= 2022 && Number(value.slice(0, 4)) <= MAX_YEAR
}

function cleanItemIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some(id => typeof id !== 'string' || !id || id.length > 100)) throw new Error('请选择 1 至 100 件衣物')
  return [...new Set(value)]
}

function cleanData(collection, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效')
  const data = {}
  for (const key of FIELDS[collection]) {
    const value = input[key] === undefined ? '' : input[key]
    if (typeof value !== 'string' || value.length > (key === 'note' ? 2000 : key === 'imageFileID' ? 1024 : 100)) throw new Error('字段格式或长度无效')
    data[key] = value.trim()
  }
  if (collection === 'clothes') {
    if (!data.name) throw new Error('名称不能为空')
    if (!['上衣', '下装', '连衣裙', '配饰', '挂件', '包', '鞋'].includes(data.category)) throw new Error('类别无效')
    if (data.category === '配饰' && !['袜子', '帽子', '围巾', '首饰', '其他'].includes(data.subcategory)) throw new Error('配饰类型无效')
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
    data.itemIds = cleanItemIds(input.itemIds)
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
async function bumpWardrobeVersion(tx, openid) {
  const id = crypto.createHash('sha256').update('wardrobe:' + openid).digest('hex')
  const ref = tx.collection('wardrobe_meta').doc(id)
  const current = await readDoc(ref)
  await ref.set({ data: { _openid: openid, version: (current && current.version || 0) + 1, updatedAt: new Date() } })
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
        for (const [collection, field] of [['clothes', 'imageFileID'], ['outfits', 'imageFileID'], ['users', 'avatarFileID']]) {
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
  if (event.action === 'cleanupStatus') {
    const jobs = await db.collection('cleanup_jobs').where({ _openid: openid, state: 'pending' }).limit(1).get()
    return { success: true, pendingCleanup: jobs.data.length > 0 }
  }
  if (event.action === 'prepareUpload') {
    if (!['wardrobe', 'avatars'].includes(event.directory) || !['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(event.ext)) throw new Error('图片格式无效')
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
      const match = fileID.match(/^cloud:\/\/[^/]+\/(?:wardrobe|avatars)\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp|gif)$/)
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
  if (operation === 'list') {
    if (!Number.isInteger(event.offset) || event.offset < 0) throw new Error('分页参数无效')
    const res = await db.collection(collection).where({ _openid: openid }).orderBy('createdAt', 'desc').orderBy('_id', 'desc').skip(event.offset).limit(20).get()
    return { success: true, data: res.data }
  }
  if (!['get', 'add', 'update', 'delete'].includes(operation)) throw new Error('操作无效')
  if (operation !== 'add' && (typeof id !== 'string' || !id || id.length > 100)) throw new Error('记录 ID 无效')
  if (operation === 'get') {
    const record = await readDoc(db.collection(collection).doc(id))
    if (!record || record._openid !== openid) throw new Error('记录不存在或无权访问')
    return { success: true, data: record }
  }
  const targetId = operation === 'add' ? crypto.randomBytes(16).toString('hex') : id
  await db.runTransaction(async tx => {
    await activeUser(tx, user, openid)
    const ref = tx.collection(collection).doc(targetId)
    const previous = operation === 'add' ? null : await readDoc(ref)
    if (operation !== 'add' && (!previous || previous._openid !== openid)) throw new Error('记录不存在或无权访问')
    if (operation === 'delete') {
      await ref.remove()
      await queueImage(tx, openid, previous.imageFileID)
      if (collection === 'clothes') {
        await tx.collection('cleanup_jobs').doc('refs-' + targetId).set({ data: { _openid: openid, kind: 'references', itemId: targetId, state: 'pending' } })
        await bumpWardrobeVersion(tx, openid)
      }
      if (collection === 'wear_records') await bumpWardrobeVersion(tx, openid)
      if (collection === 'outfits') {
        await tx.collection('cleanup_jobs').doc('plans-' + targetId).set({ data: { _openid: openid, kind: 'plans', outfitId: targetId, state: 'pending' } })
      }
      return
    }
    const data = cleanData(collection, event.data)
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
    if (previous) await ref.update({ data })
    else await ref.set({ data: { ...data, _openid: openid, createdAt: db.serverDate() } })
    if (collection === 'clothes' || collection === 'wear_records') await bumpWardrobeVersion(tx, openid)
    if (previous && previous.imageFileID !== data.imageFileID) await queueImage(tx, openid, previous.imageFileID)
  })
  // 提交后的清理失败必须返回已提交状态，不能让客户端把保存当作失败。
  let cleanupFailed = false
  try { cleanupFailed = (await retryCleanup(context)).cleanupFailed } catch (e) { cleanupFailed = true; console.error(e) }
  return { success: true, _id: targetId, cleanupFailed }
}

module.exports = { handle, saveAvatar, readDoc }
