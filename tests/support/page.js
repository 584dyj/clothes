const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createRequire } = require('node:module')

function loadPage(name, db = {}, wx = {}, auth = {}) {
  db = { getWardrobeVersion: () => 0, listStickers: async () => [], ...db }
  const file = path.resolve(__dirname, `../../pages/${name}/${name}.js`)
  const localRequire = createRequire(file)
  let page, app
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8'),
    { App(value) { app = value }, require: createRequire(path.resolve(__dirname, '../../app.js')) })
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(value) { page = value }, getApp: () => app,
    require: name => name === '../../utils/db' ? db : name === '../../utils/auth' ? { ensureLogin: async () => true, ...auth } : localRequire(name),
    wx: { showToast() {}, showLoading() {}, hideLoading() {}, setNavigationBarTitle() {}, getStorageSync() {}, setStorageSync() {}, navigateBack() {}, pageScrollTo() {}, ...wx },
    // 默认无上一页（触发 switchTab 兜底分支）；需要页面栈的用例经 wx.getCurrentPages 覆盖
    getCurrentPages: wx.getCurrentPages || (() => [{}]),
    console: { error() {} },
    setTimeout: wx.testSetTimeout || (name === 'today-wear' ? fn => fn() : () => {}),
    clearTimeout: wx.testClearTimeout || (() => {}), Date
  }, { filename: file })
  page.data = structuredClone(page.data)
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = page.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
    if (callback) callback()
  }
  return page
}

function loadComponent(name, db = {}, wx = {}, auth = {}) {
  const file = path.resolve(__dirname, `../../components/${name}/${name}.js`)
  const localRequire = createRequire(file)
  let definition, app
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8'),
    { App(value) { app = value }, require: createRequire(path.resolve(__dirname, '../../app.js')) })
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Component(value) { definition = value }, getApp: () => app,
    require: name => name === '../../utils/db' ? db : name === '../../utils/auth' ? { ensureLogin: async () => true, ...auth } : localRequire(name),
    wx: { showToast() {}, navigateBack() {}, ...wx },
    console: { error() {} }, setTimeout: wx.testSetTimeout || (() => {}), clearTimeout: wx.testClearTimeout || (() => {}), Date
  }, { filename: file })
  const component = { ...definition.methods, ...definition.lifetimes }
  component.data = structuredClone(definition.data)
  component.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = component.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
  }
  return component
}

module.exports = { loadPage, loadComponent }
