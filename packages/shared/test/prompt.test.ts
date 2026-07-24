import { describe, expect, it } from 'vitest'
import { buildPrompt, type ParamDef } from '../src/index.js'

const comfyJson = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['4', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
}
const params: ParamDef[] = [
  { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' },
  { key: 'seed', label: 'Seed', nodeId: '3', inputName: 'seed', type: 'seed' },
]

describe('buildPrompt', () => {
  it('injects values into the right node inputs', () => {
    const out = buildPrompt(comfyJson, params, { prompt: 'a cat', seed: '42' })
    expect(out['6'].inputs.text).toBe('a cat')
    expect(out['3'].inputs.seed).toBe(42) // seed 强制为 number
    expect(out['3'].inputs.steps).toBe(20) // 其他输入不动
  })

  it('does not mutate the template json', () => {
    buildPrompt(comfyJson, params, { prompt: 'x', seed: 1 })
    expect(comfyJson['6'].inputs.text).toBe('old')
  })

  it('falls back to default value', () => {
    const withDefault: ParamDef[] = [{ ...params[0]!, default: 'dft' }]
    const out = buildPrompt(comfyJson, withDefault, {})
    expect(out['6'].inputs.text).toBe('dft')
  })

  it('throws on missing value without default', () => {
    expect(() => buildPrompt(comfyJson, params, { prompt: 'x' })).toThrow(
      'missing value for param "seed"',
    )
  })

  it('throws when node id is absent', () => {
    const bad: ParamDef[] = [{ ...params[0]!, nodeId: '99' }]
    expect(() => buildPrompt(comfyJson, bad, { prompt: 'x' })).toThrow(
      'node 99 not found for param "prompt"',
    )
  })
})
