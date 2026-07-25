import { describe, expect, it } from 'vitest'
import type { ObjectInfoMap } from '../src/comfy/client.js'
import { ConvertError, convertGraphToApi, type GraphJson } from '../src/comfy/graph-convert.js'

/** 录制自真实 /object_info 的最小片段(input 顺序与真实一致) */
const objectInfo: ObjectInfoMap = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } },
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
  },
  EmptySD3LatentImage: {
    input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } },
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m']],
        scheduler: [['simple', 'karras']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', {}],
      },
    },
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } },
  },
  LoraLoader: {
    input: {
      required: {
        model: ['MODEL'],
        clip: ['CLIP'],
        lora_name: [['l.safetensors']],
        strength_model: ['FLOAT', {}],
        strength_clip: ['FLOAT', {}],
      },
    },
  },
  LoadImage: {
    input: { required: { image: [['x.png'], { image_upload: true }] } },
  },
}

// 基础 txt2img 图:1=ckpt 2=pos-clip 3=neg-clip 4=latent 5=ksampler 6=vaedecode 7=save
// 8=Reroute(2→8→5.positive) 9=PrimitiveNode(STRING→3.text) 20=Note
// links: [id, srcId, srcSlot, dstId, dstSlot, type]
const baseGraph: GraphJson = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
      outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2, 3] }, { name: 'VAE', type: 'VAE', links: [4] }] },
    { id: 2, type: 'CLIPTextEncode', title: '正向提示词', widgets_values: ['a cat'],
      inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [10] }] },
    { id: 3, type: 'CLIPTextEncode', widgets_values: ['占位将被 primitive 覆盖'],
      inputs: [
        { name: 'clip', type: 'CLIP', link: 3 },
        { name: 'text', type: 'STRING', link: 12, widget: { name: 'text' } },
      ],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }] },
    { id: 4, type: 'EmptySD3LatentImage', widgets_values: [512, 512, 1],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }] },
    { id: 5, type: 'KSampler', widgets_values: [42, 'randomize', 4, 1, 'euler', 'simple', 1],
      inputs: [
        { name: 'model', type: 'MODEL', link: 1 },
        { name: 'positive', type: 'CONDITIONING', link: 11 },
        { name: 'negative', type: 'CONDITIONING', link: 6 },
        { name: 'latent_image', type: 'LATENT', link: 7 },
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
    { id: 6, type: 'VAEDecode',
      inputs: [
        { name: 'samples', type: 'LATENT', link: 8 },
        { name: 'vae', type: 'VAE', link: 4 },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }] },
    { id: 7, type: 'SaveImage', widgets_values: ['ComfyUI'],
      inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] },
    { id: 8, type: 'Reroute',
      inputs: [{ name: '', type: '*', link: 10 }],
      outputs: [{ name: '', type: 'CONDITIONING', links: [11] }] },
    { id: 9, type: 'PrimitiveNode', widgets_values: ['from primitive'],
      outputs: [{ name: 'STRING', type: 'STRING', links: [12] }] },
    { id: 20, type: 'Note', widgets_values: ['随便写点'] },
  ],
  links: [
    [1, 1, 0, 5, 0, 'MODEL'],
    [2, 1, 1, 2, 0, 'CLIP'],
    [3, 1, 1, 3, 0, 'CLIP'],
    [4, 1, 2, 6, 1, 'VAE'],
    [6, 3, 0, 5, 2, 'CONDITIONING'],
    [7, 4, 0, 5, 3, 'LATENT'],
    [8, 5, 0, 6, 0, 'LATENT'],
    [9, 6, 0, 7, 0, 'IMAGE'],
    [10, 2, 0, 8, 0, 'CONDITIONING'],
    [11, 8, 0, 5, 1, 'CONDITIONING'],
    [12, 9, 0, 3, 0, 'STRING'],
  ],
}

