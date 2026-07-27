import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
let dataDir: string
let fake: FakeComfy
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret' }

async function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer()
}

async function meta(res: Response) {
  return sharp(Buffer.from(await res.arrayBuffer())).metadata()
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-thumbs-'))
  mkdirSync(join(dataDir, 'uploads'), { recursive: true })
  db = createDb(':memory:')
  fake = new FakeComfy()
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db,
    comfy: fake,
    events: new EventEmitter(),
  })
})

describe('GET /api/thumbs (uploads 源)', () => {
  it('缩放到 192 最长边并输出 webp,带 Cache-Control', async () => {
    writeFileSync(join(dataDir, 'uploads', 'big.png'), await pngBuffer(400, 200))
    const res = await app.request('/api/thumbs?source=uploads&name=big.png', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('max-age=86400')
    const m = await meta(res)
    expect(m.format).toBe('webp')
    expect(m.width).toBe(192)
    expect(m.height).toBe(96)
  })

  it('小图不放大', async () => {
    writeFileSync(join(dataDir, 'uploads', 'small.png'), await pngBuffer(64, 48))
    const res = await app.request('/api/thumbs?source=uploads&name=small.png', { headers: H })
    expect(res.status).toBe(200)
    const m = await meta(res)
    expect(m.width).toBe(64)
    expect(m.height).toBe(48)
  })

  it('磁盘缓存命中:删掉源文件后仍能返回缩略图', async () => {
    writeFileSync(join(dataDir, 'uploads', 'cached.png'), await pngBuffer(100, 100))
    const first = await app.request('/api/thumbs?source=uploads&name=cached.png', { headers: H })
    expect(first.status).toBe(200)
    rmSync(join(dataDir, 'uploads', 'cached.png'))
    const second = await app.request('/api/thumbs?source=uploads&name=cached.png', { headers: H })
    expect(second.status).toBe(200)
    expect(second.headers.get('content-type')).toBe('image/webp')
  })

  it('不存在返回 404', async () => {
    const res = await app.request('/api/thumbs?source=uploads&name=nope.png', { headers: H })
    expect(res.status).toBe(404)
  })

  it('非图片文件返回 415', async () => {
    writeFileSync(join(dataDir, 'uploads', 'text.png'), 'not-an-image')
    const res = await app.request('/api/thumbs?source=uploads&name=text.png', { headers: H })
    expect(res.status).toBe(415)
  })

  it('uploads 不接受带路径分隔符的名字', async () => {
    const res = await app.request(
      `/api/thumbs?source=uploads&name=${encodeURIComponent('a/b.png')}`,
      { headers: H },
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /api/thumbs (comfy 源)', () => {
  it('经 comfy client 拉取并缩放,允许子目录相对名', async () => {
    fake.inputImages['sub/pic.png'] = await pngBuffer(300, 300)
    const res = await app.request(
      `/api/thumbs?source=comfy&name=${encodeURIComponent('sub/pic.png')}`,
      { headers: H },
    )
    expect(res.status).toBe(200)
    const m = await meta(res)
    expect(m.width).toBe(192)
    expect(m.height).toBe(192)
  })

  it('磁盘缓存命中:GPU 侧文件消失后仍能返回', async () => {
    fake.inputImages['gone.png'] = await pngBuffer(50, 50)
    const first = await app.request('/api/thumbs?source=comfy&name=gone.png', { headers: H })
    expect(first.status).toBe(200)
    delete fake.inputImages['gone.png']
    const second = await app.request('/api/thumbs?source=comfy&name=gone.png', { headers: H })
    expect(second.status).toBe(200)
  })

  it('GPU 侧不存在返回 404', async () => {
    const res = await app.request('/api/thumbs?source=comfy&name=nope.png', { headers: H })
    expect(res.status).toBe(404)
  })

  it('comfy 为 null 时返回 503', async () => {
    const offline = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db,
      comfy: null,
      events: new EventEmitter(),
    })
    const res = await offline.request('/api/thumbs?source=comfy&name=x.png', { headers: H })
    expect(res.status).toBe(503)
  })
})

describe('GET /api/thumbs (参数校验)', () => {
  it('source 非法返回 400', async () => {
    const res = await app.request('/api/thumbs?source=outputs&name=x.png', { headers: H })
    expect(res.status).toBe(400)
  })

  it('缺少 name 返回 400', async () => {
    const res = await app.request('/api/thumbs?source=uploads', { headers: H })
    expect(res.status).toBe(400)
  })

  it('.. 穿越返回 400(两种 source)', async () => {
    for (const source of ['uploads', 'comfy']) {
      const res = await app.request(
        `/api/thumbs?source=${source}&name=${encodeURIComponent('../secret.png')}`,
        { headers: H },
      )
      expect(res.status).toBe(400)
    }
  })

  it('comfy 绝对路径返回 400', async () => {
    const res = await app.request(
      `/api/thumbs?source=comfy&name=${encodeURIComponent('/etc/passwd')}`,
      { headers: H },
    )
    expect(res.status).toBe(400)
  })
})
