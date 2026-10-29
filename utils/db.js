// 数据读写由 auth 云函数验证账号与记录归属。
const { CLOUD_ENV } = require('./config')

function call(action, data = {}) {
  return wx.cloud.callFunction({ name: 'auth', data: { ...data, action } }).then(res => {
    if (!res.result || !res.result.success) {
      const error = new Error(res.result && res.result.error || '服务暂不可用')
      error.action = action
      error.requestID = res.requestID
      error.diagnostic = res.result && res.result.diagnostic
      console.error('auth 调用失败', { action, requestID: error.requestID, diagnostic: error.diagnostic, message: error.message })
      throw error
    }
    return res.result
  })
}

// 让用户选图（相册或拍照），返回本地临时路径
function chooseImage(sourceType = ['album', 'camera']) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType,
      sizeType: ['compressed'],   // 优先拿微信压缩过的图
      success: res => resolve(res.tempFiles[0].tempFilePath),
      fail: reject
    })
  })
}

async function editImage(path) {
  return new Promise((resolve, reject) => wx.navigateTo({ url: '/pages/image-edit/image-edit',
    events: {
      imageEdited: result => result?.path ? resolve(result.path) : reject(new Error('未生成裁剪照片，请重试')),
      imageEditCancelled: () => reject(new Error('cancel'))
    },
    success: result => result.eventChannel.emit('imageSource', { path }), fail: reject }))
}

// 上传前再压一轮（仅对 jpg 生效），减小云存储与 CDN 流量占用；
// 压缩失败（如 png）静默回退原图
function compressImage(tempFilePath) {
  return new Promise(resolve => {
    wx.compressImage({
      src: tempFilePath,
      quality: 60,
      success: res => resolve(res.tempFilePath),
      fail: () => resolve(tempFilePath)
    })
  })
}

// 上传本地图片到云存储，返回 fileID
async function uploadImage(tempFilePath, directory = 'wardrobe') {
  const filePath = await compressImage(tempFilePath)
  const extMatch = filePath.match(/\.(jpe?g|png|webp|gif)$/i)
  const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg'
  const { cloudPath } = await call('prepareUpload', { directory, ext: ext.slice(1) })
  const res = await wx.cloud.uploadFile({ cloudPath, filePath: filePath })
  return res.fileID
}

// 贴纸封面图与作品照统一走 stickers 目录（封面/作品照之分体现在认领时的 target）
const uploadStickerImage = tempFilePath => uploadImage(tempFilePath, 'stickers')

// 清理任务在云端持久保存，失败可从个人页重试。
async function removeImage(fileID) {
  if (!fileID) return true
  try { return !(await call('removeImage', { fileID })).cleanupFailed } catch (e) {
    console.error('图片清理未完成', e)
    return false
  }
}

async function retryCleanup() {
  const result = await call('retryCleanup')
  clearCache()
  return result
}

const PAGE_SIZE = 20
const CACHE_TTL = 30000
const cache = {
  clothes: { version: 0, data: null, at: 0, promise: null },
  outfits: { version: 0, data: null, at: 0, promise: null },
  expenses: { version: 0, data: null, at: 0, promise: null },
  wear_records: { version: 0, data: null, at: 0, promise: null },
  outfit_plans: { version: 0, data: null, at: 0, promise: null },
  stickers: { version: 0, data: null, at: 0, promise: null },
  brands: { version: 0, data: null, at: 0, promise: null }
}

function invalidate(collection) {
  const state = cache[collection]
  state.version++
  state.data = null
  state.promise = null
  if (collection === 'clothes') invalidate('brands')
}

function clearCache() { for (const collection of Object.keys(cache)) invalidate(collection) }
const getWardrobeVersion = () => cache.clothes.version + cache.wear_records.version

async function listAll(collection) {
  const result = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await call('data', { operation: 'list', collection, offset })
    result.push(...res.data)
    if (res.data.length < PAGE_SIZE) return result
  }
}

