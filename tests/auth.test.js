const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { loadCloud } = require('./support/cloud')
const { SCENES } = require('../cloudfunctions/auth/subscription')
const quota = (openid, scene, unused) => ({ _id: SCENES[scene].quotaId(openid), _openid: openid, scene: SCENES[scene].quotaScene, unused })
function loadAuth(records, openid = 'openid-1') {
  const cloud = loadCloud(records)
  cloud.setOpenid(openid)
  return cloud.main
}

test('未知操作返回实际操作和源码标识，资料操作正常命中', async () => {
  const main = loadAuth({ users: [{ _id: 'user', openid: 'openid-1' }] })
  const unknown = await main({ action: 'invalid-action' })
  assert.equal(unknown.code, 'UNKNOWN_ACTION')
  assert.equal(unknown.diagnostic.action, 'invalid-action')
  assert.match(unknown.diagnostic.revision, /^[a-f0-9]{12}$/)
  const status = await main({ action: 'profile' })
  assert.equal(status.success, true)
  assert.equal(status.diagnostic.revision, unknown.diagnostic.revision)
  assert.equal(status.diagnostic.action, 'profile')
})

test('profile 返回头像、用户名和新账号保存的注册码', async () => {
  const records = {
    users: [{
      _id: 'user-1',
      openid: 'openid-1',
      username: 'alice',
      registerCode: 'CODE-1',
      avatarFileID: 'cloud://avatar-1'
    }],
    invite_codes: []
  }
  const main = loadAuth(records)

  const result = await main({ action: 'profile' })

  assert.equal(result.success, true)
  assert.deepEqual({ ...result.profile }, {
    pendingCleanup: false,
    username: 'alice',
    registerCode: 'CODE-1',
    avatarFileID: 'cloud://avatar-1',
    cityName: ''
  })
})

test('profile 为旧账号从注册码集合补取注册码', async () => {
  const records = {
    users: [{ _id: 'user-1', openid: 'openid-1', username: 'alice' }],
    invite_codes: [{ _id: 'code-1', code: 'LEGACY-1', used: true, usedBy: 'alice' }]
  }
  const main = loadAuth(records)

  const result = await main({ action: 'profile' })

  assert.equal(result.profile.registerCode, 'LEGACY-1')
})

test('logout 保留 OpenID 绑定并暂停自动登录', async () => {
  const records = {
    users: [{ _id: 'user-1', openid: 'openid-1', username: 'alice' }],
    invite_codes: []
  }
  const main = loadAuth(records)

  const logout = await main({ action: 'logout' })
  const check = await main({ action: 'check' })

  assert.equal(logout.success, true)
  assert.equal(records.users[0].openid, 'openid-1')
  assert.equal(records.users[0].autoLoginEnabled, false)
  assert.equal(check.loggedIn, false)
})

test('账号密码登录重新启用自动登录', async () => {
  const salt = '0123456789abcdef0123456789abcdef'
  const passwordHash = crypto.scryptSync('secret1', salt, 64).toString('hex')
  const records = {
    users: [{
      _id: 'user-1',
      openid: 'openid-1',
      autoLoginEnabled: false,
      username: 'alice',
      salt,
      passwordHash
    }],
    invite_codes: [],
    auth_attempts: []
  }
  const main = loadAuth(records)

  const login = await main({ action: 'login', username: 'alice', password: 'secret1' })
  const check = await main({ action: 'check' })

  assert.equal(login.success, true)
  assert.equal(records.users[0].autoLoginEnabled, true)
  assert.equal(check.loggedIn, true)
})

test('updateProfile 只接受云存储文件 ID', async () => {
  const records = {
    users: [{ _id: 'user-1', openid: 'openid-1', username: 'alice' }],
    invite_codes: []
  }
  const main = loadAuth(records)

  const invalid = await main({ action: 'updateProfile', avatarFileID: '/tmp/avatar.jpg' })
  const ticket = await main({ action: 'prepareUpload', directory: 'avatars', ext: 'jpg' })
  const fileID = 'cloud://test-env/' + ticket.cloudPath
  const valid = await main({ action: 'updateProfile', avatarFileID: fileID })

  assert.equal(invalid.success, false)
  assert.equal(valid.success, true)
  assert.equal(records.users[0].avatarFileID, fileID)
})

