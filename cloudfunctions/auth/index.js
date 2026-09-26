/**
 * 云函数：auth，登录 / 注册 / 身份校验 / 账号资料 / 退出登录
 *
 * 一次性注册码池：invite_codes 集合，每个码一条记录，注册成功即作废。
 * 注册码只能由管理员在云开发控制台手动添加（集合权限"所有用户不可读写"），
 * 小程序内不提供生成入口。手动添加的记录格式见 README。
 *
 * 原理：小程序无法获取用户微信号，用 openid（每个微信用户在当前小程序内的唯一标识）作为白名单。
 *  - check：openid 是否已绑定账号 → 自动登录
 *  - login：账号+密码登录，成功后把当前 openid 绑定到该账号（下次免登录）
 *  - register：注册码 + 账号 + 密码 注册，绑定 openid
 *  - profile / updateProfile：读取账号资料和保存头像
 *  - logout：保留 openid 绑定并暂停自动登录
 *
 * 密码安全：scrypt 加盐哈希存储，前端永远拿不到明文；users 集合权限必须设为"所有用户不可读写"，
 * 所有读写都经本云函数（admin 权限）。认证失败次数记录在 auth_attempts 集合。
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
// 标识实际运行的源码，便于核对部署内容，避免仅凭包版本判断。
const revision = crypto.createHash('sha256')
  .update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, 'data.js')))
  .update(fs.readFileSync(path.join(__dirname, 'recommend.js')))
  .update(fs.readFileSync(path.join(__dirname, 'chat.js')))
  .update(fs.readFileSync(path.join(__dirname, 'ai-http.js')))
  .digest('hex').slice(0, 12)

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const dataApi = require('./data')
const recommendation = require('./recommend')
const chatApi = require('./chat')
const { readDoc } = dataApi
const USERS = 'users'
const CODES = 'invite_codes'
const ATTEMPTS = 'auth_attempts'
const MAX_FAILED_ATTEMPTS = 5
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const h = Buffer.from(hashPassword(password, salt), 'hex')
    const e = Buffer.from(expectedHash, 'hex')
    return h.length === e.length && crypto.timingSafeEqual(h, e)
  } catch (e) {
    return false
  }
}

function attemptKey(action, openid) {
  return crypto.createHash('sha256').update(`${action}:${openid}`).digest('hex')
}

async function getAttempt(action, openid) {
  const key = attemptKey(action, openid)
  const res = await db.collection(ATTEMPTS).where({ key }).limit(1).get()
  return { key, record: res.data[0] || null }
}

async function checkRateLimit(action, openid) {
  const { record } = await getAttempt(action, openid)
  if (!record || !record.lockedUntil) return null
  const remaining = new Date(record.lockedUntil).getTime() - Date.now()
  if (remaining <= 0) return null
  return `尝试次数过多，请 ${Math.ceil(remaining / 60000)} 分钟后再试`
}

async function recordFailure(action, openid) {
  const { key, record } = await getAttempt(action, openid)
  await db.runTransaction(async tx => {
    const ref = tx.collection(ATTEMPTS).doc(record ? record._id : key)
    const current = await readDoc(ref)
    const now = Date.now()
    const previous = current && new Date(current.updatedAt).getTime()
    const failures = current && now - previous < ATTEMPT_WINDOW_MS ? current.failures + 1 : 1
    await ref.set({ data: {
      key, action, failures,
      lockedUntil: failures >= MAX_FAILED_ATTEMPTS ? new Date(now + ATTEMPT_WINDOW_MS) : null,
      updatedAt: new Date(now)
    } })
  })
}

async function clearFailures(action, openid) {
  const { record } = await getAttempt(action, openid)
  if (record) await db.collection(ATTEMPTS).doc(record._id).remove()
}

function duplicateDataError(e) {
  const message = String((e && (e.errMsg || e.message)) || e || '')
  return /duplicate|E11000|唯一索引/i.test(message)
}

async function getBoundUser(openid) {
  const res = await db.collection(USERS).where({ openid }).limit(2).get()
  if (res.data.length > 1) {
    console.error('检测到重复 OpenID 绑定', openid)
    throw new Error('账号绑定数据异常，请联系管理员')
  }
  return res.data[0] || null
}

async function main(event = {}) {
  const { action } = event
  const openid = cloud.getWXContext().OPENID
  if (!openid) {
    return { success: false, error: '无法获取用户身份' }
  }

  // ---------- 校验当前微信是否已绑定账号 ----------
  if (action === 'check') {
    try {
      const user = await getBoundUser(openid)
      const loggedIn = !!user && user.autoLoginEnabled !== false
      return {
        success: true,
        loggedIn,
        username: loggedIn ? user.username : ''
      }
    } catch (e) {
      console.error('check 失败', e)
      return { success: false, error: '身份校验失败，请稍后重试' }
    }
  }

  // ---------- 账号密码登录（成功后绑定当前 openid） ----------
  if (action === 'login') {
    const username = typeof event.username === 'string' ? event.username.trim() : ''
    const password = typeof event.password === 'string' ? event.password : ''
    if (!username || username.length > 20 || !password) {
      return { success: false, error: '请输入账号和密码' }
    }
    if (password.length > 128) {
      return { success: false, error: '账号或密码错误' }
    }
    const limited = await checkRateLimit('login', openid)
    if (limited) return { success: false, error: limited }

    const res = await db.collection(USERS).where({ username }).limit(2).get()
    if (!res.data.length) {
      await recordFailure('login', openid)
      return { success: false, error: '账号或密码错误' }
    }
    if (res.data.length > 1) {
      console.error('检测到重复用户名', username)
      return { success: false, error: '账号数据异常，请联系管理员' }
    }
    const u = res.data[0]
    if (!verifyPassword(password, u.salt, u.passwordHash)) {
      await recordFailure('login', openid)
      return { success: false, error: '账号或密码错误' }
    }
    // 审核账号同样固定绑定微信，禁止接管已有账号或在微信之间移动绑定。
    const currentBinding = await getBoundUser(openid)
    if (currentBinding && currentBinding._id !== u._id) {
      return { success: false, error: '当前微信已绑定其他账号' }
    }
    try {
      await db.runTransaction(async tx => {
        const ref = tx.collection(USERS).doc(u._id)
        const current = await readDoc(ref)
        if (!current || (current.openid && current.openid !== openid)) {
          throw new Error('该账号已绑定其他微信，请用本人微信登录')
        }
        await ref.update({ data: { openid, autoLoginEnabled: true } })
      })
    } catch (e) {
      if (duplicateDataError(e)) return { success: false, error: '当前微信已绑定其他账号' }
      throw e
    }
    await clearFailures('login', openid)
    return { success: true, username: u.username }
  }

  // ---------- 一次性注册码注册（注册即绑定 openid，自动登录） ----------
  if (action === 'register') {
    const username = typeof event.username === 'string' ? event.username.trim() : ''
    const password = typeof event.password === 'string' ? event.password : ''
    const registerCode = typeof event.registerCode === 'string' ? event.registerCode.trim() : ''
    if (!username || !password || !registerCode || registerCode.length > 100) {
      return { success: false, error: '请填写完整信息' }
    }
    // 先做不消耗注册码的校验，避免无效尝试把码用掉
    if (username.length < 2 || username.length > 20) {
      return { success: false, error: '账号长度需 2-20 个字符' }
    }
    if (password.length < 6) {
      return { success: false, error: '密码至少 6 位' }
    }
    if (password.length > 128) {
      return { success: false, error: '密码不能超过 128 位' }
    }
    const limited = await checkRateLimit('register', openid)
    if (limited) return { success: false, error: limited }

    const bound = await db.collection(USERS).where({ openid }).limit(1).get()
    if (bound.data.length) {
      return { success: false, error: '当前微信已注册账号' }
    }
    const exist = await db.collection(USERS).where({ username }).limit(1).get()
    if (exist.data.length) {
      return { success: false, error: '该账号已被注册' }
    }

    const codeRecords = await db.collection(CODES).where({ code: registerCode }).limit(2).get()
    if (codeRecords.data.length !== 1) {
      await recordFailure('register', openid)
      return { success: false, error: '注册码错误或配置异常' }
    }

    const salt = crypto.randomBytes(16).toString('hex')
    const passwordHash = hashPassword(password, salt)
    try {
      await db.runTransaction(async tx => {
        const codeRef = tx.collection(CODES).doc(codeRecords.data[0]._id)
        const code = await readDoc(codeRef)
        if (!code || code.used !== false) throw new Error('注册码错误或已被使用')
        await codeRef.update({ data: { used: true, usedBy: username, usedAt: db.serverDate() } })
        await tx.collection(USERS).add({ data: {
          username, passwordHash, salt, openid, autoLoginEnabled: true,
          registerCode, createdAt: db.serverDate()
        } })
      })
    } catch (e) {
      await recordFailure('register', openid)
      if (duplicateDataError(e)) return { success: false, error: '账号或微信绑定信息已存在，请重新登录' }
      throw e
    }
    await clearFailures('register', openid)
    return { success: true, username }
  }

  if (['data', 'prepareUpload', 'removeImage', 'retryCleanup', 'cleanupStatus'].includes(action)) {
    const user = await getBoundUser(openid)
    if (!user || user.autoLoginEnabled === false) throw new Error('登录状态已失效')
    return dataApi.handle({ db, cloud, user, openid, event })
  }

  if (action === 'recommend') {
    const user = await getBoundUser(openid)
    if (!user || user.autoLoginEnabled === false) throw new Error('登录状态已失效')
    return recommendation.handle({ db, openid, user, event })
  }

  if (action === 'chatList' || action === 'chatGet' || action === 'chatSend' || action === 'chatDelete' || action === 'chatRename' ||
      action === 'chatStart' || action === 'chatFinish' || action === 'chatCancel') {
    const user = await getBoundUser(openid)
    if (!user || user.autoLoginEnabled === false) throw new Error('登录状态已失效')
    return chatApi.handle({ db, cloud, openid, user, event })
  }

  // ---------- 当前账号资料 ----------
  if (action === 'profile') {
    try {
      const user = await getBoundUser(openid)
      if (!user || user.autoLoginEnabled === false) {
        return { success: false, error: '登录状态已失效' }
      }

      let registerCode = user.registerCode || ''
      // 兼容升级前创建的账号，从已使用注册码记录中补取。
      if (!registerCode) {
        const codes = await db.collection(CODES).where({ usedBy: user.username, used: true }).limit(1).get()
        registerCode = codes.data.length ? codes.data[0].code : ''
      }
      let pendingCleanup = false
      try {
        const jobs = await db.collection('cleanup_jobs').where({ _openid: openid, state: 'pending' }).limit(1).get()
        pendingCleanup = jobs.data.length > 0
      } catch (e) {
        console.error('读取清理状态失败', e)
      }
      return {
        success: true,
        profile: {
          pendingCleanup,
          username: user.username,
          registerCode,
          avatarFileID: user.avatarFileID || ''
        }
      }
    } catch (e) {
      console.error('读取账号资料失败', e)
      return { success: false, error: e.message || '账号资料加载失败' }
    }
  }

  // ---------- 保存头像 ----------
  if (action === 'updateProfile') {
    const avatarFileID = typeof event.avatarFileID === 'string' ? event.avatarFileID : ''
    if (!avatarFileID || !avatarFileID.startsWith('cloud://') || avatarFileID.length > 1024) {
      return { success: false, error: '头像文件无效' }
    }
    try {
      const user = await getBoundUser(openid)
      if (!user || user.autoLoginEnabled === false) {
        return { success: false, error: '登录状态已失效' }
      }
      await dataApi.saveAvatar({ db, user, openid, avatarFileID })
      return { success: true, avatarFileID }
    } catch (e) {
      console.error('保存头像失败', e)
      return { success: false, error: e.message || '头像保存失败' }
    }
  }

  // ---------- 退出登录，保留账号绑定并暂停自动登录 ----------
  if (action === 'logout') {
    try {
      const user = await getBoundUser(openid)
      if (user) {
        await db.collection(USERS).doc(user._id).update({
          data: { autoLoginEnabled: false }
        })
      }
      return { success: true }
    } catch (e) {
      console.error('退出登录失败', e)
      return { success: false, error: e.message || '退出登录失败' }
    }
  }

  return { success: false, error: '未知操作', code: 'UNKNOWN_ACTION' }
}

exports.main = async event => {
  const context = cloud.getWXContext()
  const diagnostic = { revision, action: event && typeof event.action === 'string' ? event.action : null, env: context.ENV || null }
  try {
    const result = await main(event)
    if (result.code === 'UNKNOWN_ACTION') console.error('auth 未匹配操作', diagnostic)
    return { ...result, diagnostic }
  } catch (e) {
    console.error('auth 操作失败', e)
    return { success: false, error: e.message || '服务暂不可用，请重试', diagnostic }
  }
}