function list(collection, force = false) {
  const state = cache[collection]
  if (force) invalidate(collection)
  if (state.data && Date.now() - state.at < CACHE_TTL) return Promise.resolve(state.data)
  if (state.promise) return state.promise
  const version = state.version
  const load = collection === 'brands' ? call('listBrands').then(result => result.brands) : listAll(collection)
  const promise = load.then(data => {
    if (version !== state.version) return list(collection)
    state.data = collection === 'clothes' ? data.map(normalizeItem) : data
    state.at = Date.now()
    return state.data
  }, error => {
    if (version !== state.version) return list(collection)
    throw error
  }).finally(() => { if (state.promise === promise) state.promise = null })
  state.promise = promise
  return promise
}

// ---------- 季节归一化与类别子类清理 ----------
const SEASON_MAP = {
  春: '春秋',
  秋: '春秋'
}

function normalizeItem(item) {
  const seasons = (item.seasons || []).map(s => SEASON_MAP[s] || s)
  return { ...item, subcategory: item.category === '配饰' ? item.subcategory || '' : '', seasons: [...new Set(seasons)] }
}

const listItems = (force = false) => list('clothes', force)
const listBrands = (force = false) => list('brands', force)
const listOutfits = (force = false) => list('outfits', force)
const listOutfitsPage = offset => call('data', { operation: 'list', collection: 'outfits', offset }).then(result => result.data)
const listExpenses = (force = false) => list('expenses', force)
const listWearRecords = (force = false) => list('wear_records', force)
const listPlans = (force = false) => list('outfit_plans', force)
// 贴纸全量缓存读取，心愿/库存/已拼贴由页面按 status 过滤（与衣橱同模式）
const listStickers = (force = false) => list('stickers', force)
const getItem = id => call('data', { operation: 'get', collection: 'clothes', id }).then(res => normalizeItem(res.data))
const getOutfit = id => call('data', { operation: 'get', collection: 'outfits', id }).then(res => res.data)
const getWearRecord = id => call('data', { operation: 'get', collection: 'wear_records', id }).then(res => res.data)

async function write(collection, operation, id, data, extra = {}) {
  try {
    return await call('data', { collection, operation, id, data, ...extra })
  } finally {
    invalidate(collection)
    if (collection === 'clothes' && operation === 'delete') invalidate('outfits')
    if (collection === 'outfits' && operation === 'delete') invalidate('outfit_plans')
  }
}

const addItem = (data, requestId) => write('clothes', 'add', undefined, data, requestId === undefined ? {} : { requestId }).then(res => res._id)
const updateItem = (id, data) => write('clothes', 'update', id, data)
const deleteItem = id => write('clothes', 'delete', id)
const addOutfit = (data, requestId) => write('outfits', 'add', undefined, data, requestId === undefined ? {} : { requestId }).then(res => res._id)
const updateOutfit = (id, data) => write('outfits', 'update', id, data)
const deleteOutfit = id => write('outfits', 'delete', id)
const addExpense = data => write('expenses', 'add', undefined, data).then(res => res._id)
const updateExpense = (id, data) => write('expenses', 'update', id, data)
const deleteExpense = id => write('expenses', 'delete', id)
const addWearRecord = data => write('wear_records', 'add', undefined, data).then(res => res._id)
const updateWearRecord = (id, data) => write('wear_records', 'update', id, data)
const deleteWearRecord = id => write('wear_records', 'delete', id)
const linkWearOutfit = (id, outfitId) => write('wear_records', 'linkOutfit', id, undefined, { outfitId })
const addPlan = (data, requestId) => write('outfit_plans', 'add', undefined, data, requestId === undefined ? {} : { requestId }).then(res => res._id)
const updatePlan = (id, data) => write('outfit_plans', 'update', id, data)
const deletePlan = id => write('outfit_plans', 'delete', id)
// 贴纸统计：实时聚合，不走列表缓存（与列表数据同源自洽）
const stickerStats = () => call('stickerStats').then(result => result.stats)
const addSticker = data => write('stickers', 'add', undefined, data).then(res => res._id)
const updateSticker = (id, data) => write('stickers', 'update', id, data)
const deleteSticker = id => write('stickers', 'delete', id)