describe('convertGraphToApi', () => {
  const api = convertGraphToApi(baseGraph, objectInfo)

  it('widgets_values 按 object_info 顺序映射为命名 inputs', () => {
    expect(api['4'].inputs).toEqual({ width: 512, height: 512, batch_size: 1 })
    expect(api['1'].inputs).toEqual({ ckpt_name: 'a.safetensors' })
  })

  it('seed 的 control_after_generate 占位被跳过', () => {
    expect(api['5'].inputs.seed).toBe(42)
    expect(api['5'].inputs.steps).toBe(4)
    expect(api['5'].inputs.cfg).toBe(1)
    expect(api['5'].inputs.sampler_name).toBe('euler')
    expect(api['5'].inputs.scheduler).toBe('simple')
    expect(api['5'].inputs.denoise).toBe(1)
    expect(api['5'].inputs).not.toHaveProperty('control_after_generate')
  })

  it('连线解析为 [nodeId, slot]', () => {
    expect(api['5'].inputs.model).toEqual(['1', 0])
    expect(api['5'].inputs.negative).toEqual(['3', 0])
    expect(api['6'].inputs.vae).toEqual(['1', 2])
  })

  it('Reroute 透传到真实源', () => {
    expect(api['5'].inputs.positive).toEqual(['2', 0])
    expect(api['8']).toBeUndefined()
  })

  it('PrimitiveNode 值内联为字面量,覆盖 widget 占位', () => {
    expect(api['3'].inputs.text).toBe('from primitive')
    expect(api['9']).toBeUndefined()
  })

  it('Note 节点被剔除,_meta.title 保留', () => {
    expect(api['20']).toBeUndefined()
    expect(api['2']._meta.title).toBe('正向提示词')
    expect(api['3']._meta.title).toBe('CLIPTextEncode')
  })

  it('bypassed(mode=4)节点按输出类型透传', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'LoraLoader', mode: 4, widgets_values: ['l.safetensors', 1, 1],
          inputs: [
            { name: 'model', type: 'MODEL', link: 1 },
            { name: 'clip', type: 'CLIP', link: null },
          ],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [2] }, { name: 'CLIP', type: 'CLIP', links: null }] },
        { id: 3, type: 'VAEDecode',
          inputs: [{ name: 'samples', type: 'LATENT', link: null }, { name: 'vae', type: 'VAE', link: null }] },
        { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 4, 1, 'euler', 'simple', 1],
          inputs: [{ name: 'model', type: 'MODEL', link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 2, 0, 5, 0, 'MODEL'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['5'].inputs.model).toEqual(['1', 0])
    expect(out['2']).toBeUndefined()
  })

  it('muted(mode=2)源节点:下游该输入被剔除', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', mode: 2, widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
        { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 4, 1, 'euler', 'simple', 1],
          inputs: [{ name: 'model', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 5, 0, 'MODEL']],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['1']).toBeUndefined()
    expect(out['5'].inputs).not.toHaveProperty('model')
  })

  it('image_upload 伪 widget 占位被跳过', () => {
    const graph: GraphJson = {
      nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['cat.png', 'image'] }],
      links: [],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['1'].inputs).toEqual({ image: 'cat.png' })
  })

  it('widgets_values 为对象时按名直取', () => {
    const graph: GraphJson = {
      nodes: [{ id: 1, type: 'SaveImage', widgets_values: { filename_prefix: 'x' } as any }],
      links: [],
    }
    expect(convertGraphToApi(graph, objectInfo)['1'].inputs.filename_prefix).toBe('x')
  })

  it('缺失节点类型抛 ConvertError 并列出全部缺失项', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 1, type: 'SomeCustomNodeA' },
        { id: 2, type: 'SomeCustomNodeB' },
        { id: 3, type: 'SomeCustomNodeA' },
      ],
      links: [],
    }
    try {
      convertGraphToApi(graph, objectInfo)
      expect.unreachable('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(ConvertError)
      expect((err as ConvertError).missingTypes).toEqual(['SomeCustomNodeA', 'SomeCustomNodeB'])
      expect((err as ConvertError).message).toContain('SomeCustomNodeA')
    }
  })

  it('连线成环时不死循环,该输入剔除', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 8, type: 'Reroute',
          inputs: [{ name: '', type: '*', link: 2 }],
          outputs: [{ name: '', type: '*', links: [1] }] },
        { id: 9, type: 'Reroute',
          inputs: [{ name: '', type: '*', link: 1 }],
          outputs: [{ name: '', type: '*', links: [2] }] },
        { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 4, 1, 'euler', 'simple', 1],
          inputs: [{ name: 'model', type: 'MODEL', link: 3 }] },
      ],
      links: [
        [1, 8, 0, 9, 0, '*'],
        [2, 9, 0, 8, 0, '*'],
        [3, 8, 0, 5, 0, 'MODEL'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['5'].inputs).not.toHaveProperty('model')
  })

  it('新版前端省略已转换 widget:中间位置 widget 被转为输入,不错位', () => {
    // KSampler: seed(extraSlot) steps cfg sampler_name scheduler denoise
    // 模拟: cfg 被转为输入,且新版前端在 widgets_values 里省略了 cfg 条目
    // widgets_values 仅含: [seed, 'randomize'(占位被跳), steps, sampler_name, scheduler, denoise] = 6 项
    // 完整期望: seed(2) steps cfg sampler_name scheduler denoise = 7 项
    const graph: GraphJson = {
      nodes: [
        { id: 5, type: 'KSampler',
          widgets_values: [42, 'randomize', 4, 'euler', 'simple', 1], // 省略 cfg
          inputs: [
            { name: 'model', type: 'MODEL', link: null },
            { name: 'positive', type: 'CONDITIONING', link: null },
            { name: 'negative', type: 'CONDITIONING', link: null },
            { name: 'latent_image', type: 'LATENT', link: null },
            { name: 'cfg', type: 'FLOAT', link: 10, widget: { name: 'cfg' } }, // 转为输入
          ],
          outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [10] }] },
      ],
      links: [
        [10, 1, 0, 5, 3, 'FLOAT'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    // cfg 来自连线,不是 widgets_values
    expect(out['5'].inputs.cfg).toEqual(['1', 0])
    // 后续 widget 应该对齐到正确的值(不因为 cfg 被省略而错位)
    expect(out['5'].inputs.seed).toBe(42)
    expect(out['5'].inputs.steps).toBe(4)
    expect(out['5'].inputs.sampler_name).toBe('euler')
    expect(out['5'].inputs.scheduler).toBe('simple')
    expect(out['5'].inputs.denoise).toBe(1)
  })

  it('旧版前端保留占位:cfg 被转为输入但 widgets_values 仍含占位值', () => {
    // 旧版行为:widgets_values 保留 cfg 的占位值(完整长度)
    // widgets_values: [seed, 'randomize'(占位被跳), steps, cfg(占位值), sampler_name, scheduler, denoise] = 7 项
    const graph: GraphJson = {
      nodes: [
        { id: 5, type: 'KSampler',
          widgets_values: [42, 'randomize', 4, 9.5, 'euler', 'simple', 1], // cfg 占位值 9.5
          inputs: [
            { name: 'model', type: 'MODEL', link: null },
            { name: 'positive', type: 'CONDITIONING', link: null },
            { name: 'negative', type: 'CONDITIONING', link: null },
            { name: 'latent_image', type: 'LATENT', link: null },
            { name: 'cfg', type: 'FLOAT', link: 10, widget: { name: 'cfg' } }, // 转为输入
          ],
          outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [10] }] },
      ],
      links: [
        [10, 1, 0, 5, 3, 'FLOAT'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    // 完整长度 >= fullLen,所以不跳过,cfg 被连线覆盖
    expect(out['5'].inputs.cfg).toEqual(['1', 0])
    // 后续 widget 依然对齐(因为完整长度,位置消费正确)
    expect(out['5'].inputs.seed).toBe(42)
    expect(out['5'].inputs.steps).toBe(4)
    expect(out['5'].inputs.sampler_name).toBe('euler')
    expect(out['5'].inputs.scheduler).toBe('simple')
    expect(out['5'].inputs.denoise).toBe(1)
  })

  it('新版前端省略已转换 widget:尾部 seed extraSlot 被省略不错位', () => {
    // 模拟:seed widget(含 extraSlot)被转为输入,新版前端省略了整个 seed 条目(2 个槽)
    // KSampler: seed(extraSlot) steps cfg sampler_name scheduler denoise
    // widgets_values 仅含: [steps, cfg, sampler_name, scheduler, denoise] = 5 项
    // 完整期望: seed(2) steps cfg sampler_name scheduler denoise = 7 项
    const graph: GraphJson = {
      nodes: [
        { id: 5, type: 'KSampler',
          widgets_values: [4, 1, 'euler', 'simple', 1], // 省略 seed 及其占位
          inputs: [
            { name: 'model', type: 'MODEL', link: null },
            { name: 'positive', type: 'CONDITIONING', link: null },
            { name: 'negative', type: 'CONDITIONING', link: null },
            { name: 'latent_image', type: 'LATENT', link: null },
            { name: 'seed', type: 'INT', link: 10, widget: { name: 'seed' } }, // seed 转为输入
          ],
          outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [10] }] },
      ],
      links: [
        [10, 1, 0, 5, 0, 'INT'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    // seed 来自连线
    expect(out['5'].inputs.seed).toEqual(['1', 0])
    // 后续 widget 对齐正确
    expect(out['5'].inputs.steps).toBe(4)
    expect(out['5'].inputs.cfg).toBe(1)
    expect(out['5'].inputs.sampler_name).toBe('euler')
    expect(out['5'].inputs.scheduler).toBe('simple')
    expect(out['5'].inputs.denoise).toBe(1)
  })
})
