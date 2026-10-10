// 将本文件完整粘贴到微信开发者工具的小程序 Console 执行。
// 仅查询状态，不执行清理，不输出个人资料。
;(async () => {
  try {
    const response = await wx.cloud.callFunction({ name: 'auth', data: { action: 'profile' } })
    const result = response.result || {}
    console.log('清理诊断', JSON.stringify({
      action: 'profile', requestID: response.requestID, success: result.success,
      error: result.error, diagnostic: result.diagnostic || null,
      pendingCleanup: result.profile && result.profile.pendingCleanup
    }))
  } catch (error) {
    console.error('清理诊断', error.errMsg || error.message)
  }
})()
