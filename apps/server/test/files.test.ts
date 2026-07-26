import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'

let db: Db
let app: ReturnType<typeof createApp>
let dataDir: string
let events: EventEmitter
const H = { Authorization: 'Bearer secret' }

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-files-'))
  mkdirSync(join(dataDir, 'uploads'), { recursive: true })
  mkdirSync(join(dataDir, 'outputs', '1'), { recursive: true })
  writeFileSync(join(dataDir, 'outputs', '1', '0-0-out.png'), 'png-bytes')
  db = createDb(':memory:')
  events = new EventEmitter()
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db,
    comfy: null,
    events,
  })
})

describe('uploads', () => {
  it('stores multipart files and returns stored names', async () => {
    const form = new FormData()
    form.append('files', new Blob(['abc']), 'cat.png')
    const res = await app.request('/api/uploads', { method: 'POST', headers: H, body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Array<{ name: string; stored: string }>
    expect(body[0]?.name).toBe('cat.png')
    expect(body[0]?.stored).toMatch(/^[a-f0-9]{16}-cat\.png$/)
  })

  it('stores multiple multipart files with distinct stored names', async () => {
    const form = new FormData()
    form.append('files', new Blob(['abc']), 'cat.png')
    form.append('files', new Blob(['def']), 'dog.png')
    const res = await app.request('/api/uploads', { method: 'POST', headers: H, body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Array<{ name: string; stored: string }>
    expect(body).toHaveLength(2)
    expect(body[0]?.name).toBe('cat.png')
    expect(body[1]?.name).toBe('dog.png')
    expect(body[0]?.stored).not.toBe(body[1]?.stored)
  })

  it('folds consecutive dots in the stored filename', async () => {
    const form = new FormData()
    form.append('files', new Blob(['abc']), 'photo..final.png')
    const res = await app.request('/api/uploads', { method: 'POST', headers: H, body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Array<{ name: string; stored: string }>
    expect(body[0]?.name).toBe('photo..final.png')
    expect(body[0]?.stored).not.toContain('..')
    expect(body[0]?.stored).toMatch(/^[a-f0-9]{16}-photo\.final\.png$/)
  })

  async function uploadOne(content: string, fname: string): Promise<string> {
    const form = new FormData()
    form.append('files', new Blob([content]), fname)
    const res = await app.request('/api/uploads', { method: 'POST', headers: H, body: form })
    expect(res.status).toBe(201)
    return ((await res.json()) as Array<{ stored: string }>)[0]!.stored
  }

  it('同内容重复上传返回同名且不新增文件', async () => {
    const first = await uploadOne('same-bytes', 'a.png')
    const second = await uploadOne('same-bytes', 'a.png')
    expect(second).toBe(first)
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([first])
  })

  it('同内容不同原名复用先到者', async () => {
    const first = await uploadOne('same-bytes', 'a.png')
    const second = await uploadOne('same-bytes', 'b.png')
    expect(second).toBe(first)
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([first])
  })

  it('不同内容得到不同存储名', async () => {
    const first = await uploadOne('bytes-1', 'a.png')
    const second = await uploadOne('bytes-2', 'a.png')
    expect(second).not.toBe(first)
    expect(readdirSync(join(dataDir, 'uploads')).sort()).toEqual([first, second].sort())
  })
})

describe('outputs static', () => {
  it('serves an output file', async () => {
    const res = await app.request('/api/outputs/1/0-0-out.png', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('png-bytes')
  })

  it('blocks path traversal', async () => {
    const res = await app.request('/api/outputs/..%2F..%2Fetc%2Fpasswd', { headers: H })
    expect(res.status).toBe(400)
  })

  it('404 on missing file', async () => {
    const res = await app.request('/api/outputs/1/nope.png', { headers: H })
    expect(res.status).toBe(404)
  })

  it('404 on directory request', async () => {
    const res = await app.request('/api/outputs/1', { headers: H })
    expect(res.status).toBe(404)
  })
})

describe('zip download', () => {
  it('streams a zip with content', async () => {
    const res = await app.request('/api/batches/1/download', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)
    expect([buf[0], buf[1]]).toEqual([0x50, 0x4b]) // "PK"
  })

  it('streams a zip even when the batch output dir is missing', async () => {
    const res = await app.request('/api/batches/999/download', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)
    expect([buf[0], buf[1]]).toEqual([0x50, 0x4b]) // "PK"
  })
})

describe('sse events', () => {
  it('forwards emitted events and removes listener on abort', async () => {
    const res = await app.request('/api/events', { headers: H })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()

    const readUntil = async (needle: string, maxReads = 10) => {
      let buf = ''
      for (let i = 0; i < maxReads; i++) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        if (buf.includes(needle)) return buf
      }
      return buf
    }

    const first = await readUntil('event: ping')
    expect(first).toContain('event: ping')

    events.emit('event', { type: 'job-updated', jobId: 1, batchId: 1, status: 'running' })
    const second = await readUntil('event: job-updated')
    expect(second).toContain('event: job-updated')
    expect(second).toContain('"jobId":1')

    await reader.cancel()
    await new Promise((r) => setTimeout(r, 20))
    expect(events.listenerCount('event')).toBe(0)
  })
})
