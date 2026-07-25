import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/index.js'
import { FakeComfy } from './fake-comfy.js'

const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

let comfy: FakeComfy
let app: ReturnType<typeof createApp>

function makeApp(withComfy = true) {
  return createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db: createDb(':memory:'),
    comfy: withComfy ? comfy : null,
    events: new EventEmitter(),
  })
}

beforeEach(() => {
  comfy = new FakeComfy()
  comfy.objectInfo = {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } },
    },
    CLIPTextEncode: {
      input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    },
    LoadImage: {
      input: { required: { image: [['existing.png'], { image_upload: true }] } },
    },
  }
  app = makeApp()
})

describe('POST /api/comfy/convert', () => {
  const graph = {
    nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'] }],
    links: [],
  }

  it('转换 graph 为 API 格式', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify(graph),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.comfyJson['1'].class_type).toBe('CheckpointLoaderSimple')
    expect(body.comfyJson['1'].inputs.ckpt_name).toBe('a.safetensors')
  })

  it('非 graph 形状返回 400', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify({ '1': { class_type: 'X', inputs: {} } }),
    })
    expect(res.status).toBe(400)
  })

  it('nodes 含非法元素返回 400 而非 500', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify({ nodes: [null], links: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('comfy 未配置返回 503', async () => {
    const res = await makeApp(false).request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify(graph),
    })
    expect(res.status).toBe(503)
  })

  it('object_info 拉取失败返回 503', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('ECONNREFUSED')
    }
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify(graph),
    })
    expect(res.status).toBe(503)
  })

  it('缺节点定义返回 422 + missingTypes', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H,
      body: JSON.stringify({ nodes: [{ id: 1, type: 'CustomFoo' }], links: [] }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as any).missingTypes).toEqual(['CustomFoo'])
  })
})

describe('POST /api/comfy/validate', () => {
  it('返回警告与枚举输入清单', async () => {
    const comfyJson = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'missing.safetensors' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['4', 1] } },
      '9': { class_type: 'UnknownCustom', inputs: {} },
    }
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H, body: JSON.stringify(comfyJson),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.skipped).toBe(false)
    expect(body.enumInputs).toEqual([
      { nodeId: '4', classType: 'CheckpointLoaderSimple', inputName: 'ckpt_name' },
    ])
    expect(body.warnings).toHaveLength(2) // 值不存在 + 未知节点类型
    expect(body.warnings.map((w: any) => w.nodeId).sort()).toEqual(['4', '9'])
  })

  it('值合法时无警告', async () => {
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
      }),
    })
    const body = (await res.json()) as any
    expect(body.warnings).toEqual([])
    expect(body.enumInputs).toHaveLength(1)
  })

  it('image_upload 输入不算枚举也不警告(值在建批次时上传)', async () => {
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        '10': { class_type: 'LoadImage', inputs: { image: 'to-be-uploaded.png' } },
      }),
    })
    const body = (await res.json()) as any
    expect(body.enumInputs).toEqual([])
    expect(body.warnings).toEqual([])
  })

  it('离线时 skipped=true', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('down')
    }
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H, body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skipped: true, warnings: [], enumInputs: [] })
  })
})

describe('GET /api/comfy/input-options', () => {
  it('返回枚举可选值', async () => {
    const res = await app.request(
      '/api/comfy/input-options?classType=CheckpointLoaderSimple&inputName=ckpt_name',
      { headers: H },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ options: ['a.safetensors', 'b.safetensors'] })
  })

  it('非枚举输入返回 404', async () => {
    const res = await app.request(
      '/api/comfy/input-options?classType=CLIPTextEncode&inputName=text',
      { headers: H },
    )
    expect(res.status).toBe(404)
  })

  it('离线返回 503', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('down')
    }
    const res = await app.request(
      '/api/comfy/input-options?classType=CheckpointLoaderSimple&inputName=ckpt_name',
      { headers: H },
    )
    expect(res.status).toBe(503)
  })

  it('需要认证', async () => {
    const res = await app.request(
      '/api/comfy/input-options?classType=CheckpointLoaderSimple&inputName=ckpt_name',
    )
    expect(res.status).toBe(401)
  })
})
