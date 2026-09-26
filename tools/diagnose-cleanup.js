// 将本文件完整粘贴到微信开发者工具的小程序 Console 执行。
// 仅查询状态，不执行清理，不输出个人资料。
;(async () => {
  for (const action of ['profile', 'cleanupStatus']) {
    try {
      const response = await wx.cloud.callFunction({ name: 'auth', data: { action } })
      const result = response.result || {}
      console.log('清理诊断', JSON.stringify({
        action, requestID: response.requestID, success: result.success,
        error: result.error, diagnostic: result.diagnostic || null,
        pendingCleanup: action === 'profile' ? result.profile && result.profile.pendingCleanup : result.pendingCleanup
      }))
    } catch (error) {
      console.error('清理诊断', action, error.errMsg || error.message)
    }
  }
})()
