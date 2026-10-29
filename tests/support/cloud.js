const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createRequire } = require('node:module')

// 只模拟本项目调用的接口；串行事务检查提交与回滚，真实冲突重试仍需云端验收。
function loadCloud(records = {}) {
  let openid = 'openid-1', sequence = 0, chain = Promise.resolve()
  const calls = [], deletedFiles = [], downloads = [], sentMessages = []
  const faults = { before: null, deleteStatus: 0, download: null, send: null }
  for (const name of ['users', 'invite_codes', 'auth_attempts', 'clothes', 'outfits', 'upload_tickets', 'cleanup_jobs', 'expenses', 'wear_records', 'outfit_plans', 'ai_chats', 'wardrobe_meta', 'ai_cache', 'subscriptions', 'stickers']) records[name] ||= []
  const clone = value => structuredClone(value)
  const command = { all: values => ({ all: values }), pull: value => ({ pull: value }), remove: () => ({ remove: true }),
    gt: value => ({ gt: value }), gte: value => ({ gte: value }), in: values => ({ in: values }) }
  function collection(name) {
    let conditions = {}, offset = 0, max = Infinity
    const matches = row => Object.entries(conditions).every(([key, value]) => {
      if (value && value.all) return value.all.every(id => (row[key] || []).includes(id))
      if (value && value.gt !== undefined) return row[key] > value.gt
      if (value && value.gte !== undefined) return row[key] >= value.gte
      if (value && value.in) return value.in.includes(row[key])
      return row[key] === value
    })
    function before(operation, id) {
      calls.push({ collection: name, operation, id, offset, max })
      if (faults.before) faults.before(name, operation, id)
    }
    function unique(id, data) {
      for (const key of name === 'users' ? ['username', 'openid'] : name === 'invite_codes' ? ['code'] : name === 'auth_attempts' ? ['key'] : []) {
        if (data[key] !== undefined && records[name].some(row => row._id !== id && row[key] === data[key])) throw new Error('E11000 duplicate')
      }
    }
    const api = {
      aggregate() {
        const stages = [], pipeline = {}
        for (const stage of ['match', 'group', 'sort', 'skip', 'limit']) pipeline[stage] = value => {
          stages.push({ [stage]: value }); return pipeline
        }
        pipeline.end = async () => {
          before('aggregate')
          calls[calls.length - 1].stages = clone(stages)
          let rows = clone(records[name])
          for (const stage of stages) {
            if (stage.match) rows = rows.filter(row => Object.entries(stage.match).every(([key, value]) => row[key] === value))
            if (stage.group) {
              const field = stage.group._id.slice(1)
              rows = [...new Map(rows.map(row => {
                const value = row[field] ?? null
                return [JSON.stringify(value), { _id: value }]
              })).values()]
            }
            if (stage.sort) rows.sort((a, b) => {
              for (const [key, order] of Object.entries(stage.sort)) {
                if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * order
              }
              return 0
            })
            if (stage.skip !== undefined) rows = rows.slice(stage.skip)
            if (stage.limit !== undefined) rows = rows.slice(0, stage.limit)
          }
          return { list: rows }
        }
        return pipeline
      },
      where(value) { conditions = value; return this },
      orderBy() { return this },
      skip(value) { offset = value; return this },
      limit(value) { max = value; return this },
      async get() { before('get'); return { data: clone(records[name].filter(matches).slice(offset, offset + max)) } },
      async add({ data }) {
        const id = data._id || 'generated-' + ++sequence
        if (records[name].some(row => row._id === id)) throw new Error('E11000 duplicate')
        await api.doc(id).set({ data })
        return { _id: id }
      },
      doc(id) {
        return {
          async get() { before('doc.get', id); return { data: clone(records[name].find(row => row._id === id) || null) } },
          async set({ data }) {
            before('set', id); unique(id, data)
            const index = records[name].findIndex(row => row._id === id)
            const row = { ...clone(data), _id: id }
            if (index < 0) records[name].push(row)
            else records[name][index] = row
            return { _id: id }
          },
          async update({ data }) {
            before('update', id)
            const row = records[name].find(row => row._id === id)
            if (!row) return { stats: { updated: 0 } }
            unique(id, { ...row, ...data })
            for (const [key, value] of Object.entries(data)) {
              if (value && Object.hasOwn(value, 'remove')) delete row[key]
              else row[key] = value && Object.hasOwn(value, 'pull') ? (row[key] || []).filter(id => id !== value.pull) : clone(value)
            }
            return { stats: { updated: 1 } }
          },
          async remove() { before('remove', id); records[name] = records[name].filter(row => row._id !== id); return { stats: { removed: 1 } } }
        }
      }
    }
    return api
  }
  const db = {
    collection, command, serverDate: () => new Date(),
    runTransaction(fn) {
      const next = chain.then(async () => {
        const snapshot = clone(records)
        try { return await fn(db) } catch (e) { Object.assign(records, snapshot); throw e }
      })
      chain = next.catch(() => {})
      return next
    }
  }
  const cloud = {
    init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }),
    openapi: { subscribeMessage: { async send(data) {
      if (typeof faults.send === 'function') await faults.send(data)
      else if (faults.send) throw faults.send
      sentMessages.push(clone(data))
      return { errCode: 0 }
    } } },
    async deleteFile({ fileList }) {
      if (!faults.deleteStatus) deletedFiles.push(...fileList)
      return { fileList: fileList.map(fileID => ({ fileID, status: faults.deleteStatus })) }
    },
    async downloadFile({ fileID }) {
      downloads.push(fileID)
      if (typeof faults.download === 'function') {
        const result = await faults.download(fileID)
        if (result) return result
      } else if (faults.download) throw faults.download
      return { fileContent: Buffer.from('fake-image-bytes') }
    }
  }
  const file = path.resolve(__dirname, '../../cloudfunctions/auth/index.js')
  const exported = {}, localRequire = createRequire(file)
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: { exports: exported }, exports: exported,
    __filename: file, __dirname: path.dirname(file),
    require: name => name === 'wx-server-sdk' ? cloud : localRequire(name),
    console: { error() {} }, Buffer, Date
  }, { filename: file })
  return { main: exported.main, db, records, calls, deletedFiles, downloads, sentMessages, faults, setOpenid(value) { openid = value }, cloudService: cloud }
}

module.exports = { loadCloud }
