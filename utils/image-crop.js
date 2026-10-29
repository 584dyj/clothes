const WIDTH = 960, HEIGHT = 1280

function minimumScale(crop) {
  const sideways = crop.rotation % 180 !== 0
  return Math.max(WIDTH / (sideways ? crop.height : crop.width), HEIGHT / (sideways ? crop.width : crop.height))
}

function clampCrop(crop) {
  const minimum = minimumScale(crop)
  const scale = Math.max(minimum, Math.min(minimum * 8, crop.scale))
  const sideways = crop.rotation % 180 !== 0
  const halfWidth = (sideways ? crop.height : crop.width) * scale / 2
  const halfHeight = (sideways ? crop.width : crop.height) * scale / 2
  return { ...crop, scale, x: Math.max(WIDTH - halfWidth, Math.min(halfWidth, crop.x)),
    y: Math.max(HEIGHT - halfHeight, Math.min(halfHeight, crop.y)) }
}

function createCrop(width, height) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('照片尺寸无效')
  return clampCrop({ width, height, rotation: 0, scale: 0, x: WIDTH / 2, y: HEIGHT / 2 })
}

function zoomCrop(crop, factor, from = { x: WIDTH / 2, y: HEIGHT / 2 }, to = from) {
  const scale = clampCrop({ ...crop, scale: crop.scale * factor }).scale
  const ratio = scale / crop.scale
  return clampCrop({ ...crop, scale, x: to.x + (crop.x - from.x) * ratio, y: to.y + (crop.y - from.y) * ratio })
}

function rotateCrop(crop) {
  const next = { ...crop, rotation: (crop.rotation + 90) % 360, x: WIDTH / 2, y: HEIGHT / 2 }
  return clampCrop({ ...next, scale: minimumScale(next) * crop.scale / minimumScale(crop) })
}

module.exports = { WIDTH, HEIGHT, createCrop, clampCrop, zoomCrop, rotateCrop }
