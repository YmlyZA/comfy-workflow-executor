import { describe, expect, it } from 'vitest'
import type { ParamDef } from '@cwe/shared'
import { imageParamsOf, imageParamValue } from './image-params'

const def = (over: Partial<ParamDef>): ParamDef => ({
  key: 'img',
  label: '图',
  nodeId: '1',
  inputName: 'image',
  type: 'image',
  ...over,
})

describe('imageParamsOf', () => {
  it('无 image 类型参数返回空', () => {
    expect(imageParamsOf([def({ type: 'text' })], { img: 'a.png' })).toEqual([])
  })

  it('值为空串不算可对比', () => {
    expect(imageParamsOf([def({})], { img: '' })).toEqual([])
  })

  it('值缺失回退 default', () => {
    const d = def({ default: 'd.png' })
    expect(imageParamsOf([d], {})).toEqual([d])
  })

  it('数字值不算可对比', () => {
    expect(imageParamsOf([def({})], { img: 5 })).toEqual([])
  })

  it('多个 image 参数保持模板顺序', () => {
    const a = def({ key: 'a' })
    const b = def({ key: 'b' })
    const seed = def({ key: 's', type: 'seed' })
    expect(imageParamsOf([a, seed, b], { a: '1.png', b: '2.png', s: 42 })).toEqual([a, b])
  })
})

describe('imageParamValue', () => {
  it('优先取 params 值,缺失回退 default', () => {
    expect(imageParamValue(def({ default: 'd.png' }), { img: 'x.png' })).toBe('x.png')
    expect(imageParamValue(def({ default: 'd.png' }), {})).toBe('d.png')
  })

  it('非字符串返回空串', () => {
    expect(imageParamValue(def({}), { img: 3 })).toBe('')
  })
})
