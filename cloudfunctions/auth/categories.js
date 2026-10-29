const CATEGORIES = ['外套', '马甲', '短袖', '长袖', '衬衫', '羽绒服', '保暖衣', '毛衣', '家居服', '连衣裙', '长裙', '短裙', '长裤', '短裤', '配饰', '挂件', '包袋', '鞋', '其他']
const ACCESSORY_TYPES = ['袜子', '帽子', '围巾', '首饰', '其他']
// ponytail: 基础类别资格，挂件等场景限制由推荐调用方继续校验。
const isRecommendable = item => !!item && CATEGORIES.includes(item.category) && item.category !== '其他'

// 搭配角色：冻结规则见 docs/衣物类别扩展开发tickets.md 第 5.1 节。
// 家居服可参与推荐但不计入 top/bottom/dress 结构；其他与未知类别无推荐角色。
const ROLES = {
  短袖: 'top', 长袖: 'top', 衬衫: 'top', 保暖衣: 'top', 毛衣: 'top',
  外套: 'outer', 羽绒服: 'outer',
  马甲: 'layer',
  长裙: 'bottom', 短裙: 'bottom', 长裤: 'bottom', 短裤: 'bottom',
  连衣裙: 'dress',
  家居服: 'homewear',
  配饰: 'accessory', 挂件: 'charm', 包袋: 'bag', 鞋: 'shoes'
}
const roleOf = category => ROLES[category] || 'none'

module.exports = { CATEGORIES, ACCESSORY_TYPES, isRecommendable, ROLES, roleOf }
