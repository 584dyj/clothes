const db = require('../../utils/db')
const auth = require('../../utils/auth')
const app = getApp()

// 穿搭助手（tab 页）：穿搭会话存 ai_chats，购买评估只读取现有数据，不保存评估记录。
// 上次查看的会话持久化到本地存储，页面被系统重建后 onShow 自动恢复。
const VIEW_KEY = 'assistantView'

Page({
  async onShow() {
    if (!await auth.ensureLogin()) {
      this.setData({ loading: false, loadError: '登录校验未完成，请重试' })
      return
    }
    await this.loadSessions()
  },

  async onRetry() {
    if (!await auth.ensureLogin()) return
    return this.loadSessions()
  },

  async onPullDownRefresh() {
    try { await this.onRetry() } finally { wx.stopPullDownRefresh() }
  },

  onHide() { this.clearSessionTap() },
  onUnload() { this.clearSessionTap() },

  data: {
    activeMode: 'outfit',
    categories: app.globalData.categories,
    accessoryTypes: app.globalData.accessoryTypes,
    seasons: app.globalData.seasons,
    seasonOptions: app.globalData.seasons.map(value => ({ value, selected: false })),
    colors: app.globalData.colors,
    occasions: app.globalData.occasions,
    purchaseForm: { name: '', category: '', subcategory: '', color: '', seasons: [], occasion: '', price: '', monthlyBudget: '', note: '' },
    purchaseAssessing: false,
    purchaseError: '',
    purchaseResult: null,
    sessions: [],
    visibleSessions: [],
    currentId: '',
    title: '新会话',
    messages: [],
    input: '',
    imagePath: '',
    selectedItemId: '',
    selectedItemName: '',
    itemPicker: { show: false, title: '', columns: [], values: [] },
    canSend: false,
    sending: false,
    streaming: false,
    awaitingReply: false,
    thinkingText: '思考中…',
    sendError: '',
    loading: true,
    loadError: '',
    scrollIntoView: '',
    renamingSaving: false
  },

  // 服务端已过滤旧品牌搜索会话，这里只维护穿搭会话列表。
  applySessions(sessions, extra = {}) {
    this.setData({ sessions, visibleSessions: sessions, ...extra })
  },

  onModeTap(e) {
    const mode = e.currentTarget.dataset.mode
    if (!['outfit', 'purchase'].includes(mode) || mode === this.data.activeMode) return
    if (mode === 'purchase') {
      this.onNewSession()
      this.applySessions(this.data.sessions, { activeMode: mode })
      return
    }
    this.applySessions(this.data.sessions, { activeMode: 'outfit' })
  },

  saveView(id) {
    wx.setStorageSync(VIEW_KEY, id ? { currentId: id } : '')
  },

  async loadSessions() {
    this.setData({ loadError: '' })
    try {
      const sessions = await db.chatList()
      this.applySessions(sessions, { loading: false })
      if (this.data.currentId && !this.data.sending) {
        await this.loadChat(this.data.currentId)
      } else if (!this.data.sending) {
        // 页面重建后恢复上次查看的会话；已删除的会话清掉失效记录
        const saved = wx.getStorageSync(VIEW_KEY)
        const savedId = saved && saved.currentId
        const session = savedId && sessions.find(item => item._id === savedId)
        if (session) {
          this.applySessions(sessions, { activeMode: 'outfit' })
          await this.loadChat(savedId)
        } else {
          if (savedId) this.saveView('')
          if (!sessions.length) this.setData({ title: '新会话', messages: [] })
        }
      }
      // 等待回复中切回页面：滚动位置可能在 tab 切换后异常，强制滚到最新消息
      if (this.data.awaitingReply && this.data.messages.length) this.setData({ scrollIntoView: 'msg-end' })
    } catch (e) {
      console.error(e)
      // 已有对话内容时不用错误页整体替换，避免刷新失败弄丢当前视图
      if (this.data.messages.length || this.data.currentId) {
        wx.showToast({ title: '会话列表刷新失败', icon: 'none' })
        this.setData({ loading: false })
      } else {
        this.setData({ loading: false, loadError: '会话加载失败，请重试' })
      }
    }
  },

  async loadChat(id) {
    this.detachPendingSend()
    try {
      const chat = await db.chatGet(id)
      this.saveView(id)
      this.setData({
        currentId: id,
        title: chat.title,
        messages: chat.messages.map(message => ({ ...message, displayText: message.text || '' })),
        awaitingReply: false,
        sendError: chat.messages.length && chat.messages[chat.messages.length - 1].role === 'user'
          ? '这条提问尚未收到回复。请稍后刷新；若持续如此，请检查 auth 云函数日志。' : '',
        scrollIntoView: chat.messages.length ? 'msg-' + (chat.messages.length - 1) : ''
      })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: e.message || '会话加载失败', icon: 'none' })
    }
  },

  clearSessionTap() {
    if (this._sessionTapTimer) clearTimeout(this._sessionTapTimer)
    this._sessionTapTimer = null
    this._lastSessionTap = null
  },

  onSessionTap(e) {
    if (this.data.renamingSaving) return
    const id = e.currentTarget.dataset.id
    if (id === 'new') return this.onNewSession()
    const now = Date.now()
    const doubleTap = this._lastSessionTap && this._lastSessionTap.id === id && now - this._lastSessionTap.at < 400
    this.clearSessionTap()
    if (doubleTap) return this.onRenameSession(id)
    this._lastSessionTap = { id, at: now }
    this._sessionTapTimer = setTimeout(() => {
      this._sessionTapTimer = null
      this._lastSessionTap = null
      if (id === this.data.currentId || this.data.renamingSaving) return
      this.setData({ messages: [] })
      this.loadChat(id)
    }, 400)
  },

  // 新会话/切换会话不打断后台生成：序号递增后，在途回复完成时只刷新列表、不覆盖当前视图。
  detachPendingSend() {
    this._sendSeq = (this._sendSeq || 0) + 1
  },

  onNewSession() {
    this.detachPendingSend()
    this.saveView('')
    this.clearSessionTap()
    this.setData({ currentId: '', title: '新会话', messages: [], input: '', imagePath: '', selectedItemId: '', selectedItemName: '',
      'itemPicker.show': false, canSend: false, sendError: '',
      awaitingReply: false, scrollIntoView: '' })
  },

  onRenameSession(id) {
    if (this.data.sending || this.data.renamingSaving) return
    const session = this.data.sessions.find(item => item._id === id)
    if (!session) return
    wx.showModal({
      title: '修改会话名称',
      content: session.title || '',
      editable: true,
      placeholderText: '输入会话名称',
      confirmText: '保存',
      success: async res => {
        if (!res.confirm) return
        const title = typeof res.content === 'string' ? res.content.trim() : ''
        if (!title || title.length > 24) {
          wx.showToast({ title: '请输入 1 至 24 个字符', icon: 'none' })
          return
        }
        this.setData({ renamingSaving: true })
        try {
          await db.chatRename(id, title)
          this.applySessions(this.data.sessions.map(item => item._id === id ? { ...item, title } : item),
            { title: this.data.currentId === id ? title : this.data.title })
        } catch (e) {
          console.error(e)
          wx.showToast({ title: e.message || '改名失败', icon: 'none' })
        } finally { this.setData({ renamingSaving: false }) }
      }
    })
  },

  onSessionLongPress(e) {
    this.clearSessionTap()
    this.onDeleteSession(e)
  },

  onDeleteSession(e) {
    if (this.data.sending) return
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '删除会话',
      content: '确定删除这个对话吗？删除后不可恢复。',
      confirmColor: '#c0504d',
      success: async res => {
        if (!res.confirm) return
        try {
          await db.chatDelete(id)
          this.applySessions(this.data.sessions.filter(session => session._id !== id))
          if (this.data.currentId === id) this.onNewSession()
        } catch (e) {
          console.error(e)
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  onInput(e) {
    this.setData({ input: e.detail.value, canSend: !!e.detail.value.trim() || !!this.data.imagePath || !!this.data.selectedItemId })
  },

  onChooseImage() {
    if (this.data.sending) return
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择', '从衣橱选择'],
      success: res => {
        if (res.tapIndex === 0) this.onTakePhoto()
        else if (res.tapIndex === 1) this.onChooseAlbum()
        else if (res.tapIndex === 2) this.onChooseWardrobeItem()
      }
    })
  },

  onTakePhoto() { return this.chooseImage(['camera']) },

  onChooseAlbum() { return this.chooseImage(['album']) },

  async chooseImage(sourceType) {
    try {
      const path = await db.chooseImage(sourceType)
      this.setData({ imagePath: path, selectedItemId: '', selectedItemName: '', canSend: true })
    } catch (e) {
      const message = e.errMsg || e.message || ''
      if (sourceType[0] === 'camera' && /auth|authorize|permission|deny/i.test(message)) {
        wx.showModal({ title: '无法使用相机', content: '请在小程序设置中允许使用相机',
          confirmText: '打开设置', success: res => { if (res.confirm) wx.openSetting({}) } })
      } else if (!/cancel/i.test(message)) {
        wx.showToast({ title: '选图失败，请重试', icon: 'none' })
      }
    }
  },

  onPreviewImage(e) {
    const fileID = e.currentTarget.dataset.fileid
    if (fileID) wx.previewImage({ current: fileID, urls: [fileID] })
  },

  onPreviewSelectedImage() {
    if (this.data.imagePath) wx.previewImage({ current: this.data.imagePath, urls: [this.data.imagePath] })
  },

  onRemoveImage() {
    this.setData({ imagePath: '', canSend: !!this.data.input.trim() || !!this.data.selectedItemId })
  },

  async onChooseWardrobeItem() {
    try {
      const items = (await db.listItems()).filter(item => item.category !== '挂件')
      if (!items.length) {
        wx.showToast({ title: '衣橱暂无可选单品', icon: 'none' })
        return
      }
      this._wardrobeItems = items
      const labels = items.map(item => [item.name || '未命名', item.category, item.color].filter(Boolean).join(' · '))
      const selectedIndex = items.findIndex(item => item._id === this.data.selectedItemId)
      this.setData({ itemPicker: { show: true, title: '选择衣橱单品', columns: [labels], values: [Math.max(selectedIndex, 0)] } })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '衣橱加载失败，请重试', icon: 'none' })
    }
  },

  onItemPickerConfirm(e) {
    const item = (this._wardrobeItems || [])[e.detail.values[0]]
    if (!item) return this.setData({ 'itemPicker.show': false })
    this.setData({ selectedItemId: item._id, selectedItemName: item.name || '未命名', imagePath: '', canSend: true,
      'itemPicker.show': false })
  },

  onItemPickerCancel() {
    this.setData({ 'itemPicker.show': false })
  },

  onRemoveSelectedItem() {
    this.setData({ selectedItemId: '', selectedItemName: '', canSend: !!this.data.input.trim() || !!this.data.imagePath })
  },

  onPurchaseFieldInput(e) {
    this.setData({ [`purchaseForm.${e.currentTarget.dataset.field}`]: e.detail.value, purchaseError: '' })
  },

  onPurchaseCategoryTap(e) {
    const category = e.currentTarget.dataset.value
    this.setData({ 'purchaseForm.category': category,
      'purchaseForm.subcategory': category === '配饰' ? this.data.purchaseForm.subcategory : '', purchaseError: '' })
  },

  onPurchaseSubcategoryTap(e) {
    this.setData({ 'purchaseForm.subcategory': e.currentTarget.dataset.value, purchaseError: '' })
  },

  onPurchaseSeasonTap(e) {
    const value = e.currentTarget.dataset.value
    const selected = this.data.purchaseForm.seasons
    const seasons = selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]
    this.setData({ 'purchaseForm.seasons': seasons,
      seasonOptions: this.data.seasonOptions.map(item => ({ ...item, selected: seasons.includes(item.value) })), purchaseError: '' })
  },

  onPurchaseColorChange(e) {
    this.setData({ 'purchaseForm.color': this.data.colors[Number(e.detail.value)] || '', purchaseError: '' })
  },

  onPurchaseOccasionChange(e) {
    this.setData({ 'purchaseForm.occasion': this.data.occasions[Number(e.detail.value)] || '', purchaseError: '' })
  },

  async onPurchaseSubmit() {
    if (this.data.purchaseAssessing) return
    const form = this.data.purchaseForm
    let error = ''
    if (!form.category) error = '请选择分类'
    else if (form.category === '配饰' && !form.subcategory) error = '请选择配饰类型'
    else if (!form.color) error = '请选择颜色'
    else if (!form.seasons.length) error = '请至少选择一个季节'
    else if (!Number.isFinite(Number(form.price)) || Number(form.price) <= 0) error = '请输入有效价格'
    if (error) {
      this.setData({ purchaseError: error })
      return
    }
    this.setData({ purchaseAssessing: true, purchaseError: '' })
    try {
      this.setData({ purchaseResult: await db.purchaseAssess(form) })
    } catch (e) {
      console.error(e)
      this.setData({ purchaseError: e.message || '评估失败，请重试' })
    } finally { this.setData({ purchaseAssessing: false }) }
  },

  onPurchaseEdit() {
    this.setData({ purchaseResult: null, purchaseError: '' })
  },

  async onSend(suggestion) {
    const fromSuggestion = typeof suggestion === 'string'
    const inputText = (fromSuggestion ? suggestion : this.data.input).trim()
    const { imagePath, selectedItemId, selectedItemName, sending } = this.data
    if (sending || (!inputText && !imagePath && !selectedItemId)) return
    const text = selectedItemId
      ? (inputText ? `【${selectedItemName}】${inputText}` : `请以「${selectedItemName}」为核心给我穿搭建议`)
      : inputText
    // 发送期间允许切模式/看其他会话/切 tab：序号不变说明用户仍在原视图，变了则只做后台收尾。
    const seq = (this._sendSeq = (this._sendSeq || 0) + 1)
    const inView = () => this._sendSeq === seq
    const previousMessages = this.data.messages
    const pendingMessages = [...previousMessages, { role: 'user', text, displayText: text, imageFileID: imagePath }]
    this.setData({ sending: true, streaming: false, awaitingReply: true, thinkingText: '思考中…',
      sendError: '', input: '', canSend: false, messages: pendingMessages, scrollIntoView: 'msg-thinking' })
    try {
      let fileID = ''
      if (imagePath) fileID = await db.uploadImage(imagePath)
      let streamed = '', lastRender = 0
      const result = await db.chatSend({ chatId: this.data.currentId || '', text, imageFileID: fileID, itemId: selectedItemId }, delta => {
        if (!inView()) return
        streamed += delta
        if (Date.now() - lastRender < 80) return
        lastRender = Date.now()
        this.setData({ streaming: true, messages: [...pendingMessages, { role: 'assistant', text: streamed, displayText: streamed }],
          scrollIntoView: 'msg-' + pendingMessages.length })
      })
      if (inView()) {
        const messages = result.messages.map(message => ({ ...message, displayText: message.text || '' }))
        this.saveView(result.chatId)
        this.setData({
          currentId: result.chatId,
          title: result.title,
          messages,
          input: '',
          imagePath: '',
          selectedItemId: '',
          selectedItemName: '',
          canSend: false,
          scrollIntoView: messages.length ? 'msg-' + (messages.length - 1) : ''
        })
      }
      // 刷新会话列表，让新会话/新标题及时出现（含后台完成的会话）；失败不影响本次回复
      try {
        this.applySessions(await db.chatList())
      } catch (e) { console.error(e) }
    } catch (e) {
      console.error(e)
      if (inView()) {
        const failedMessages = pendingMessages
        const failedPatch = { messages: failedMessages, scrollIntoView: failedMessages.length ? 'msg-' + (failedMessages.length - 1) : '',
          input: fromSuggestion ? '' : inputText,
          canSend: fromSuggestion ? !!imagePath || !!selectedItemId : !!inputText || !!imagePath || !!selectedItemId,
          sendError: e.message || '发送失败，请重试' }
        if (e.chatId) {
          failedPatch.currentId = e.chatId
          failedPatch.title = e.chatTitle || this.data.title
        }
        this.setData(failedPatch)
        wx.showToast({ title: e.message || '发送失败', icon: 'none' })
      } else {
        // 用户已离开原会话：回复虽失败，用户消息已存云端，刷新列表保留入口
        try {
          this.applySessions(await db.chatList())
        } catch (refreshError) { console.error(refreshError) }
      }
    } finally {
      this.setData({ sending: false, streaming: false, awaitingReply: false })
    }
  },

  onSuggestionTap(e) {
    if (this.data.sending) return
    if (this.data.currentId) this.onNewSession()
    return this.onSend(e.currentTarget.dataset.text)
  }
})
