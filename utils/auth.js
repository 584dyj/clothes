/**
 * 登录状态管理
 * 身份识别基于 openid（每个微信用户在当前小程序内的唯一标识），
 * 校验/登录/注册全部走云函数 auth，前端不接触密码存储。
 */

let redirecting = false // 正在跳转登录页中，防止多个页面 onShow 并发触发重复 reLaunch

function call(action, data = {}) {
  return wx.cloud.callFunction({ name: 'auth', data: { action, ...data } }).then(res => {
    const r = res.result || {}
    if (!r.success) {
      throw new Error(r.error || '操作失败')
    }
    return r
  })
}

/** 校验当前微信是否已绑定账号（自动登录用） */
async function check() {
  try {
    const r = await call('check')
    if (!r.loggedIn) require('./db').clearCache()
    return r
  } catch (e) {
    return { loggedIn: false, unavailable: true }
  }
}

/** 账号密码登录 */
function login(username, password) {
  return call('login', { username, password }).then(r => {
    require('./db').clearCache()
    return r
  })
}

/** 注册码注册（注册即绑定 openid） */
function register(data) {
  return call('register', data).then(r => {
    require('./db').clearCache()
    return r
  })
}

/** 获取当前账号公开资料 */
function profile() {
  return call('profile').then(r => r.profile)
}

/** 更新当前账号资料 */
function updateProfile(data) {
  return call('updateProfile', data)
}

/** 退出当前会话，保留微信与账号的绑定 */
function logout() {
  return call('logout').then(r => {
    require('./db').clearCache()
    return r
  })
}

/** 页面守卫：已登录返回 true；未登录跳转登录页并返回 false */
async function ensureLogin() {
  const r = await check()
  if (r.unavailable) {
    wx.showToast({ title: '登录状态校验失败', icon: 'none' })
    return false
  }
  if (!r.loggedIn) {
    if (!redirecting) {
      redirecting = true
      const pages = getCurrentPages()
      const cur = pages.length ? pages[pages.length - 1].route : ''
      // 已在登录页则不再重复跳转，避免路由冲突
      if (cur !== 'pages/login/login') {
        wx.reLaunch({
          url: '/pages/login/login',
          complete: () => { redirecting = false }
        })
      } else {
        redirecting = false
      }
    }
    return false
  }
  return true
}

module.exports = { check, login, register, profile, updateProfile, logout, ensureLogin }
