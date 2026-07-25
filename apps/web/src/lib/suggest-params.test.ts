import { describe, expect, it } from 'vitest'
import { suggestParams } from './suggest-params'

const txt2img = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 42, steps: 4, positive: ['6', 0], negative: ['7', 0], model: ['4', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
}

describe('suggestParams', () => {
  it('通过采样器连线区分正负提示词', () => {
    const out = suggestParams(txt2img)
    expect(out).toContainEqual({ nodeId: '6', inputName: 'text', key: 'prompt', type: 'text' })
    expect(out).toContainEqual({ nodeId: '7', inputName: 'text', key: 'negative_prompt', type: 'text' })
  })

  it('预选 seed', () => {
    expect(suggestParams(txt2img)).toContainEqual({
      nodeId: '3', inputName: 'seed', key: 'seed', type: 'seed',
    })
  })

  it('同一编码节点被两个采样器共享时不重复', () => {
    const json = {
      ...txt2img,
      '10': {
        class_type: 'KSamplerAdvanced',
        inputs: { noise_seed: 1, positive: ['6', 0], negative: ['7', 0] },
      },
    }
    const out = suggestParams(json)
    expect(out.filter((p) => p.nodeId === '6' && p.inputName === 'text')).toHaveLength(1)
    // 两个 seed 输入,key 去重
    const seedKeys = out.filter((p) => p.type === 'seed').map((p) => p.key)
    expect(new Set(seedKeys).size).toBe(seedKeys.length)
  })

  it('两组独立正提示词时 key 加后缀', () => {
    const json = {
      '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'y' } },
      '4': { class_type: 'KSampler', inputs: { positive: ['5', 0], negative: ['3', 0] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'z' } },
    }
    const keys = suggestParams(json).map((p) => p.key)
    expect(keys).toContain('prompt')
    expect(keys).toContain('prompt_2')
    expect(keys.filter((k) => k.startsWith('negative_prompt'))).toHaveLength(1)
  })

  it('无采样器/无 seed 时返回空数组', () => {
    expect(suggestParams({ '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } } })).toEqual([])
  })
})
