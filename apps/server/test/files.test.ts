import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'

let db: Db
let app: ReturnType<typeof createApp>
let dataDir: string
const H = { Authorization: 'Bearer secret' }

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-files-'))
  mkdirSync(join(dataDir, 'uploads'), { recursive: true })
  mkdirSync(join(dataDir, 'outputs', '1'), { recursive: true })
  writeFileSync(join(dataDir, 'outputs', '1', '0-0-out.png'), 'png-bytes')
  db = createDb(':memory:')
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db,
    comfy: null,
    events: new EventEmitter(),
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
    expect(body[0]?.stored).toMatch(/^[a-f0-9]{8}-cat\.png$/)
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
})
