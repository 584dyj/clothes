const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const { validDate, today } = require('../../utils/date')
const datePicker = require('../../utils/date-picker')

const STATUS_OPTIONS = [
  { value: 'owned', label: '库存' },
  { value: 'wishlist', label: '心愿单' }
]
const THEME_TAGS = ['古风造景', '街景造景', '自然造景', '室内造景', '美食造景', '节日造景', '其他']
const INPUT_FIELDS = new Set(['name', 'brand', 'series', 'price', 'quantity', 'channel'])

Page({
  ...swipeBack,
  ...datePicker,

  data: {
    id: '',
    name: '',
    brand: '',
    series: '',
    price: '',
    quantity: '1',
    purchasedAt: '',
    channel: '',
    themeTag: '',
    status: 'owned',
    doneAt: '',
    doneImageFileID: '',
    imagePath: '',
    imageFileID: '',
    statusOptions: STATUS_OPTIONS,
    themeTags: THEME_TAGS,
    saving: false,
    ready: false,
    loading: true,
    loadError: '',
    picker: { show: false, title: '', columns: [], values: [], target: '' },
    // 状态动作：标记完成弹层与动作 busy 态（删除/撤销/确认完成共用）
    doneSheet: { show: false, doneAt: '', imagePath: '' },
    acting: false
  },

  async onLoad(options) {
    this._options = options
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    if (options.id) {
      this.setData({ id: options.id })
      wx.setNavigationBarTitle({ title: '编辑贴纸' })
      return this.loadSticker(options.id)
    }
    this.setData({ ready: true, loading: false, loadError: '' })
  },

  onRetry() { return this.onLoad(this._options || {}) },

  async loadSticker(id) {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const rows = await db.listStickers()
      const sticker = rows.find(row => row._id === id)
      if (!sticker) throw new Error('贴纸不存在')
      this.setData({
        ready: true,
        loading: false,
        loadError: '',
        name: sticker.name || '',
        brand: sticker.brand || '',
        series: sticker.series || '',
        price: sticker.price == null ? '' : String(sticker.price),
        quantity: String(sticker.quantity || 1),
        purchasedAt: sticker.purchasedAt || '',
        channel: sticker.channel || '',
        themeTag: THEME_TAGS.includes(sticker.themeTag) ? sticker.themeTag : '',
        status: sticker.status || 'owned',
        doneAt: sticker.doneAt || '',
        doneImageFileID: sticker.doneImageFileID || '',
        imageFileID: sticker.imageFileID || ''
      })
    } catch (e) {
      console.error(e)
      this.setData({ ready: false, loading: false, loadError: '贴纸加载失败，请重试' })
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    if (INPUT_FIELDS.has(field)) this.setData({ [field]: e.detail.value })
  },

  onStatusTap(e) {
    if (this.data.id) return
    const status = e.currentTarget.dataset.value
    if (STATUS_OPTIONS.some(option => option.value === status)) this.setData({ status })
  },

  onThemeTap(e) {
    const value = e.currentTarget.dataset.value
    if (THEME_TAGS.includes(value)) this.setData({ themeTag: this.data.themeTag === value ? '' : value })
  },

  async onChooseImage() {
    if (this.data.saving) return
    try {
      this.setData({ imagePath: await db.chooseImage() })
    } catch (e) {
      // 用户取消选择
    }
  },

  // 已拼贴作品照点击全屏预览（与衣物照片一致的原生预览）
  onPreviewDoneImage() {
    if (this.data.doneImageFileID) wx.previewImage({ urls: [this.data.doneImageFileID] })
  },

  openDatePicker() {
    if (this.data.saving) return
    this.setData({ picker: {
      show: true,
      target: 'date',
      title: '购入日期',
      ...this.buildDateColumns(this.data.purchasedAt, today())
    } })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const values = e.detail.values
    const value = `${picker.columns[0][values[0]]}-${picker.columns[1][values[1]]}-${picker.columns[2][values[2]]}`
    if (picker.field === 'doneAt') this.setData({ 'doneSheet.doneAt': value, 'picker.show': false })
    else this.setData({ purchasedAt: value, 'picker.show': false })
  },

  onPickerCancel() { this.setData({ 'picker.show': false }) },
  onClearDate() { if (!this.data.saving) this.setData({ purchasedAt: '' }) },

  noop() {},

  scheduleReturn() {
    setTimeout(() => wx.navigateBack(), 500)
  },

  // 完整表单载荷：服务端 update 需要整表数据，客户端永远提交全字段
  buildRecord(status, imageFileID) {
    const current = this.data
    return {
      name: current.name.trim(),
      brand: current.brand.trim(),
      series: current.series.trim(),
      price: current.price === '' ? null : Number(current.price),
      quantity: current.quantity === '' ? 1 : Number(current.quantity),
      purchasedAt: current.purchasedAt,
      channel: current.channel.trim(),
      themeTag: current.themeTag,
      status,
      doneAt: current.doneAt,
      imageFileID,
      doneImageFileID: current.doneImageFileID
    }
  },

  async onSave(e, forcedStatus) {
    const current = this.data
    if (current.saving || !current.ready) return
    const name = current.name.trim()
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    if (!current.imagePath && !current.imageFileID) {
      wx.showToast({ title: '请上传封面图', icon: 'none' })
      return
    }
    const price = current.price === '' ? null : Number(current.price)
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1e9)) {
      wx.showToast({ title: '请输入有效单价', icon: 'none' })
      return
    }
    const quantity = current.quantity === '' ? 1 : Number(current.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      wx.showToast({ title: '请输入 1 至 9999 的整数数量', icon: 'none' })
      return
    }
    if (current.purchasedAt && (!validDate(current.purchasedAt) || current.purchasedAt > today())) {
      wx.showToast({ title: '请选择有效购入日期', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    let uploadedFileID = ''
    let committed = false
    try {
      let imageFileID = current.imageFileID
      if (current.imagePath) {
        uploadedFileID = await db.uploadStickerImage(current.imagePath)
        imageFileID = uploadedFileID
      }
      const data = this.buildRecord(forcedStatus || current.status, imageFileID)
      const result = current.id
        ? await db.updateSticker(current.id, data)
        : await db.addSticker(data)
      committed = true
      wx.hideLoading()
      wx.showToast({ title: result && result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
      this.scheduleReturn()
    } catch (e) {
      console.error(e)
      if (uploadedFileID && !committed) db.removeImage(uploadedFileID)
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },

  // 心愿单 → 库存：复用保存管线，单价与购入日期同新增库存一样可选
  onConvert() {
    return this.onSave(null, 'owned')
  },

  // ---------- 标记已拼贴弹层 ----------

  onOpenDoneSheet() {
    if (this.data.acting || !this.data.ready) return
    this.setData({ doneSheet: { show: true, doneAt: today(), imagePath: '' } })
  },

  onDoneSheetCancel() {
    if (this.data.acting) return
    this.setData({ 'doneSheet.show': false })
  },

  async onChooseDoneImage() {
    if (this.data.acting) return
    try {
      this.setData({ 'doneSheet.imagePath': await db.chooseImage() })
    } catch (e) {
      // 用户取消选择
    }
  },

  openDoneDatePicker() {
    if (this.data.acting) return
    this.setData({ picker: {
      show: true,
      target: 'date',
      field: 'doneAt',
      title: '完成日期',
      ...this.buildDateColumns(this.data.doneSheet.doneAt, today())
    } })
  },

  async onConfirmDone() {
    const current = this.data
    if (current.acting || !current.ready) return
    const { doneAt, imagePath } = current.doneSheet
    if (!imagePath) {
      wx.showToast({ title: '请上传作品照', icon: 'none' })
      return
    }
    if (!validDate(doneAt) || doneAt > today()) {
      wx.showToast({ title: '请选择有效完成日期', icon: 'none' })
      return
    }
    this.setData({ acting: true })
    wx.showLoading({ title: '提交中…' })
    const uploaded = []
    let committed = false
    try {
      let imageFileID = current.imageFileID
      if (current.imagePath) {
        const coverID = await db.uploadStickerImage(current.imagePath)
        uploaded.push(coverID)
        imageFileID = coverID
      }
      const doneImageFileID = await db.uploadStickerImage(imagePath)
      uploaded.push(doneImageFileID)
      const data = { ...this.buildRecord('done', imageFileID), doneAt, doneImageFileID }
      await db.updateSticker(current.id, data)
      committed = true
      wx.hideLoading()
      wx.showToast({ title: '已标记为已拼贴', icon: 'none' })
      this.scheduleReturn()
    } catch (e) {
      console.error(e)
      // 失败保留弹层与已选内容；已上传未提交的图片走补偿清理
      if (!committed) for (const fileID of uploaded) db.removeImage(fileID)
      wx.hideLoading()
      this.setData({ acting: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // ---------- 撤销完成与删除 ----------

  onRevertDone() {
    if (this.data.acting || !this.data.ready) return
    wx.showModal({
      title: '撤销完成',
      content: '撤销后将清除完成日期与作品照（作品照会被清理）',
      confirmText: '撤销',
      success: async res => {
        if (!res.confirm) return
        this.setData({ acting: true })
        wx.showLoading({ title: '提交中…' })
        const uploaded = []
        let committed = false
        try {
          const current = this.data
          let imageFileID = current.imageFileID
          if (current.imagePath) {
            const coverID = await db.uploadStickerImage(current.imagePath)
            uploaded.push(coverID)
            imageFileID = coverID
          }
          const data = { ...this.buildRecord('owned', imageFileID), doneAt: '', doneImageFileID: '' }
          await db.updateSticker(current.id, data)
          committed = true
          wx.hideLoading()
          wx.showToast({ title: '已撤销完成', icon: 'none' })
          this.scheduleReturn()
        } catch (e) {
          console.error(e)
          if (!committed) for (const fileID of uploaded) db.removeImage(fileID)
          wx.hideLoading()
          this.setData({ acting: false })
          wx.showToast({ title: '操作失败，请重试', icon: 'none' })
        }
      }
    })
  },

  onDelete() {
    if (this.data.acting || !this.data.ready) return
    wx.showModal({
      title: '删除贴纸',
      content: '删除后不可恢复，封面图与作品照将一并清理',
      confirmText: '删除',
      success: async res => {
        if (!res.confirm) return
        this.setData({ acting: true })
        wx.showLoading({ title: '删除中…' })
        try {
          await db.deleteSticker(this.data.id)
          wx.hideLoading()
          wx.showToast({ title: '已删除', icon: 'none' })
          this.scheduleReturn()
        } catch (e) {
          console.error(e)
          wx.hideLoading()
          this.setData({ acting: false })
          wx.showToast({ title: '删除失败，请重试', icon: 'none' })
        }
      }
    })
  }
})
