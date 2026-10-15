const db = require('../../utils/db')
const auth = require('../../utils/auth')
const { cleanScanFields } = require('../../utils/item-fields')
const app = getApp()

const SHOE_SIZES = Array.from({ length: 21 }, (_, index) => String(index + 30))
const MAX_CARDS = 9
const STATUS_TEXT = {
  queued: '排队中', scanning: '识别中', pending: '待确认',
  failed: '失败', saving: '保存中', saved: '已入库'
}
const DEFAULT_HINT = '最多选择 9 张衣物或鞋子照片'

Component({
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
    scanDone: 0,
    scanTotal: 0,
    remainingSlots: MAX_CARDS,
    saveBtnText: '全部保存',
    toolbarHint: DEFAULT_HINT,
    loadError: '',
    picker: { show: false, title: '', columns: [], values: [], target: '', key: '' }
  },

  lifetimes: {
    async attached() {
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

    detached() {
      this._unloaded = true
      Promise.all(this.data.cards
        .filter(card => card.status !== 'saved' && card.imageFileID)
        .map(card => db.removeImage(card.imageFileID)))
    }
  },

  methods: {
    card(key) { return this.data.cards.find(item => item.key === key) },

    unsavedCards() { return this.data.cards.filter(card => card.status !== 'saved') },

    patchCard(key, patch) {
      this.setData({
        cards: this.data.cards.map(card => card.key === key ? { ...card, ...patch } : card)
      })
      this.refreshView()
    },

    // 派生展示状态：剩余名额、保存按钮文案、工具栏提示。每次卡片变动后统一重算。
    refreshView() {
      const unsaved = this.unsavedCards()
      const saveable = unsaved.filter(card => !this.validate(card)).length
      let saveBtnText = '全部保存'
      if (this.data.processing) saveBtnText = `识别中 ${this.data.scanDone}/${this.data.scanTotal}…`
      else if (this.data.saving) saveBtnText = '保存中…'
      else if (saveable) saveBtnText = `全部保存（${saveable} 件可入库）`
      this.setData({
        remainingSlots: MAX_CARDS - unsaved.length,
        saveBtnText,
        toolbarHint: unsaved.length ? `已选 ${unsaved.length}/${MAX_CARDS} 张 · 逐张识别` : DEFAULT_HINT
      })
    },

    seasonStates(selected = []) {
      return this.data.seasons.map(value => ({ value, active: selected.includes(value) }))
    },

    async onChooseImages() {
      if (!this.data.ready || this.data.processing || this.data.saving) return
      const count = this.data.remainingSlots
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
          failStage: '',
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
        this.refreshView()
        await this.scanCards(added.map(card => card.key))
      } catch (e) {
        if (!String(e && (e.errMsg || e.message || '')).includes('cancel')) {
          wx.showToast({ title: '选择图片失败', icon: 'none' })
        }
      }
    },

    async scanCards(keys) {
      if (this.data.processing) return
      this.setData({ processing: true, scanTotal: keys.length, scanDone: 0 })
      this.refreshView()
      for (const key of keys) {
        await this.scanCard(key)
        if (this._unloaded) return
        this.setData({ scanDone: this.data.scanDone + 1 })
        this.refreshView()
      }
      this.setData({ processing: false })
      this.refreshView()
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
        const result = cleanScanFields(await db.itemScan(fileID), app.globalData)
        if (this._unloaded) return
        const current = this.card(key)
        if (!current) return
        const category = current.category || result.category
        const seasons = current.seasons.length ? current.seasons : result.seasons
        this.patchCard(key, {
          name: current.name || result.name || '',
          category,
          subcategory: category === '配饰' ? current.subcategory || result.subcategory : '',
          color: current.color || result.color || '',
          colorCustom: !!(current.color || result.color) && !this.data.colors.includes(current.color || result.color),
          seasons,
          seasonStates: this.seasonStates(seasons),
          status: 'pending',
          statusText: STATUS_TEXT.pending,
          error: '',
          failStage: ''
        })
      } catch (e) {
        if (!this._unloaded) this.patchCard(key, {
          status: 'failed',
          statusText: STATUS_TEXT.failed,
          failStage: 'scan',
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
      // 已入库卡片的编辑不会再生效，禁止展开避免误导
      if (!card || card.status === 'saved') return
      this.patchCard(key, { expanded: !card.expanded })
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
        subcategory: value === '配饰' && card.category === '配饰' && this.data.accessoryTypes.includes(card.subcategory) ? card.subcategory : '',
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
      if (target === 'category') {
        title = '选择类别'; options = this.data.categories; current = card.category
      } else if (target === 'subcategory') {
        title = '选择配饰类型'; options = this.data.accessoryTypes; current = card.subcategory
      } else if (target === 'shoeSize') {
        title = '选择鞋码'; options = ['不填写'].concat(this.data.shoeSizes); current = card.size || '37'
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
      if (picker.target === 'category') {
        this.onCategoryTap({ currentTarget: { dataset: { key: picker.key, value } } })
        this.setData({ 'picker.show': false })
        return
      }
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
      if (!(card.name || '').trim()) return '请填写名称'
      if (!this.data.categories.includes(card.category)) return '请选择类别'
      if (card.category === '配饰' && !this.data.accessoryTypes.includes(card.subcategory)) return '请选择配饰类型'
      const price = card.price === '' || card.price === undefined ? 0 : Number(card.price)
      if (!Number.isFinite(price) || price < 0) return '请输入有效价格'
      return ''
    },

    buildPayload(card) {
      return {
        name: (card.name || '').trim(),
        category: card.category,
        subcategory: card.category === '配饰' ? card.subcategory : '',
        size: card.size,
        color: (card.color || '').trim(),
        brand: '',
        seasons: card.seasons,
        price: card.price === '' || card.price === undefined ? 0 : Number(card.price),
        purchaseDate: '',
        note: '',
        imageFileID: card.imageFileID
      }
    },

    // 保存单张卡片，成功/失败都会写回卡片状态；返回是否成功
    async saveCard(card) {
      this.patchCard(card.key, { status: 'saving', statusText: STATUS_TEXT.saving, error: '', failStage: '' })
      try {
        await db.addItem(this.buildPayload(card))
        this.patchCard(card.key, { status: 'saved', statusText: STATUS_TEXT.saved, error: '', expanded: false })
        return true
      } catch (e) {
        this.patchCard(card.key, {
          status: 'failed', statusText: STATUS_TEXT.failed, failStage: 'save',
          error: e && e.message || '保存失败，请重试', expanded: true
        })
        return false
      }
    },

    // 保存收尾：刷新衣橱、移除已入库卡片；全部入库时直接返回衣橱页
    async finishSave(saved) {
      try { await db.listItems(true) } catch (e) { console.error('刷新衣橱失败', e) }
      if (this._unloaded) return
      const remaining = this.unsavedCards()
      this.setData({ saving: false, cards: remaining })
      this.refreshView()
      if (!remaining.length) {
        wx.showToast({ title: `已保存 ${saved} 件`, icon: 'none' })
        wx.navigateBack()
      } else {
        wx.showToast({
          title: saved ? `已保存 ${saved} 件，${remaining.length} 件待处理` : `${remaining.length} 件待处理，请检查后重试`,
          icon: 'none'
        })
      }
    },

    async onSaveAll() {
      if (this.data.processing || this.data.saving || !this.data.ready) return
      const candidates = this.unsavedCards()
      if (!candidates.length) {
        wx.showToast({ title: '请先选择图片', icon: 'none' })
        return
      }
      this.setData({ saving: true })
      this.refreshView()
      let saved = 0
      for (const source of candidates) {
        const card = this.card(source.key)
        if (!card || card.status === 'saved') continue
        const error = this.validate(card)
        if (error) {
          // 识别失败的卡片保持 failed，否则「重试识别」入口会被洗掉
          if (card.status === 'failed' && card.failStage === 'scan') {
            this.patchCard(card.key, { error, expanded: true })
          } else {
            this.patchCard(card.key, { status: 'pending', statusText: STATUS_TEXT.pending, failStage: '', error, expanded: true })
          }
          continue
        }
        if (await this.saveCard(card)) saved++
      }
      await this.finishSave(saved)
    },

    async onRetrySave(e) {
      if (this.data.processing || this.data.saving) return
      const card = this.card(e.currentTarget.dataset.key)
      if (!card || card.status === 'saved') return
      const error = this.validate(card)
      if (error) {
        this.patchCard(card.key, { error, expanded: true })
        return
      }
      this.setData({ saving: true })
      this.refreshView()
      const saved = await this.saveCard(card) ? 1 : 0
      await this.finishSave(saved)
    },

    onRemoveCard(e) {
      if (this.data.processing || this.data.saving) return
      const key = e.currentTarget.dataset.key
      const card = this.card(key)
      if (!card) return
      this.setData({ cards: this.data.cards.filter(item => item.key !== key) })
      this.refreshView()
      if (card.status !== 'saved' && card.imageFileID) return db.removeImage(card.imageFileID)
    }
  }
})
