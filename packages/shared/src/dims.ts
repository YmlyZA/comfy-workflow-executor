export interface ImageDims {
  width: number
  height: number
}

/** 就近取整到 8 的倍数,下限 8(SD 系 latent 约束) */
export function round8(n: number): number {
  return Math.max(8, Math.round(n / 8) * 8)
}

/** 按源图比例由一维算另一维;驱动侧原样保留,计算维取整到 8 */
export function computeLockedDim(
  source: ImageDims,
  driver: 'width' | 'height',
  value: number,
): ImageDims {
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('source dims must be positive')
  }
  if (driver === 'width') {
    return { width: value, height: round8((value * source.height) / source.width) }
  }
  return { width: round8((value * source.width) / source.height), height: value }
}

/** 跟随源图:两维就近取整到 8;超过最长边上限时先等比缩到上限(取整后允许 ≤4px 溢出) */
export function fitSource(source: ImageDims, maxEdge?: number): ImageDims {
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('source dims must be positive')
  }
  const longest = Math.max(source.width, source.height)
  const scale = maxEdge && maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1
  return { width: round8(source.width * scale), height: round8(source.height * scale) }
}