test('subscriptionStatus 只读当前登录账号两种额度，忽略客户端身份且保留超过十二次的计数', async () => {
  const cloud = loadCloud({
    users: [{ _id: 'u1', openid: 'openid-1' }, { _id: 'u2', openid: 'openid-2' }],
    subscriptions: [quota('openid-1', 'weather-alert', 13), quota('openid-1', 'idle-monthly', 4),
      quota('openid-2', 'weather-alert', 8), quota('openid-2', 'idle-monthly', 7)]
  })
  const before = structuredClone(cloud.records)
  const own = await cloud.main({ action: 'subscriptionStatus', openid: 'openid-2', _openid: 'openid-2' })
  assert.equal(own.success, true)
  assert.deepEqual([own.weatherUnused, own.reportUnused], [13, 4])
  cloud.setOpenid('openid-2')
  const other = await cloud.main({ action: 'subscriptionStatus', openid: 'openid-1' })
  assert.deepEqual([other.weatherUnused, other.reportUnused], [8, 7])
  assert.deepEqual(cloud.records, before)
  assert.ok(cloud.calls.every(call => ['get', 'doc.get'].includes(call.operation)))
})

test('subscriptionStatus 拒绝未绑定、退出登录和无微信身份的请求，不读取额度', async () => {
  for (const users of [[], [{ _id: 'u1', openid: 'openid-1', autoLoginEnabled: false }]]) {
    const cloud = loadCloud({ users, subscriptions: [quota('openid-1', 'weather-alert', 3)] })
    const result = await cloud.main({ action: 'subscriptionStatus', openid: 'openid-1' })
    assert.equal(result.success, false)
    assert.match(result.error, /登录状态已失效/)
    assert.equal(cloud.calls.filter(call => call.collection === 'subscriptions').length, 0)
  }
  const cloud = loadCloud({ users: [{ _id: 'u1', openid: 'openid-1' }] })
  cloud.setOpenid('')
  const result = await cloud.main({ action: 'subscriptionStatus', openid: 'openid-1' })
  assert.equal(result.success, false)
  assert.match(result.error, /无法获取用户身份/)
})

test('subscriptionStatus 兼容缺文档抛错，缺记录及无效额度安全显示零', async () => {
  const cloud = loadCloud({ users: [{ _id: 'u1', openid: 'openid-1' }] })
  cloud.faults.before = (name, operation, id) => {
    if (name === 'subscriptions' && operation === 'doc.get') throw new Error(`document.get:fail document with _id ${id} does not exist`)
  }
  const missing = await cloud.main({ action: 'subscriptionStatus' })
  assert.equal(missing.success, true)
  assert.deepEqual([missing.weatherUnused, missing.reportUnused], [0, 0])
  cloud.faults.before = null
  for (const unused of [-1, 1.5, '3', NaN, Infinity, undefined]) {
    cloud.records.subscriptions = [quota('openid-1', 'weather-alert', unused), quota('openid-1', 'idle-monthly', unused)]
    const result = await cloud.main({ action: 'subscriptionStatus' })
    assert.equal(result.success, true)
    assert.deepEqual([result.weatherUnused, result.reportUnused], [0, 0])
  }
  cloud.records.subscriptions = [
    { ...quota('openid-1', 'weather-alert', 5), _openid: 'openid-2' },
    { ...quota('openid-1', 'idle-monthly', 6), scene: 'weather-alert-quota' }
  ]
  const invalid = await cloud.main({ action: 'subscriptionStatus' })
  assert.deepEqual([invalid.weatherUnused, invalid.reportUnused], [0, 0])
})

test('subscriptionStatus 的权限或网络读取错误返回失败，不伪装成零额度', async () => {
  for (const message of ['document.get:fail permission denied', 'document.get:fail network timeout']) {
    const cloud = loadCloud({ users: [{ _id: 'u1', openid: 'openid-1' }] })
    cloud.faults.before = (name, operation) => {
      if (name === 'subscriptions' && operation === 'doc.get') throw new Error(message)
    }
    const result = await cloud.main({ action: 'subscriptionStatus' })
    assert.equal(result.success, false)
    assert.equal(result.error, message)
    assert.equal(result.weatherUnused, undefined)
    assert.equal(result.reportUnused, undefined)
  }
})

test('subscriptionStatus 再次查询可见授权新增与后台额度消耗', async () => {
  const cloud = loadCloud({ users: [{ _id: 'u1', openid: 'openid-1' }] })
  const initial = await cloud.main({ action: 'subscriptionStatus' })
  assert.deepEqual([initial.weatherUnused, initial.reportUnused], [0, 0])
  assert.equal((await cloud.main({ action: 'subscribeWeather' })).success, true)
  assert.equal((await cloud.main({ action: 'subscribeReport' })).success, true)
  const subscribed = await cloud.main({ action: 'subscriptionStatus' })
  assert.deepEqual([subscribed.weatherUnused, subscribed.reportUnused], [1, 1])
  await cloud.db.collection('subscriptions').doc(SCENES['weather-alert'].quotaId('openid-1')).update({ data: { unused: 0 } })
  const consumed = await cloud.main({ action: 'subscriptionStatus' })
  assert.deepEqual([consumed.weatherUnused, consumed.reportUnused], [0, 1])
})

