import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/index.js'
import { FakeComfy } from './fake-comfy.js'

const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

/** 1×1 透明 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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

describe('GET /api/comfy/input-files', () => {
  it('返回 LoadImage 的 GPU 侧输入文件清单', async () => {
    const res = await app.request('/api/comfy/input-files', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: ['existing.png'] })
  })

  it('object_info 无 LoadImage 时返回空数组', async () => {
    delete (comfy.objectInfo as Record<string, unknown>).LoadImage
    const res = await app.request('/api/comfy/input-files', { headers: H })
    expect(await res.json()).toEqual({ files: [] })
  })

  it('离线返回 503', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('down')
    }
    expect((await app.request('/api/comfy/input-files', { headers: H })).status).toBe(503)
  })
})

describe('GET /api/comfy/image-dims', () => {
  it('缺 name 返回 400', async () => {
    expect((await app.request('/api/comfy/image-dims', { headers: H })).status).toBe(400)
  })

  it('本地 uploads 文件解析尺寸', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-dims-'))
    mkdirSync(join(dataDir, 'uploads'), { recursive: true })
    writeFileSync(join(dataDir, 'uploads', 'pic.png'), PNG_1X1)
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: createDb(':memory:'), comfy, events: new EventEmitter(),
    })
    const res = await localApp.request('/api/comfy/image-dims?name=pic.png', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ width: 1, height: 1 })
  })

  it('本地没有时走 GPU 侧文件', async () => {
    comfy.inputImages['gpu.png'] = PNG_1X1
    const res = await app.request('/api/comfy/image-dims?name=gpu.png', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ width: 1, height: 1 })
  })

  it('两边都没有返回 404', async () => {
    expect((await app.request('/api/comfy/image-dims?name=nope.png', { headers: H })).status).toBe(404)
  })

  it('解析失败返回 404', async () => {
    comfy.inputImages['bad.png'] = Buffer.from('not an image')
    expect((await app.request('/api/comfy/image-dims?name=bad.png', { headers: H })).status).toBe(404)
  })

  it('本地没有且 comfy 未配置返回 503', async () => {
    const res = await makeApp(false).request('/api/comfy/image-dims?name=x.png', { headers: H })
    expect(res.status).toBe(503)
  })

  it('getInputImage 抛错(离线)返回 503', async () => {
    comfy.getInputImage = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect((await app.request('/api/comfy/image-dims?name=x.png', { headers: H })).status).toBe(503)
  })

  it('name 含 .. 时跳过本地检查直接走 GPU 侧', async () => {
    comfy.inputImages['../x.png'] = PNG_1X1
    const res = await app.request(
      `/api/comfy/image-dims?name=${encodeURIComponent('../x.png')}`,
      { headers: H },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ width: 1, height: 1 })
  })
})

describe('GET /api/comfy/input-image', () => {
  it('缺 name 返回 400', async () => {
    expect((await app.request('/api/comfy/input-image', { headers: H })).status).toBe(400)
  })

  it('代理返回 GPU 侧图片内容与 Content-Type', async () => {
    comfy.inputImages['gpu.png'] = PNG_1X1
    const res = await app.request('/api/comfy/input-image?name=gpu.png', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_1X1)
  })

  it('不存在返回 404', async () => {
    expect((await app.request('/api/comfy/input-image?name=nope.png', { headers: H })).status).toBe(404)
  })

  it('comfy 未配置返回 503', async () => {
    const res = await makeApp(false).request('/api/comfy/input-image?name=x.png', { headers: H })
    expect(res.status).toBe(503)
  })

  it('getInputImage 抛错(离线)返回 503', async () => {
    comfy.getInputImage = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect((await app.request('/api/comfy/input-image?name=x.png', { headers: H })).status).toBe(503)
  })
})

describe('GET /api/comfy/cwe-status', () => {
  it('扩展在线返回 installed:true', async () => {
    const res = await app.request('/api/comfy/cwe-status', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ installed: true })
  })

  it('cwePing false 返回 installed:false', async () => {
    comfy.cwePingResult = false
    const res = await app.request('/api/comfy/cwe-status', { headers: H })
    expect(await res.json()).toEqual({ installed: false })
  })

  it('comfy 未配置返回 installed:false 而非 503', async () => {
    const res = await makeApp(false).request('/api/comfy/cwe-status', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ installed: false })
  })
})
