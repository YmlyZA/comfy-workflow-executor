import { describe, expect, it } from 'vitest'
import { paramDefSchema, paramTypeSchema } from '../src/index.js'

describe('paramDefSchema enum 支持', () => {
  it('paramTypeSchema 接受 enum', () => {
    expect(paramTypeSchema.parse('enum')).toBe('enum')
  })

  it('接受带 enumRef 的 enum 参数', () => {
    const def = paramDefSchema.parse({
      key: 'ckpt',
      label: 'ckpt',
      nodeId: '4',
      inputName: 'ckpt_name',
      type: 'enum',
      enumRef: { classType: 'CheckpointLoaderSimple', inputName: 'ckpt_name' },
      default: 'a.safetensors',
    })
    expect(def.enumRef?.classType).toBe('CheckpointLoaderSimple')
  })

  it('enumRef 可省略(旧数据兼容)', () => {
    const def = paramDefSchema.parse({
      key: 'p', label: 'p', nodeId: '6', inputName: 'text', type: 'text',
    })
    expect(def.enumRef).toBeUndefined()
  })

  it('拒绝空 classType 的 enumRef', () => {
    expect(() =>
      paramDefSchema.parse({
        key: 'k', label: 'k', nodeId: '1', inputName: 'x', type: 'enum',
        enumRef: { classType: '', inputName: 'x' },
      }),
    ).toThrow()
  })
})
