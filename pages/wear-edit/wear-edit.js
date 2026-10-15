const createWearPage = require('./wear-page')

Page(createWearPage({
  db: require('../../utils/db'),
  auth: require('../../utils/auth'),
  app: getApp(),
  wx,
  returnAfterSave: true,
  schedule: setTimeout
}))
