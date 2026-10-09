const db = require('../../utils/db')
const auth = require('../../utils/auth')
const swipeBack = require('../../utils/swipe-back')
const focusPlaceholder = require('../../utils/focus-placeholder')

const { validDate } = require('../../utils/date')
const datePicker = require('../../utils/date-picker')
const app = getApp()

Page({
  ...swipeBack,
  ...focusPlaceholder,
  ...datePicker,

  data: {
    id: '',               // 为空表示新增
    name: '',
    category: '',
    categories: [],
    subcategory: '',      // 配饰二级分类，仅 category 为「配饰」时有值
    accessoryTypes: [],
    subcategoryIndex: -1,
    size: '',
    sizes: [],
    shoeSizes: Array.from({ length: 21 }, (_, index) => String(index + 30)),
    color: '',
    colorOptions: [],   // 常见颜色 + 「其他」
    colorIndex: -1,
    colorCustom: false, // 选了「其他」时显示手动输入框
    brand: '',
    seasons: [],
    selectedSeasons: [],
    seasonStates: [],     // [{value, active}]，WXML 不支持方法调用，选中态在此预计算
    price: '',
    purchaseDate: '',
    note: '',
    imagePath: '',        // 本地临时路径（新选的图）
    imageFileID: '',      // 已上传的云端 fileID
    scanFileID: '',       // 新增页为识别提前上传的图片
    scanning: false,
    saving: false,
    ready: false,
    loading: true,
    loadError: '',
    picker: { show: false, title: '', columns: [], values: [], target: '' }  // 自定义滚轮
  },

  async onLoad(options) {
    this._options = options
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    this.setData({
      categories: app.globalData.categories,
      seasons: app.globalData.seasons,
      accessoryTypes: app.globalData.accessoryTypes,
      sizes: app.globalData.sizes,
      colorOptions: [...app.globalData.colors, '其他']
    })
    this.syncSeasonStates()
    if (options.id) {
      this.setData({ id: options.id })
      wx.setNavigationBarTitle({ title: '编辑衣物' })
      return this.loadItem(options.id)
    } else {
      // 尺码记忆：新增时默认带出上次保存的尺码（仅此字段记忆，其他不记）
      let lastSize = ''
      try { lastSize = wx.getStorageSync('lastSize') } catch (e) { console.error(e) }
      this.setData({ ready: true, loading: false, loadError: '' })
      if (this.data.sizes.includes(lastSize)) {
        this.setData({ size: lastSize })
      }
    }
  },

  syncSeasonStates() {
    const { seasons, selectedSeasons } = this.data
    this.setData({
      seasonStates: seasons.map(s => ({ value: s, active: selectedSeasons.indexOf(s) >= 0 }))
    })
  },

  onRetry() { return this.onLoad(this._options || {}) },

  async loadItem(id) {
    this.setData({ ready: false, loading: true, loadError: '' })
    try {
      const item = await db.getItem(id)
      if (!item) throw new Error('衣物不存在')
      const subcategory = item.subcategory || ''
      const size = item.size || ''
      const color = item.color || ''
      const colorIndex = this.data.colorOptions.indexOf(color)
      // 不在常见颜色里的视为自定义颜色：选中「其他」并展开输入框
      const colorCustom = !!color && colorIndex === -1
      this.setData({
        ready: true, loading: false, loadError: '',
        name: item.name || '',
        category: item.category || '',
        subcategory,
        subcategoryIndex: this.data.accessoryTypes.indexOf(subcategory),
        size,
        color,
        colorIndex: colorCustom ? this.data.colorOptions.length - 1 : colorIndex,
        colorCustom,
        brand: item.brand || '',
        selectedSeasons: item.seasons || [],
        price: item.price != null ? String(item.price) : '',
        purchaseDate: item.purchaseDate || '',
        note: item.note || '',
        imageFileID: item.imageFileID || ''
      })
      this.syncSeasonStates()
    } catch (e) {
      console.error(e)
      this.setData({ ready: false, loading: false, loadError: '衣物加载失败，请重试' })
    }
  },

  async onChooseImage() {
    if (this.data.scanning || this.data.saving) return
    try {
      const path = await db.chooseImage()
      const previousScan = this.data.scanFileID
      const patch = { imagePath: path, scanFileID: '' }
      if (!this.data.id) patch.imageFileID = ''
      this.setData(patch)
      if (previousScan) db.removeImage(previousScan)
    } catch (e) {
      // 用户取消选择
    }
  },

  onUnload() {
    if (this.data.scanFileID && !this._scanCommitted) db.removeImage(this.data.scanFileID)
  },

  async onScanPhoto() {
    const { id, imagePath, scanFileID, scanning, saving, ready } = this.data
    if (id || scanning || saving || !ready || (!imagePath && !scanFileID)) return
    this.setData({ scanning: true })
    wx.showLoading({ title: '识别中…' })
    let message = '已自动填充，请核对'
    try {
      let fileID = scanFileID
      if (!fileID) {
        fileID = await db.uploadImage(imagePath)
        this.setData({ imagePath: '', imageFileID: fileID, scanFileID: fileID })
      }
      const result = await db.itemScan(fileID)
      const current = this.data
      const patch = {}
      if (!current.name.trim() && result.name) patch.name = result.name
      if (!current.category && result.category) {
        patch.category = result.category
        const allowedSizes = result.category === '鞋' ? current.shoeSizes : current.sizes
        if (!allowedSizes.includes(current.size)) patch.size = ''
      }
      const category = patch.category || current.category
      if (category === '配饰' && !current.subcategory && result.subcategory) {
        patch.subcategory = result.subcategory
        patch.subcategoryIndex = current.accessoryTypes.indexOf(result.subcategory)
      }
      if (!current.color.trim() && !current.colorCustom && result.color) {
        patch.color = result.color
        patch.colorIndex = current.colorOptions.indexOf(result.color)
        patch.colorCustom = false
      }
      if (!current.selectedSeasons.length && result.seasons.length) {
        patch.selectedSeasons = result.seasons
        patch.seasonStates = current.seasons.map(value => ({ value, active: result.seasons.includes(value) }))
      }
      if (!current.brand.trim() && result.brand) patch.brand = result.brand
      this.setData(patch)
    } catch (e) {
      console.error(e)
      message = e.message || '识别失败，请重试或手动填写'
    } finally {
      wx.hideLoading()
      this.setData({ scanning: false })
      wx.showToast({ title: message, icon: 'none' })
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }) },
  onColorInput(e) { this.setData({ color: e.detail.value }) },   // 「其他」时的自定义颜色
  onBrandInput(e) { this.setData({ brand: e.detail.value }) },

  onSizeTap(e) {
    const size = e.currentTarget.dataset.value
    if (this.data.sizes.includes(size)) this.setData({ size })
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.value
    if (!this.data.categories.includes(category)) return
    const patch = { category }
    const allowedSizes = category === '鞋' ? this.data.shoeSizes : this.data.sizes
    if (category !== this.data.category && !allowedSizes.includes(this.data.size)) patch.size = ''
    if (category !== '配饰') {
      patch.subcategory = ''
      patch.subcategoryIndex = -1
    }
    this.setData(patch)
  },

  // ---------- 自定义滚轮选择器（原生 picker 滚轮字体无法调样式） ----------

  openPicker(e) {
    const target = e.currentTarget.dataset.target
    const d = this.data
    let picker
    if (target === 'subcategory') {
      picker = { target, title: '选择配饰类型', columns: [d.accessoryTypes], values: [Math.max(d.subcategoryIndex, 0)] }
    } else if (target === 'shoeSize') {
      picker = { target, title: '选择鞋码', columns: [d.shoeSizes], values: [Math.max(d.shoeSizes.indexOf(d.size), 0)] }
    } else if (target === 'color') {
      picker = { target, title: '选择颜色', columns: [d.colorOptions], values: [Math.max(d.colorIndex, 0)] }
    } else {
      picker = { target, title: '购买日期', ...this.buildDateColumns(d.purchaseDate) }
    }
    picker.show = true
    this.setData({ picker })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const values = e.detail.values
    const patch = { 'picker.show': false }
    if (picker.target === 'subcategory') {
      patch.subcategoryIndex = values[0]
      patch.subcategory = picker.columns[0][values[0]]
    } else if (picker.target === 'shoeSize') {
      patch.size = picker.columns[0][values[0]]
    } else if (picker.target === 'color') {
      const value = picker.columns[0][values[0]]
      patch.colorIndex = values[0]
      if (value === '其他') {
        patch.colorCustom = true
      } else {
        patch.color = value
        patch.colorCustom = false
      }
    } else if (picker.target === 'date') {
      patch.purchaseDate = `${picker.columns[0][values[0]]}-${picker.columns[1][values[1]]}-${picker.columns[2][values[2]]}`
    }
    this.setData(patch)
  },

  onPickerCancel() {
    this.setData({ 'picker.show': false })
  },
  onPriceInput(e) { this.setData({ price: e.detail.value }) },
  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  onSeasonTap(e) {
    const value = e.currentTarget.dataset.value
    let selected = this.data.selectedSeasons.slice()
    const idx = selected.indexOf(value)
    if (idx >= 0) {
      selected.splice(idx, 1)
    } else {
      selected.push(value)
    }
    this.setData({ selectedSeasons: selected })
    this.syncSeasonStates()
  },

  async onSave() {
    const { id, name, category, subcategory, size, color, brand, selectedSeasons, price, purchaseDate, note, imagePath, imageFileID, saving } = this.data
    if (saving || !this.data.ready) return
    if (!name.trim()) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    if (!category) {
      wx.showToast({ title: '请选择类别', icon: 'none' })
      return
    }
    if (category === '配饰' && !subcategory) {
      wx.showToast({ title: '请选择配饰类型', icon: 'none' })
      return
    }
    if (purchaseDate && !validDate(purchaseDate)) {
      wx.showToast({ title: '请选择有效购买日期', icon: 'none' })
      return
    }
    const numericPrice = price ? Number(price) : 0
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      wx.showToast({ title: '请输入有效价格', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…' })
    let uploadedFileID = ''
    let committed = false
    let result = {}
    try {
      let fileID = imageFileID
      if (imagePath) {
        uploadedFileID = await db.uploadImage(imagePath)
        fileID = uploadedFileID
      }
      const data = {
        name: name.trim(),
        category,
        subcategory: category === '配饰' ? subcategory : '',
        size,
        color: color.trim(),
        brand: brand.trim(),
        seasons: selectedSeasons,
        price: numericPrice,
        purchaseDate,
        note: note.trim(),
        imageFileID: fileID
      }
      if (id) {
        result = await db.updateItem(id, data)
      } else {
        await db.addItem(data)
      }
      committed = true
      this._scanCommitted = true
      // 只记尺码，供下次新增时带出
      try { if (size) wx.setStorageSync('lastSize', size) } catch (e) { console.error('尺码记忆失败', e) }
      wx.hideLoading()
      wx.showToast({ title: result.cleanupFailed ? '已保存，清理待重试' : '已保存', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) {
      console.error(e)
      // 上传成功但数据库写入失败时回收新图，避免产生孤立文件。
      if (uploadedFileID && !committed) db.removeImage(uploadedFileID)
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  onDelete() {
    if (!this.data.ready || this.data.saving) return
    wx.showModal({
      title: '删除衣物',
      content: '确定要删除这件衣物吗？',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm || this.data.saving) return
        this.setData({ saving: true })
        wx.showLoading({ title: '删除中…' })
        try {
          const result = await db.deleteItem(this.data.id)
          wx.hideLoading()
          if (result.cleanupFailed) {
            wx.showModal({
              title: '衣物已删除',
              content: '部分引用或图片清理未完成，请到「我的」重试清理。',
              showCancel: false,
              complete: () => wx.navigateBack()
            })
          } else {
            wx.showToast({ title: '已删除' })
            setTimeout(() => wx.navigateBack(), 500)
          }
        } catch (e) {
          console.error(e)
          wx.hideLoading()
          this.setData({ saving: false })
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
})
