// 云开发环境 ID 单点配置：客户端所有指向云环境的调用统一从这里取。
// 迁移到新环境时只需修改此处一处；云函数内部用 DYNAMIC_CURRENT_ENV，不依赖此值。
const CLOUD_ENV = 'cloud1-d3gxekd39e66fd769'

module.exports = { CLOUD_ENV }