// 通过已有接口读取可选字段，兼容尚未部署清理状态功能的云函数。
const cleanupStatus = () => call('profile').then(result => ({ pendingCleanup: result.profile && result.profile.pendingCleanup === true }))
// AI 对话助手：会话实时读取，不走全量列表缓存
const chatList = () => call('chatList').then(result => result.chats)
const chatGet = id => call('chatGet', { chatId: id }).then(result => result.chat)
function streamReply(ticket, onDelta) {
  return new Promise((resolve, reject) => {
    let buffer = '', binary = '', settled = false, httpStatus = 0, errorBody = ''
    const finish = (error, proof) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(proof)
    }
    const httpFailure = (status, raw = '') => {
      let detail = errorBody.trim()
      try {
        const parsed = JSON.parse(detail)
        detail = parsed.error || parsed.message || detail
      } catch (e) {}
      const fallback = status === 400 ? '请检查 chat-stream 的云环境和云端日志' : raw
      const error = new Error('流式服务返回 ' + status + (detail ? '：' + String(detail).slice(0, 200) : fallback ? '：' + fallback : ''))
      error.statusCode = status
      return error
    }
    const receive = data => {
      const bytes = new Uint8Array(data)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      let decoded
      try { decoded = decodeURIComponent(escape(binary)) } catch (e) { return }
      binary = ''
      if (httpStatus >= 400) {
        errorBody = (errorBody + decoded).slice(0, 2000)
        return
      }
      buffer += decoded
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = raw.split('\n')
        const kind = (lines.find(line => line.startsWith('event:')) || '').slice(6).trim()
        const dataLine = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
        if (!dataLine) continue
        let item
        try { item = JSON.parse(dataLine) } catch (e) { finish(new Error('流式响应格式无效')); return }
        if (kind === 'delta' && typeof item.text === 'string') {
          try { onDelta(item.text) } catch (error) { finish(error); return }
        }
        else if (kind === 'done' && item.proof) finish(null, item.proof)
        else if (kind === 'error') finish(new Error(item.message || '流式回复失败'))
      }
      if (buffer.length > 200000) finish(new Error('流式响应过大'))
    }
    wx.cloud.callHTTPFunction({ name: 'chat-stream', config: { env: CLOUD_ENV }, path: '/', method: 'POST',
      header: { 'Content-Type': 'application/json' }, data: { ticket }, enableChunked: true,
      onHeadersReceived: res => { httpStatus = res.statusCode || 0 },
      onChunkedReceived: res => { if (!settled) receive(res.data) },
      success: res => {
        if (httpStatus >= 400 || res.statusCode >= 400) finish(httpFailure(httpStatus || res.statusCode))
        else if (!settled) finish(new Error('流式回复未完成'))
      },
      fail: error => {
        const raw = error && (error.errMsg || error.message || '')
        const status = httpStatus || Number(error && (error.statusCode || error.status || (String(raw).match(/\b(4\d\d|5\d\d)\b/) || [])[1]))
        console.error('chat-stream 调用失败', { status, httpStatus, error })
        finish(status >= 400 ? httpFailure(status, raw) : new Error(raw || '流式服务连接失败'))
      } })
  })
}