test('取消提醒仅清零当前身份的指定场景，重复取消和重新订阅保持隔离', async () => {
  for (const [scene, otherScene, cancelAction, subscribeAction] of [
    ['weather-alert', 'idle-monthly', 'cancelWeather', 'subscribeWeather'],
    ['idle-monthly', 'weather-alert', 'cancelReport', 'subscribeReport']
  ]) {
    const cloud = loadCloud({
      users: [{ _id: 'u1', openid: 'openid-1' }, { _id: 'u2', openid: 'openid-2' }],
      subscriptions: [quota('openid-1', scene, 3), quota('openid-1', otherScene, 4),
        quota('openid-2', scene, 8), quota('openid-2', otherScene, 7),
        { _id: 'old-grant', _openid: 'openid-1', scene, createdAt: new Date('2026-10-01') }]
    })
    const ownQuota = () => cloud.records.subscriptions.find(row => row._id === SCENES[scene].quotaId('openid-1'))
    const untouched = structuredClone(cloud.records.subscriptions.filter(row => row._id !== ownQuota()._id))
    const cancelled = await cloud.main({ action: cancelAction, openid: 'openid-2', _openid: 'openid-2', scene: otherScene })
    assert.equal(cancelled.success, true)
    assert.equal(ownQuota().unused, 0)
    assert.equal(ownQuota().generation, 1)
    assert.deepEqual(cloud.records.subscriptions.filter(row => row._id !== ownQuota()._id), untouched)
    const status = await cloud.main({ action: 'subscriptionStatus' })
    assert.deepEqual([status.weatherUnused, status.reportUnused], scene === 'weather-alert' ? [0, 4] : [4, 0])

    assert.equal((await cloud.main({ action: cancelAction })).success, true)
    assert.equal(ownQuota().unused, 0)
    assert.equal(ownQuota().generation, 2)
    assert.equal((await cloud.main({ action: subscribeAction })).unused, 1)
    const grant = cloud.records.subscriptions.find(row => row.scene === scene && row._id !== 'old-grant')
    assert.equal(grant._openid, 'openid-1')
    assert.equal(grant.generation, 2)
    assert.equal(ownQuota().generation, 2)

    cloud.setOpenid('openid-2')
    assert.equal((await cloud.main({ action: cancelAction, openid: 'openid-1' })).success, true)
    assert.equal(cloud.records.subscriptions.find(row => row._id === SCENES[scene].quotaId('openid-2')).unused, 0)
    assert.equal(cloud.records.subscriptions.find(row => row._id === SCENES[otherScene].quotaId('openid-2')).unused, 7)
    assert.equal(ownQuota().unused, 1)
    assert.equal(ownQuota().generation, 2)
  }
})

test('取消提醒拒绝无效身份，额度读取失败不清零', async () => {
  for (const action of ['cancelWeather', 'cancelReport']) {
    for (const [users, openid, error] of [
      [[], 'openid-1', /登录状态已失效/],
      [[{ _id: 'u1', openid: 'openid-1', autoLoginEnabled: false }], 'openid-1', /登录状态已失效/],
      [[{ _id: 'u1', openid: 'openid-1' }], '', /无法获取用户身份/]
    ]) {
      const cloud = loadCloud({ users, subscriptions: [quota('openid-1', 'weather-alert', 3), quota('openid-1', 'idle-monthly', 4)] })
      cloud.setOpenid(openid)
      const before = structuredClone(cloud.records)
      const result = await cloud.main({ action, openid: 'openid-1', _openid: 'openid-1' })
      assert.equal(result.success, false)
      assert.match(result.error, error)
      assert.deepEqual(cloud.records, before)
      assert.equal(cloud.calls.filter(call => call.collection === 'subscriptions').length, 0)
    }
    const cloud = loadCloud({
      users: [{ _id: 'u1', openid: 'openid-1' }],
      subscriptions: [quota('openid-1', 'weather-alert', 3), quota('openid-1', 'idle-monthly', 4)]
    })
    const before = structuredClone(cloud.records.subscriptions)
    cloud.faults.before = (name, operation) => {
      if (name === 'subscriptions' && operation === 'doc.get') throw new Error('document.get:fail permission denied')
    }
    const result = await cloud.main({ action })
    assert.equal(result.success, false)
    assert.match(result.error, /permission denied/)
    assert.deepEqual(cloud.records.subscriptions, before)
  }
})
