import { describe, expect, it } from 'vitest'
import { detectFormat } from './comfy-parse'

describe('detectFormat', () => {
  it('识别 UI/graph 格式', () => {
    expect(detectFormat({ nodes: [], links: [], version: 0.4 })).toBe('graph')
  })

  it('识别 API 格式', () => {
    expect(
      detectFormat({
        '1': { class_type: 'KSampler', inputs: {} },
        '2': { class_type: 'SaveImage', inputs: {} },
      }),
    ).toBe('api')
  })

  it('其它 JSON 为 unknown', () => {
    expect(detectFormat({ foo: 1 })).toBe('unknown')
    expect(detectFormat([])).toBe('unknown')
    expect(detectFormat(null)).toBe('unknown')
    expect(detectFormat({})).toBe('unknown')
    expect(detectFormat({ '1': { inputs: {} } })).toBe('unknown') // 缺 class_type
  })
})
