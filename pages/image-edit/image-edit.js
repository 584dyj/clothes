const { WIDTH, HEIGHT, createCrop, clampCrop, zoomCrop, rotateCrop } = require('../../utils/image-crop')

Page({
  data: { frameWidth: 240, frameHeight: 320, ready: false, exporting: false, loadError: '' },

  onLoad() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const width = Math.floor(Math.max(120, Math.min(info.windowWidth - 48, (info.windowHeight - 230) * 3 / 4)))
    this.setData({ frameWidth: width, frameHeight: width * 4 / 3 })
    this._channel = this.getOpenerEventChannel()
    this._channel.on('imageSource', ({ path }) => {
      this._source = path
      if (this._canvas) this.loadImage()
    })
  },

  onReady() { this.initCanvas() },

  initCanvas() {
    this.createSelectorQuery().select('#cropCanvas').fields({ node: true, size: true, rect: true }).exec(rows => {
      if (this._unloaded) return
      if (!rows[0]?.node) { this.setData({ loadError: '裁剪画布初始化失败，请重新加载' }); return }
      this._canvas = rows[0].node
      this._bounds = rows[0]
      this._canvas.width = WIDTH; this._canvas.height = HEIGHT
      this._context = this._canvas.getContext('2d')
      if (this._source) this.loadImage()
    })
  },

  async loadImage() {
    const version = this._loadVersion = (this._loadVersion || 0) + 1
    const current = () => !this._unloaded && this._loadVersion === version
    this.setData({ ready: false, loadError: '' })
    try {
      let path = this._source
      if (typeof path !== 'string' || !path) throw new Error('未收到待编辑照片，请返回重试')
      if (path.startsWith('cloud://')) {
        try { path = (await wx.cloud.downloadFile({ fileID: path })).tempFilePath }
        catch (error) { throw new Error(`云端照片读取失败：${error.errMsg || error.message || '请检查网络后重试'}`) }
      }
      if (!current()) return
      const image = this._canvas.createImage()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error('照片无法解码，请返回更换照片'))
        image.src = path
      })
      if (!current()) return
      this._crop = createCrop(image.width, image.height)
      this._image = image
      this.draw()
      this.setData({ ready: true })
    } catch (error) {
      console.error('衣物照片裁剪加载失败', error)
      if (current()) this.setData({ loadError: error.message || error.errMsg || '照片读取失败，请重试' })
    }
  },

  onRetry() { if (this._canvas) return this.loadImage(); this.initCanvas() },

  draw() {
    const ctx = this._context, crop = this._crop
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    ctx.save()
    ctx.translate(crop.x, crop.y)
    ctx.rotate(crop.rotation * Math.PI / 180)
    ctx.scale(crop.scale, crop.scale)
    ctx.drawImage(this._image, -crop.width / 2, -crop.height / 2, crop.width, crop.height)
    ctx.restore()
  },

  points(e) {
    const box = this._bounds
    return Array.from(e.touches).slice(0, 2).map(touch => ({ x: (touch.clientX - box.left) * WIDTH / box.width,
      y: (touch.clientY - box.top) * HEIGHT / box.height }))
  },

  onTouchStart(e) { if (this.data.ready && !this.data.exporting) this._touches = this.points(e) },
  onTouchEnd(e) { if (this.data.ready) this._touches = this.points(e) },
  onTouchMove(e) {
    if (!this.data.ready || this.data.exporting) return
    const next = this.points(e), before = this._touches || []
    this._touches = next
    if (!next.length || next.length !== before.length) return
    if (next.length === 1) {
      this._crop = clampCrop({ ...this._crop, x: this._crop.x + next[0].x - before[0].x, y: this._crop.y + next[0].y - before[0].y })
    } else {
      const midpoint = points => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 })
      const distance = points => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
      this._crop = zoomCrop(this._crop, distance(next) / (distance(before) || 1), midpoint(before), midpoint(next))
    }
    this.draw()
  },

  zoom(factor) { if (this.data.ready && !this.data.exporting) { this._crop = zoomCrop(this._crop, factor); this.draw() } },
  onZoomIn() { this.zoom(1.2) },
  onZoomOut() { this.zoom(1 / 1.2) },
  onRotate() { if (this.data.ready && !this.data.exporting) { this._crop = rotateCrop(this._crop); this.draw() } },
  onReset() { if (this.data.ready && !this.data.exporting) { this._crop = createCrop(this._image.width, this._image.height); this.draw() } },

  async onConfirm() {
    if (!this.data.ready || this.data.exporting) return
    this.setData({ exporting: true })
    try {
      const result = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas: this._canvas,
        x: 0, y: 0, width: WIDTH, height: HEIGHT, destWidth: WIDTH, destHeight: HEIGHT,
        fileType: 'jpg', quality: 0.92, success: resolve, fail: reject }))
      if (this._unloaded) return
      if (!result.tempFilePath) throw new Error('未生成裁剪照片，请重试')
      this._channel.emit('imageEdited', { path: result.tempFilePath })
      this._completed = true
      wx.navigateBack()
    } catch (error) {
      if (!this._unloaded) wx.showToast({ title: error.errMsg || error.message || '裁剪保存失败，请重试', icon: 'none' })
    } finally { if (!this._unloaded) this.setData({ exporting: false }) }
  },

  onCancel() { if (!this.data.exporting) wx.navigateBack() },
  onUnload() {
    this._unloaded = true
    if (!this._completed) this._channel?.emit('imageEditCancelled')
  }
})
