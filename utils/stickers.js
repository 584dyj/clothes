// 贴纸开销口径（客户端读取侧）：与 cloudfunctions/auth/stickers.js 同规则，两处同步修改。
// 库存 = owned + done；线条金额 = 单价 × 数量，缺 price 按 0、缺 quantity 按 1；心愿单不计。

const isStocked = row => row && (row.status === 'owned' || row.status === 'done')

function lineTotal(row) {
  const price = Number.isFinite(row.price) ? row.price : 0
  const quantity = Number.isInteger(row.quantity) && row.quantity > 0 ? row.quantity : 1
  return price * quantity
}

module.exports = { isStocked, lineTotal }
