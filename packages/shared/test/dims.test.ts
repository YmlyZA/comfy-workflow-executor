import { describe, expect, it } from 'vitest'
import { computeLockedDim, fitSource, round8 } from '../src/dims.js'

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

describe('fitSource', () => {
  it('无上限:两维就近取整到 8', () => {
    expect(fitSource({ width: 2050, height: 1365 })).toEqual({ width: 2048, height: 1368 })
  })
  it('恰好等于上限不缩放', () => {
    expect(fitSource({ width: 1024, height: 768 }, 1024)).toEqual({ width: 1024, height: 768 })
  })
  it('超限横图等比缩到上限', () => {
    expect(fitSource({ width: 4000, height: 3000 }, 1024)).toEqual({ width: 1024, height: 768 })
  })
  it('超限竖图等比缩到上限', () => {
    expect(fitSource({ width: 3000, height: 4000 }, 1024)).toEqual({ width: 768, height: 1024 })
  })
  it('方图超限', () => {
    expect(fitSource({ width: 2048, height: 2048 }, 512)).toEqual({ width: 512, height: 512 })
  })
  it('极端长宽比:计算维下限 8', () => {
    expect(fitSource({ width: 4096, height: 16 }, 1024)).toEqual({ width: 1024, height: 8 })
  })
  it('上限非 8 倍数:允许 ≤4px 溢出', () => {
    expect(fitSource({ width: 2060, height: 2060 }, 1030)).toEqual({ width: 1032, height: 1032 })
  })
  it('maxEdge 非正视为未提供', () => {
    expect(fitSource({ width: 100, height: 50 }, 0)).toEqual({ width: 104, height: 48 })
    expect(fitSource({ width: 100, height: 50 }, -5)).toEqual({ width: 104, height: 48 })
  })
  it('源图尺寸非正数抛错', () => {
    expect(() => fitSource({ width: 0, height: 100 })).toThrow()
  })
})
