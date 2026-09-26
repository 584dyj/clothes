const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createRequire } = require('node:module')

function loadPage(name, db = {}, wx = {}, auth = {}) {
  const file = path.resolve(__dirname, `../../pages/${name}/${name}.js`)
  const localRequire = createRequire(file)
  let page, app
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8'), { App(value) { app = value } })
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(value) { page = value }, getApp: () => app,
    require: name => name === '../../utils/db' ? db : name === '../../utils/auth' ? { ensureLogin: async () => true, ...auth } : localRequire(name),
    wx: { showToast() {}, showLoading() {}, hideLoading() {}, setNavigationBarTitle() {}, getStorageSync() {}, setStorageSync() {}, navigateBack() {}, ...wx },
    console: { error() {} }, setTimeout: wx.testSetTimeout || (() => {}), clearTimeout: wx.testClearTimeout || (() => {}), Date
  }, { filename: file })
  page.data = structuredClone(page.data)
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = page.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
  }
  return page
}

module.exports = { loadPage }
