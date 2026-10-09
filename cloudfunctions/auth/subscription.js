const crypto = require('crypto')

const COLLECTION = 'subscriptions'
const SCENE = 'idle-monthly'
const QUOTA_SCENE = 'idle-monthly-quota'
const MAX_UNUSED = 12

const quotaId = openid => 'quota-' + crypto.createHash('sha256').update(openid).digest('hex')

async function readDoc(ref) {
  try {
    const res = await ref.get()
    return Array.isArray(res.data) ? res.data[0] || null : res.data || null
  } catch (error) {
    if (/document.*(not exist|not found)|文档不存在/i.test(error.message || error.errMsg || '')) return null
    throw error
  }
}

async function subscribe({ db, openid }) {
  const createdAt = db.serverDate()
  const recordId = 'report-' + crypto.randomBytes(16).toString('hex')
  return db.runTransaction(async tx => {
    const quotaRef = tx.collection(COLLECTION).doc(quotaId(openid))
    const quota = await readDoc(quotaRef)
    const unused = quota && Number.isInteger(quota.unused) ? quota.unused : 0
    if (unused >= MAX_UNUSED) throw new Error('月报额度已充足，无需重复开启')
    const quotaData = { _openid: openid, scene: QUOTA_SCENE, unused: unused + 1, updatedAt: createdAt }
    if (quota) await quotaRef.update({ data: quotaData })
    else await quotaRef.set({ data: { ...quotaData, createdAt } })
    await tx.collection(COLLECTION).doc(recordId).set({ data: { _openid: openid, scene: SCENE, createdAt } })
    return { success: true, remaining: MAX_UNUSED - unused - 1 }
  })
}

module.exports = { subscribe, quotaId, SCENE, QUOTA_SCENE, MAX_UNUSED }