async function chatSend(payload, onDelta = () => {}) {
  const version = getWardrobeVersion()
  const ensureCurrent = () => {
    if (version !== getWardrobeVersion()) throw new Error('衣橱已更新，请重新发送')
  }
  const resultOf = result => {
    ensureCurrent()
    return { chatId: result.chatId, title: result.title, messages: result.messages }
  }
  if (!payload.imageFileID) {
    if (typeof wx.cloud.callHTTPFunction !== 'function') throw new Error('当前基础库不支持流式对话，请更新微信')
    const start = await call('chatStart', payload)
    try {
      ensureCurrent()
      if (start.messages) return resultOf(start)
      if (typeof start.ticket !== 'string' || !start.ticket) throw new Error('流式凭证签发失败')
      const proof = await streamReply(start.ticket, delta => { ensureCurrent(); onDelta(delta) })
      ensureCurrent()
      const result = await call('chatFinish', { proof })
      return resultOf(result)
    } catch (e) {
      if (start.ticket) {
        try { await call('chatCancel', { ticket: start.ticket }) } catch (cancelError) { console.error('释放流式会话失败', cancelError) }
      }
      e.chatId = start.chatId || ''
      e.chatTitle = start.title || ''
      throw e
    }
  }
  return resultOf(await call('chatSend', payload))
}
const chatDelete = id => call('chatDelete', { chatId: id })
const chatRename = (id, title) => call('chatRename', { chatId: id, title })
const purchaseAssess = candidate => call('purchaseAssess', { candidate }).then(result => result.assessment)
const purchaseVisual = (candidate, imageFileID) => call('purchaseVisual', { candidate, imageFileID }).then(result => result.visualReview)
const itemScan = imageFileID => call('itemScan', { imageFileID }).then(result => result.item)
const subscribeReport = () => call('subscribeReport')
const subscribeWeather = () => call('subscribeWeather')
const cancelReport = () => call('cancelReport')
const cancelWeather = () => call('cancelWeather')
const getSubscriptionStatus = () => call('subscriptionStatus')
const getWeatherRecommendation = date => call('weatherRecommendation', { date }).then(result => result.recommendation)

// 天气提醒云函数（城市设置等），与 auth 分离部署，错误处理同构
function callWeather(data) {
  return wx.cloud.callFunction({ name: 'weather-alert', data }).then(res => {
    if (!res.result || !res.result.success) {
      const error = new Error(res.result && res.result.error || '服务暂不可用')
      console.error('weather-alert 调用失败', { requestID: res.requestID, message: error.message })
      throw error
    }
    return res.result
  })
}
const setCity = cityName => callWeather({ action: 'setCity', cityName })
const setCityByLocation = (longitude, latitude) => callWeather({ action: 'setCityByLocation', longitude, latitude })
const dailyRecommendation = (data = {}) => callWeather({ ...data, action: 'dailyRecommendation' })
const backupInfo = () => call('backupInfo')
const backupExport = (collection, offset) => call('backupExport', { collection, offset }).then(result => result.records)
const backupValidate = (source, records) => call('backupValidate', { source, records })
const prepareBackupImage = (directory, ext) => call('prepareUpload', { directory, ext })
async function backupRestore(source, records, images) {
  try { return await call('backupRestore', { source, records, images }) } finally { clearCache() }
}

module.exports = { chooseImage, editImage, uploadImage, uploadStickerImage, removeImage, retryCleanup, cleanupStatus, clearCache, getWardrobeVersion,
  backupInfo, backupExport, backupValidate, backupRestore, prepareBackupImage,
  listItems, listBrands, getItem, addItem, updateItem, deleteItem, listOutfits, listOutfitsPage, getOutfit, addOutfit, updateOutfit, deleteOutfit,
  listExpenses, addExpense, updateExpense, deleteExpense,
  listWearRecords, getWearRecord, addWearRecord, updateWearRecord, deleteWearRecord, linkWearOutfit,
  listPlans, addPlan, updatePlan, deletePlan,
  listStickers, stickerStats, addSticker, updateSticker, deleteSticker,
  chatList, chatGet, chatSend, chatDelete, chatRename, purchaseAssess, purchaseVisual, itemScan, subscribeReport, subscribeWeather, cancelReport, cancelWeather, getSubscriptionStatus, getWeatherRecommendation, dailyRecommendation, setCity, setCityByLocation }
