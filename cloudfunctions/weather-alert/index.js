const cloud = require('wx-server-sdk')
const alert = require('./alert')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 两种触发方式：定时触发（无 action）执行每日扫描；客户端调用 setCity 设置城市。
exports.main = async (event = {}) => {
  if (event.action === 'setCity') {
    const openid = cloud.getWXContext().OPENID
    if (!openid) return { success: false, error: '无法获取用户身份' }
    try {
      return await alert.setCity({ db, openid, name: event.cityName })
    } catch (e) {
      console.error('setCity 失败', e)
      return { success: false, error: e.message || '城市设置失败，请重试' }
    }
  }
  return alert.handle({ db, cloud, templateId: process.env.WEATHER_TMPL_ID })
}
