const db = require('../../utils/db')
const auth = require('../../utils/auth')

// 对话式 AI 助手（tab 页）：会话存 ai_chats，支持文字提问与拍照搭配。
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
    sessions: [],
    currentId: '',
    title: '新会话',
    messages: [],
    input: '',
    imagePath: '',
    canSend: false,
    sending: false,
    streaming: false,
    thinkingText: '思考中…',
    sendError: '',
    loading: true,
    loadError: '',
    scrollIntoView: '',
    renamingSaving: false
  },

  async loadSessions() {
    this.setData({ loadError: '' })
    try {
      const sessions = await db.chatList()
      this.setData({ sessions, loading: false })
      if (this.data.currentId && !this.data.sending) {
        await this.loadChat(this.data.currentId)
      } else if (!sessions.length && !this.data.sending) {
        this.setData({ title: '新会话', messages: [] })
      }
    } catch (e) {
      console.error(e)
      this.setData({ loading: false, loadError: '会话加载失败，请重试' })
    }
  },

  async loadChat(id) {
    try {
      const chat = await db.chatGet(id)
      this.setData({
        currentId: id,
        title: chat.title,
        messages: chat.messages.map(message => ({ ...message, displayText: message.text || '' })),
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
    if (this.data.sending || this.data.renamingSaving) return
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
      if (id === this.data.currentId || this.data.sending || this.data.renamingSaving) return
      this.setData({ messages: [] })
      this.loadChat(id)
    }, 400)
  },

  onNewSession() {
    if (this.data.sending) return
    this.clearSessionTap()
    this.setData({ currentId: '', title: '新会话', messages: [], input: '', imagePath: '', canSend: false, sendError: '',
      scrollIntoView: '' })
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
          this.setData({ sessions: this.data.sessions.map(item => item._id === id ? { ...item, title } : item),
            title: this.data.currentId === id ? title : this.data.title })
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
          const sessions = this.data.sessions.filter(session => session._id !== id)
          this.setData({ sessions })
          if (this.data.currentId === id) this.onNewSession()
        } catch (e) {
          console.error(e)
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  onInput(e) {
    this.setData({ input: e.detail.value, canSend: !!e.detail.value.trim() || !!this.data.imagePath })
  },

  onChooseImage() {
    if (this.data.sending) return
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: res => { if (res.tapIndex === 0) this.onTakePhoto(); else if (res.tapIndex === 1) this.onChooseAlbum() }
    })
  },

  onTakePhoto() { return this.chooseImage(['camera']) },

  onChooseAlbum() { return this.chooseImage(['album']) },

  async chooseImage(sourceType) {
    try {
      const path = await db.chooseImage(sourceType)
      this.setData({ imagePath: path, canSend: true })
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

  onSourceTap(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.setClipboardData({ data: url })
  },

  onRemoveImage() {
    this.setData({ imagePath: '', canSend: !!this.data.input.trim() })
  },

  async onSend(suggestion, mode = '') {
    const fromSuggestion = typeof suggestion === 'string'
    const text = (fromSuggestion ? suggestion : this.data.input).trim()
    const { imagePath, sending } = this.data
    if (sending || (!text && !imagePath)) return
    const previousMessages = this.data.messages
    const pendingMessages = [...previousMessages, { role: 'user', text, displayText: text, imageFileID: imagePath }]
    this.setData({ sending: true, streaming: false, thinkingText: mode === 'brandLatest' ? '正在检索并核对新品…' : '思考中…',
      sendError: '', input: '', canSend: false, messages: pendingMessages, scrollIntoView: 'msg-thinking' })
    try {
      let fileID = ''
      if (imagePath) fileID = await db.uploadImage(imagePath)
      let streamed = '', lastRender = 0
      const result = await db.chatSend({ chatId: this.data.currentId || '', text, imageFileID: fileID, mode }, delta => {
        streamed += delta
        if (Date.now() - lastRender < 80) return
        lastRender = Date.now()
        this.setData({ streaming: true, messages: [...pendingMessages, { role: 'assistant', text: streamed, displayText: streamed }],
          scrollIntoView: 'msg-' + pendingMessages.length })
      })
      const messages = result.messages.map(message => ({ ...message, displayText: message.text || '' }))
      this.setData({
        currentId: result.chatId,
        title: result.title,
        messages,
        input: '',
        imagePath: '',
        canSend: false,
        scrollIntoView: messages.length ? 'msg-' + (messages.length - 1) : ''
      })
      // 刷新会话列表，让新会话/新标题及时出现；失败不影响本次回复
      try {
        this.setData({ sessions: await db.chatList() })
      } catch (e) { console.error(e) }
    } catch (e) {
      console.error(e)
      const failedMessages = pendingMessages
      const failedPatch = { messages: failedMessages, scrollIntoView: failedMessages.length ? 'msg-' + (failedMessages.length - 1) : '',
        input: fromSuggestion ? '' : text, canSend: fromSuggestion ? !!imagePath : !!text || !!imagePath,
        sendError: e.message || '发送失败，请重试' }
      if (e.chatId) {
        failedPatch.currentId = e.chatId
        failedPatch.title = e.chatTitle || this.data.title
      }
      this.setData(failedPatch)
      wx.showToast({ title: e.message || '发送失败', icon: 'none' })
    } finally {
      this.setData({ sending: false, streaming: false })
    }
  },

  onSuggestionTap(e) {
    if (this.data.sending) return
    if (this.data.currentId) this.onNewSession()
    return this.onSend(e.currentTarget.dataset.text, e.currentTarget.dataset.mode || '')
  }
})
