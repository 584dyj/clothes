const { CLOUD_ENV } = require('./utils/config')

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }
    wx.cloud.init({
      env: CLOUD_ENV,
      traceUser: true
    })
  },

  globalData: {
    categories: ['外套', '短袖', '长袖', '衬衫', '羽绒服', '保暖衣', '毛衣', '家居服', '连衣裙', '长裙', '短裙', '长裤', '短裤', '配饰', '挂件', '包袋', '鞋', '其他'],
    accessoryTypes: ['袜子', '帽子', '围巾', '首饰', '其他'],  // 配饰的二级分类
    seasons: ['春秋', '夏', '冬'],
    sizes: ['XS', 'S', 'M', 'L', 'XL', 'F'],
    expenseCategories: ['服饰', '鞋包', '洗护', '修改', '其他'],  // 独立账本分类，与云端校验一致
    occasions: ['日常', '通勤', '约会', '运动', '旅行', '正式'],
    colors: ['白色', '黑色', '灰色', '米色', '卡其', '棕色', '红色', '粉色', '橙色', '黄色', '绿色', '蓝色', '藏青', '紫色', '牛仔蓝', '花色']
  }
})
