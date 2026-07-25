import { describe, expect, it } from 'vitest'
import { computeLockedDim, round8 } from '../src/dims.js'

describe('round8', () => {
  it('就近取整到 8 的倍数', () => {
    expect(round8(680)).toBe(680)
    expect(round8(682.5)).toBe(680)
    expect(round8(684)).toBe(688)
  })
  it('下限 8', () => {
    expect(round8(1)).toBe(8)
    expect(round8(0)).toBe(8)
  })
})

describe('computeLockedDim', () => {
  it('按宽定高:横图', () => {
    expect(computeLockedDim({ width: 2048, height: 1365 }, 'width', 1024)).toEqual({
      width: 1024,
      height: 680,
    })
  })
  it('按高定宽:竖图', () => {
    expect(computeLockedDim({ width: 768, height: 1024 }, 'height', 512)).toEqual({
      width: 384,
      height: 512,
    })
  })
  it('方图两个方向一致', () => {
    expect(computeLockedDim({ width: 512, height: 512 }, 'width', 1024)).toEqual({
      width: 1024,
      height: 1024,
    })
  })
  it('驱动侧不取整,计算维取整', () => {
    const r = computeLockedDim({ width: 1000, height: 500 }, 'width', 1001)
    expect(r.width).toBe(1001)
    expect(r.height).toBe(round8(500.5))
  })
  it('极端比例计算维不低于 8', () => {
    expect(computeLockedDim({ width: 4096, height: 64 }, 'width', 64).height).toBe(8)
  })
  it('源图尺寸非正数抛错', () => {
    expect(() => computeLockedDim({ width: 0, height: 100 }, 'width', 512)).toThrow()
  })
})
