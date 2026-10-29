const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./support/page')
const { WIDTH, HEIGHT, createCrop, clampCrop, zoomCrop, rotateCrop } = require('../utils/image-crop')

function covers(crop) {
  const sideways = crop.rotation % 180 !== 0
  const width = (sideways ? crop.height : crop.width) * crop.scale
  const height = (sideways ? crop.width : crop.height) * crop.scale
  assert.ok(crop.x - width / 2 <= 1e-8)
  assert.ok(crop.x + width / 2 >= WIDTH - 1e-8)
  assert.ok(crop.y - height / 2 <= 1e-8)
  assert.ok(crop.y + height / 2 >= HEIGHT - 1e-8)
}

test('横图、竖图和四个旋转方向均覆盖3:4显示范围，拖动缩放不露空白', () => {
  for (const [width, height] of [[4000, 1000], [1000, 4000], [600, 800], [1, 1]]) {
    let crop = createCrop(width, height)
    for (let turn = 0; turn < 4; turn++) {
      assert.equal(crop.rotation, turn * 90)
      covers(crop)
      for (const factor of [0.001, 1.2, 1000]) {
        const next = zoomCrop(crop, factor)
        covers(clampCrop({ ...next, x: -1e9, y: 1e9 }))
        covers(clampCrop({ ...next, x: 1e9, y: -1e9 }))
      }
      crop = rotateCrop(crop)
    }
    assert.equal(crop.rotation, 0)
  }
  for (const size of [0, -1, Infinity, NaN]) assert.throws(() => createCrop(size, 800), /尺寸无效/)
})

test('双指缩放围绕手势中心，同时平移，缩放上限后不会继续漂移', () => {
  const crop = zoomCrop(createCrop(1000, 1000), 2)
  const from = { x: 400, y: 500 }, to = { x: 450, y: 550 }
  const next = zoomCrop(crop, 1.1, from, to)
  assert.ok(Math.abs((next.x - to.x) / next.scale - (crop.x - from.x) / crop.scale) < 1e-8)
  assert.ok(Math.abs((next.y - to.y) / next.scale - (crop.y - from.y) / crop.scale) < 1e-8)
  const maximum = zoomCrop(crop, 1000)
  assert.deepEqual(zoomCrop(maximum, 2), maximum)
})

function setup({ cloudError = false, decodeError = false, exportError = false } = {}) {
  const emitted = [], calls = [], handlers = {}, transforms = []
  let back = 0
  const ctx = Object.fromEntries(['clearRect', 'save', 'translate', 'rotate', 'scale', 'drawImage', 'restore']
    .map(name => [name, (...args) => transforms.push([name, ...args])]))
  const canvas = { getContext: () => ctx, createImage: () => {
    const image = { width: 1200, height: 800 }
    Object.defineProperty(image, 'src', { set(value) { calls.push(['decode', value]); queueMicrotask(() => decodeError ? image.onerror() : image.onload()) } })
    return image
  } }
  const page = loadPage('image-edit', {}, {
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 700 }),
    cloud: { downloadFile: async options => { calls.push(['download', options.fileID]); if (cloudError) throw { errMsg: 'permission denied' }; return { tempFilePath: '/download.jpg' } } },
    canvasToTempFilePath: options => {
      calls.push(['export', options]); exportError ? options.fail({ errMsg: 'export failed' }) : options.success({ tempFilePath: '/crop.jpg' })
    }, navigateBack: () => { back++ }
  })
  page.getOpenerEventChannel = () => ({ on: (name, callback) => { handlers[name] = callback }, emit: (...args) => emitted.push(args) })
  page.createSelectorQuery = () => ({ select() { return this }, fields() { return this },
    exec(callback) { callback([{ node: canvas, left: 20, top: 100, width: 300, height: 400 }]) } })
  page.onLoad()
  handlers.imageSource({ path: 'cloud://existing' })
  return { page, canvas, emitted, calls, transforms, back: () => back }
}

test('已有云图片下载解码后进入小程序内画布，导出与预览共用旋转和位置', async () => {
  const { page, canvas, emitted, calls, transforms, back } = setup()
  page.onReady()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.ready, true)
  assert.deepEqual(calls.slice(0, 2), [['download', 'cloud://existing'], ['decode', '/download.jpg']])
  page.onZoomIn(); page.onRotate()
  page.onTouchStart({ touches: [{ clientX: 150, clientY: 250 }] })
  page.onTouchMove({ touches: [{ clientX: 170, clientY: 280 }] })
  covers(page._crop)
  assert.deepEqual(transforms.filter(row => row[0] === 'rotate').at(-1), ['rotate', Math.PI / 2])
  await page.onConfirm()
  const exported = calls.find(row => row[0] === 'export')[1]
  assert.equal(exported.canvas, canvas)
  assert.equal(exported.destWidth / exported.destHeight, 3 / 4)
  assert.equal(exported.width, WIDTH)
  assert.equal(exported.height, HEIGHT)
  assert.equal(exported.fileType, 'jpg')
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [['imageEdited', { path: '/crop.jpg' }]])
  assert.equal(back(), 1)
  page.onUnload()
  assert.equal(emitted.length, 1)
})

test('云图片下载和解码失败显示具体阶段，失败、返回和取消均不确认图片', async () => {
  for (const options of [{ cloudError: true }, { decodeError: true }]) {
    const { page, emitted, calls } = setup(options)
    page.onReady(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(page.data.ready, false)
    assert.match(page.data.loadError, options.cloudError ? /云端照片读取失败.*permission denied/ : /无法解码/)
    await page.onConfirm()
    assert.equal(calls.some(row => row[0] === 'export'), false)
    page.onCancel(); page.onUnload()
    assert.deepEqual(emitted, [['imageEditCancelled']])
  }
})

test('导出失败允许重试，加载期间退出后旧回调不改写，重置恢复初始裁剪', async () => {
  const { page, emitted } = setup({ exportError: true })
  page.onReady(); await new Promise(resolve => setImmediate(resolve))
  page.onZoomIn(); page.onRotate(); page.onReset()
  assert.deepEqual(page._crop, createCrop(1200, 800))
  await page.onConfirm()
  assert.equal(page.data.exporting, false)
  assert.deepEqual(emitted, [])
  const leaving = setup()
  leaving.page.onReady(); leaving.page.onUnload()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(leaving.page.data.ready, false)
  assert.deepEqual(leaving.emitted, [['imageEditCancelled']])
})
