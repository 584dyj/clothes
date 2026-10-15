const createWearPage = require('../wear-edit/wear-page')

Page(createWearPage({
  db: require('../../utils/db'),
  auth: require('../../utils/auth'),
  app: getApp(),
  wx
}))
