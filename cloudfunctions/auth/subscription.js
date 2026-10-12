const crypto = require('crypto')

const COLLECTION = 'subscriptions'
const MAX_UNUSED = 12

// 订阅场景：月报为存量默认场景，其记录 _id 规则保持不变以兼容线上数据。
const SCENES = {
  'idle-monthly': {
    recordPrefix: 'report',
    quotaScene: 'idle-monthly-quota',
    quotaId: openid => 'quota-' + crypto.createHash('sha256').update(openid).digest('hex'),
    fullError: '月报额度已充足，无需重复开启'
  },
  'weather-alert': {
    recordPrefix: 'walert',
    quotaScene: 'weather-alert-quota',
    quotaId: openid => 'quota-weather-alert-' + crypto.createHash('sha256').update(openid).digest('hex'),
    fullError: '提醒额度已充足，无需重复开启'
  }
}

async function readDoc(ref) {
  try {
    const res = await ref.get()
    return Array.isArray(res.data) ? res.data[0] || null : res.data || null
  } catch (error) {
    if (/document.*(not exist|not found)|文档不存在/i.test(error.message || error.errMsg || '')) return null
    throw error
  }
}

async function subscribe({ db, openid, scene = 'idle-monthly' }) {
  const config = SCENES[scene]
  if (!config) throw new Error('订阅场景无效')
  const createdAt = db.serverDate()
  const recordId = config.recordPrefix + '-' + crypto.randomBytes(16).toString('hex')
  return db.runTransaction(async tx => {
    const quotaRef = tx.collection(COLLECTION).doc(config.quotaId(openid))
    const quota = await readDoc(quotaRef)
    const unused = quota && Number.isInteger(quota.unused) ? quota.unused : 0
    if (unused >= MAX_UNUSED) throw new Error(config.fullError)
    const quotaData = { _openid: openid, scene: config.quotaScene, unused: unused + 1, updatedAt: createdAt }
    if (quota) await quotaRef.update({ data: quotaData })
    else await quotaRef.set({ data: { ...quotaData, createdAt } })
    await tx.collection(COLLECTION).doc(recordId).set({ data: { _openid: openid, scene, createdAt } })
    return { success: true, remaining: MAX_UNUSED - unused - 1 }
  })
}

module.exports = { subscribe, quotaId: SCENES['idle-monthly'].quotaId, SCENES,
  SCENE: 'idle-monthly', QUOTA_SCENE: 'idle-monthly-quota', MAX_UNUSED }
