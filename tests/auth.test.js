const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { loadCloud } = require('./support/cloud')
function loadAuth(records, openid = 'openid-1') {
  const cloud = loadCloud(records)
  cloud.setOpenid(openid)
  return cloud.main
}

test('未知操作返回实际操作和源码标识，清理操作正常命中', async () => {
  const main = loadAuth({ users: [{ _id: 'user', openid: 'openid-1' }] })
  const unknown = await main({ action: 'invalid-action' })
  assert.equal(unknown.code, 'UNKNOWN_ACTION')
  assert.equal(unknown.diagnostic.action, 'invalid-action')
  assert.match(unknown.diagnostic.revision, /^[a-f0-9]{12}$/)
  const status = await main({ action: 'cleanupStatus' })
  assert.equal(status.success, true)
  assert.equal(status.diagnostic.revision, unknown.diagnostic.revision)
  assert.equal(status.diagnostic.action, 'cleanupStatus')
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
    avatarFileID: 'cloud://avatar-1'
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
