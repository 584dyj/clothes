const cloud = require('wx-server-sdk')
const report = require('./report')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = () => report.handle({
  db,
  cloud,
  templateId: process.env.REPORT_TMPL_ID
})
