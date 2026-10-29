const COLLECTIONS = ['clothes', 'outfits', 'expenses', 'wear_records', 'outfit_plans', 'stickers']
const LABELS = ['衣物', '穿搭', '账本', '实穿', '计划', '贴纸']
const FORMAT = 'clothes-backup'
const CHUNK = 64 * 1024
const IMAGE_FIELDS = ['imageFileID', 'doneImageFileID']
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const imageIds = records => [...new Set(records.flatMap(row => IMAGE_FIELDS.map(field => row.data[field]).filter(Boolean)))]

function createBackup({ wx, db, progress = () => {} }) {
  const fs = wx.getFileSystemManager()
  const invoke = (target, method, options) => new Promise((resolve, reject) => target[method]({ ...options,
    success: resolve, fail: error => reject(new Error(error.errMsg || error.message || '文件操作失败')) }))
  const file = (method, options) => invoke(fs, method, options)
  const info = path => file('getFileInfo', { filePath: path, digestAlgorithm: 'md5' })
  const temp = suffix => `${wx.env.USER_DATA_PATH}/clothes-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.${suffix}`
  const unlink = async path => { try { await file('unlink', { filePath: path }) } catch (e) {} }
  const append = (path, value) => file('appendFile', { filePath: path, data: JSON.stringify(value) + '\n', encoding: 'utf8' })

  async function* lines(path, size) {
    let buffer = ''
    for (let position = 0; position < size; position += CHUNK) {
      const { data } = await file('readFile', { filePath: path, position, length: Math.min(CHUNK, size - position) })
      const bytes = new Uint8Array(data)
      for (let index = 0; index < bytes.length; index += 8192) buffer += String.fromCharCode(...bytes.subarray(index, index + 8192))
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.length > 1024 * 1024) throw new Error('备份单行过大或格式损坏')
        if (line.trim()) yield JSON.parse(decodeURIComponent(escape(line)))
      }
      // ponytail: 每行最多 1 MiB；图片分块存储，大图片不需要放宽此限制。
      if (buffer.length > 1024 * 1024) throw new Error('备份单行过大或格式损坏')
    }
    if (buffer.trim()) yield JSON.parse(decodeURIComponent(escape(buffer)))
  }

  async function exportBackup() {
    const path = temp('jsonl'), assets = new Map(), counts = Object.fromEntries(COLLECTIONS.map(key => [key, 0]))
    const { source } = await db.backupInfo()
    await file('writeFile', { filePath: path, data: '', encoding: 'utf8' })
    try {
      await append(path, { format: FORMAT, version: 1, source, exportedAt: new Date().toISOString() })
      for (const [index, collection] of COLLECTIONS.entries()) {
        for (let offset = 0; ; offset += 20) {
          progress(`导出${LABELS[index]}：${counts[collection]}条`)
          const records = await db.backupExport(collection, offset)
          for (const row of records) {
            await append(path, { type: 'record', ...row })
            counts[collection]++
            for (const id of imageIds([row])) {
              const match = typeof id === 'string' && id.match(/^cloud:\/\/.+\.(jpg|jpeg|png|webp|gif)$/i)
              if (!match) throw new Error('存在无法打包的图片，请先核对衣物或贴纸图片')
              assets.set(id, match[1].toLowerCase())
            }
          }
          if (records.length < 20) break
        }
      }
      let completed = 0
      for (const [id, ext] of assets) {
        progress(`打包图片：${++completed}/${assets.size}`)
        const { tempFilePath } = await invoke(wx.cloud, 'downloadFile', { fileID: id })
        try {
          const { size, digest } = await info(tempFilePath)
          await append(path, { type: 'asset', id, ext, size, digest, directory: id.includes('/stickers/') ? 'stickers' : 'wardrobe' })
          for (let position = 0; position < size; position += CHUNK) {
            const { data } = await file('readFile', { filePath: tempFilePath, position, length: Math.min(CHUNK, size - position) })
            await append(path, { type: 'chunk', data: wx.arrayBufferToBase64(data) })
          }
          await append(path, { type: 'assetEnd' })
        } finally { await unlink(tempFilePath) }
      }
      await append(path, { type: 'end', counts, assets: assets.size })
      return { path, counts, images: assets.size }
    } catch (error) { await unlink(path); throw error }
  }

  async function inspectBackup(path) {
    const records = [], assets = new Map(), paths = [], seen = new Set()
    const counts = Object.fromEntries(COLLECTIONS.map(key => [key, 0]))
    let header, active, ended = false, checked = 0, assetsStarted = false
    const snapshot = await info(path)
    const validate = async () => {
      while (checked < records.length) {
        const batch = records.slice(checked, checked + 20)
        const { existing } = await db.backupValidate(header.source, batch)
        batch.forEach((row, index) => { row.existing = existing[index] })
        checked += batch.length
        progress(`校验记录：${checked}条`)
      }
    }
    try {
      for await (const line of lines(path, snapshot.size)) {
        if (!header) {
          if (line.format !== FORMAT || line.version !== 1 || !/^[a-f0-9]{64}$/.test(line.source || '')) throw new Error('不支持的备份格式或版本')
          header = line; continue
        }
        if (ended) throw new Error('备份结束标记后仍有数据')
        if (line.type === 'record') {
          if (assetsStarted || !COLLECTIONS.includes(line.collection) || !line.data || typeof line.data !== 'object') throw new Error('备份记录格式无效')
          const key = `${line.collection}:${line.id}`
          if (seen.has(key)) throw new Error('备份中存在重复记录 ID')
          seen.add(key); records.push(line); counts[line.collection]++
          if (records.length - checked >= 20) await validate()
        } else if (line.type === 'asset') {
          await validate(); assetsStarted = true
          if (active || assets.has(line.id) || typeof line.id !== 'string' || !line.id.startsWith('cloud://') ||
              !EXTENSIONS.includes(line.ext) || !['wardrobe', 'stickers'].includes(line.directory) ||
              !Number.isSafeInteger(line.size) || line.size < 0 || !/^[a-f0-9]{32}$/.test(line.digest || '')) throw new Error('备份图片信息无效')
          active = { ...line, path: temp(line.ext), written: 0 }
          paths.push(active.path)
          await file('writeFile', { filePath: active.path, data: '', encoding: 'utf8' })
        } else if (line.type === 'chunk') {
          if (!active || typeof line.data !== 'string' || line.data.length > 100000 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(line.data)) throw new Error('备份图片分块无效')
          const data = wx.base64ToArrayBuffer(line.data)
          active.written += data.byteLength
          if (active.written > active.size) throw new Error('备份图片长度不符')
          await file('appendFile', { filePath: active.path, data })
        } else if (line.type === 'assetEnd') {
          if (!active) throw new Error('备份图片结束标记无效')
          const actual = await info(active.path)
          if (active.written !== active.size || actual.digest !== active.digest) throw new Error('备份图片校验失败')
          assets.set(active.id, active); active = null
          progress(`校验图片：${assets.size}张`)
        } else if (line.type === 'end') {
          await validate()
          if (active || line.assets !== assets.size || COLLECTIONS.some(key => line.counts?.[key] !== counts[key])) throw new Error('备份未完整导出或数量不符')
          ended = true
        } else throw new Error('备份包含未知数据类型')
      }
      if (!ended) throw new Error('备份不完整，缺少结束标记')
      if (imageIds(records).some(id => !assets.has(id))) throw new Error('备份缺少记录引用的图片')
      if ((await info(path)).digest !== snapshot.digest) throw new Error('备份文件在校验期间发生变化')
      return { header, records, assets, counts, cleanup: () => Promise.all(paths.map(unlink)) }
    } catch (error) { await Promise.all(paths.map(unlink)); throw error }
  }

  async function restoreBackup(archive) {
    const uploaded = new Map(), pendingImages = new Set()
    let restored = 0, skipped = 0
    try {
      const needed = imageIds(archive.records.filter(row => !row.existing))
      for (const [index, original] of needed.entries()) {
        progress(`上传图片：${index + 1}/${needed.length}`)
        const asset = archive.assets.get(original)
        const { cloudPath } = await db.prepareBackupImage(asset.directory, asset.ext)
        const { fileID } = await invoke(wx.cloud, 'uploadFile', { cloudPath, filePath: asset.path })
        uploaded.set(original, fileID)
        pendingImages.add(fileID)
      }
      for (let offset = 0; offset < archive.records.length; offset += 20) {
        const records = archive.records.slice(offset, offset + 20)
        const images = Object.fromEntries(imageIds(records).filter(id => uploaded.has(id)).map(id => [id, uploaded.get(id)]))
        const result = await db.backupRestore(archive.header.source, records, images)
        restored += result.restored; skipped += result.skipped
        for (const fileID of result.images) pendingImages.delete(fileID)
        progress(`恢复记录：${offset + records.length}/${archive.records.length}`)
      }
      return { restored, skipped }
    } catch (error) {
      throw new Error(`恢复未完成，已确认新增${restored}条；可重新选择同一备份重试。${error.message}`)
    } finally {
      // 已关联图片由上传票据保护；仅清理未提交或因跳过记录而未使用的上传。
      for (const id of pendingImages) await db.removeImage(id)
    }
  }

  return { exportBackup, inspectBackup, restoreBackup, removeFile: unlink }
}

module.exports = { createBackup, COLLECTIONS }
