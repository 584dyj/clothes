const db = require('../../utils/db')
const auth = require('../../utils/auth')
const app = getApp()

const SHOE_SIZES = Array.from({ length: 21 }, (_, index) => String(index + 30))
const STATUS_TEXT = {
  queued: '排队中', scanning: '识别中', pending: '待确认',
  failed: '失败', saving: '保存中', saved: '已入库'
}

Page({
  data: {
    cards: [],
    categories: [],
    seasons: [],
    accessoryTypes: [],
    sizes: [],
    shoeSizes: SHOE_SIZES,
    colors: [],
    ready: false,
    processing: false,
    saving: false,
    loadError: '',
    picker: { show: false, title: '', columns: [], values: [], target: '', key: '' }
  },

  async onLoad() {
    if (!await auth.ensureLogin()) {
      this.setData({ loadError: '登录校验未完成，请重试' })
      return
    }
    this.setData({
      categories: app.globalData.categories,
      seasons: app.globalData.seasons,
      accessoryTypes: app.globalData.accessoryTypes,
      sizes: app.globalData.sizes,
      colors: app.globalData.colors,
      ready: true
    })
  },

  card(key) { return this.data.cards.find(item => item.key === key) },

  patchCard(key, patch) {
    this.setData({
      cards: this.data.cards.map(card => card.key === key ? { ...card, ...patch } : card)
    })
  },

  seasonStates(selected = []) {
    return this.data.seasons.map(value => ({ value, active: selected.includes(value) }))
  },

  async onChooseImages() {
    if (!this.data.ready || this.data.processing || this.data.saving) return
    const count = 9 - this.data.cards.length
    if (count <= 0) {
      wx.showToast({ title: '每批最多 9 张', icon: 'none' })
      return
    }
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({
        count,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: resolve,
        fail: reject
      }))
      const base = Date.now()
      const added = result.tempFiles.map((file, index) => ({
        key: `${base}-${index}`,
        imagePath: file.tempFilePath,
        imageFileID: '',
        status: 'queued',
        statusText: STATUS_TEXT.queued,
        error: '',
        expanded: false,
        name: '',
        category: '',
        subcategory: '',
        size: '',
        color: '',
        colorCustom: false,
        seasons: [],
        seasonStates: this.seasonStates(),
        price: ''
      }))
      this.setData({ cards: this.data.cards.concat(added) })
      await this.scanCards(added.map(card => card.key))
    } catch (e) {
      if (!String(e && (e.errMsg || e.message || '')).includes('cancel')) {
        wx.showToast({ title: '选择图片失败', icon: 'none' })
      }
    }
  },

  async scanCards(keys) {
    if (this.data.processing) return
    this.setData({ processing: true })
    for (const key of keys) await this.scanCard(key)
    if (!this._unloaded) this.setData({ processing: false })
  },

  async scanCard(key) {
    const initial = this.card(key)
    if (!initial || initial.status === 'saved') return
    this.patchCard(key, { status: 'scanning', statusText: STATUS_TEXT.scanning, error: '' })
    try {
      let fileID = initial.imageFileID
      if (!fileID) {
        fileID = await db.uploadImage(initial.imagePath)
        if (this._unloaded) {
          db.removeImage(fileID)
          return
        }
        this.patchCard(key, { imageFileID: fileID })
      }
      const result = await db.itemScan(fileID)
      if (this._unloaded) return
      const current = this.card(key)
      if (!current) return
      const category = current.category || (this.data.categories.includes(result.category) ? result.category : '')
      const seasons = current.seasons.length ? current.seasons : (result.seasons || []).filter(value => this.data.seasons.includes(value))
      this.patchCard(key, {
        name: current.name || result.name || '',
        category,
        subcategory: current.subcategory || (category === '配饰' && this.data.accessoryTypes.includes(result.subcategory) ? result.subcategory : ''),
        color: current.color || result.color || '',
        colorCustom: !!(current.color || result.color) && !this.data.colors.includes(current.color || result.color),
        seasons,
        seasonStates: this.seasonStates(seasons),
        status: 'pending',
        statusText: STATUS_TEXT.pending,
        error: ''
      })
    } catch (e) {
      if (!this._unloaded) this.patchCard(key, {
        status: 'failed',
        statusText: STATUS_TEXT.failed,
        error: e && e.message || '识别失败，请重试'
      })
    }
  },

  async onRetryScan(e) {
    if (this.data.processing || this.data.saving) return
    await this.scanCards([e.currentTarget.dataset.key])
  },

  onToggleCard(e) {
    const key = e.currentTarget.dataset.key
    const card = this.card(key)
    if (card) this.patchCard(key, { expanded: !card.expanded })
  },

  onInput(e) {
    const { key, field } = e.currentTarget.dataset
    this.patchCard(key, { [field]: e.detail.value, error: '' })
  },

  onCategoryTap(e) {
    const { key, value } = e.currentTarget.dataset
    if (!this.data.categories.includes(value)) return
    const card = this.card(key)
    if (!card) return
    const sizes = value === '鞋' ? this.data.shoeSizes : this.data.sizes
    this.patchCard(key, {
      category: value,
      subcategory: value === '配饰' ? card.subcategory : '',
      size: sizes.includes(card.size) ? card.size : '',
      error: ''
    })
  },

  onSizeTap(e) {
    const { key, value } = e.currentTarget.dataset
    if (this.data.sizes.includes(value)) this.patchCard(key, { size: value, error: '' })
  },

  onSeasonTap(e) {
    const { key, value } = e.currentTarget.dataset
    const card = this.card(key)
    if (!card || !this.data.seasons.includes(value)) return
    const seasons = card.seasons.includes(value)
      ? card.seasons.filter(item => item !== value)
      : card.seasons.concat(value)
    this.patchCard(key, { seasons, seasonStates: this.seasonStates(seasons), error: '' })
  },

  openPicker(e) {
    const { key, target } = e.currentTarget.dataset
    const card = this.card(key)
    if (!card) return
    let title, options, current
    if (target === 'subcategory') {
      title = '选择配饰类型'; options = this.data.accessoryTypes; current = card.subcategory
    } else if (target === 'shoeSize') {
      title = '选择鞋码'; options = ['不填写'].concat(this.data.shoeSizes); current = card.size || '不填写'
    } else {
      title = '选择颜色'; options = ['不填写'].concat(this.data.colors, '其他'); current = card.colorCustom ? '其他' : (card.color || '不填写')
    }
    this.setData({ picker: {
      show: true, title, columns: [options], values: [Math.max(options.indexOf(current), 0)], target, key
    } })
  },

  onPickerConfirm(e) {
    const { picker } = this.data
    const value = picker.columns[0][e.detail.values[0]]
    const patch = { error: '' }
    if (picker.target === 'subcategory') patch.subcategory = value
    if (picker.target === 'shoeSize') patch.size = value === '不填写' ? '' : value
    if (picker.target === 'color') {
      patch.colorCustom = value === '其他'
      if (value !== '其他') patch.color = value === '不填写' ? '' : value
      else if (!this.card(picker.key).colorCustom) patch.color = ''
    }
    this.patchCard(picker.key, patch)
    this.setData({ 'picker.show': false })
  },

  onPickerCancel() { this.setData({ 'picker.show': false }) },

  validate(card) {
    if (!card.imageFileID) return '请先重试图片上传'
    if (!card.name.trim()) return '请填写名称'
    if (!card.category) return '请选择类别'
    if (card.category === '配饰' && !card.subcategory) return '请选择配饰类型'
    const price = card.price === '' ? 0 : Number(card.price)
    if (!Number.isFinite(price) || price < 0) return '请输入有效价格'
    return ''
  },

  async onSaveAll() {
    if (this.data.processing || this.data.saving || !this.data.ready) return
    const candidates = this.data.cards.filter(card => card.status !== 'saved')
    if (!candidates.length) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    let saved = 0
    for (const source of candidates) {
      const card = this.card(source.key)
      const error = this.validate(card)
      if (error) {
        this.patchCard(card.key, { status: 'pending', statusText: STATUS_TEXT.pending, error, expanded: true })
        continue
      }
      this.patchCard(card.key, { status: 'saving', statusText: STATUS_TEXT.saving, error: '' })
      try {
        await db.addItem({
          name: card.name.trim(),
          category: card.category,
          subcategory: card.category === '配饰' ? card.subcategory : '',
          size: card.size,
          color: card.color.trim(),
          brand: '',
          seasons: card.seasons,
          price: card.price === '' ? 0 : Number(card.price),
          purchaseDate: '',
          note: '',
          imageFileID: card.imageFileID
        })
        saved++
        this.patchCard(card.key, { status: 'saved', statusText: STATUS_TEXT.saved, error: '', expanded: false })
      } catch (e) {
        this.patchCard(card.key, {
          status: 'failed', statusText: STATUS_TEXT.failed,
          error: e && e.message || '保存失败，请重试', expanded: true
        })
      }
    }
    try { await db.listItems(true) } catch (e) { console.error('刷新衣橱失败', e) }
    if (!this._unloaded) {
      this.setData({ saving: false })
      const pending = this.data.cards.filter(card => card.status !== 'saved').length
      wx.showToast({ title: pending ? `已保存 ${saved} 件，${pending} 件待处理` : `已保存 ${saved} 件`, icon: 'none' })
    }
  },

  onRemoveCard(e) {
    if (this.data.processing || this.data.saving) return
    const key = e.currentTarget.dataset.key
    const card = this.card(key)
    if (!card) return
    this.setData({ cards: this.data.cards.filter(item => item.key !== key) })
    if (card.status !== 'saved' && card.imageFileID) return db.removeImage(card.imageFileID)
  },

  onUnload() {
    this._unloaded = true
    return Promise.all(this.data.cards
      .filter(card => card.status !== 'saved' && card.imageFileID)
      .map(card => db.removeImage(card.imageFileID)))
  }
})
