import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'

let db: Db
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  db = createDb(':memory:')
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db,
    comfy: null,
    events: new EventEmitter(),
  })
})

const templateBody = {
  name: 'T',
  comfyJson: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } },
  params: [{ key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' }],
}

async function createTemplate() {
  const res = await app.request('/api/templates', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(templateBody),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number }
}

describe('templates routes', () => {
  it('POST validates body', async () => {
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST/GET/DELETE roundtrip', async () => {
    const t = await createTemplate()
    let list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list).toHaveLength(1)
    const del = await app.request(`/api/templates/${t.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list).toHaveLength(0)
  })

  it('DELETE returns 409 when template has batches', async () => {
    const t = await createTemplate()
    const create = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    expect(create.status).toBe(201)
    const res = await app.request(`/api/templates/${t.id}`, { method: 'DELETE', headers: H })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'template has batches' })
  })
})

describe('batches routes', () => {
  it('creates batch with jobs and reads detail', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }, { prompt: 'b' }] }),
    })
    expect(res.status).toBe(201)
    const batch = (await res.json()) as { id: number }

    const listRes = await app.request('/api/batches', { headers: H })
    const list = (await listRes.json()) as any[]
    expect(list[0]).toMatchObject({ templateName: 'T', total: 2 })

    const detailRes = await app.request(`/api/batches/${batch.id}`, { headers: H })
    const detail = (await detailRes.json()) as any
    expect(detail.jobs).toHaveLength(2)
    expect(detail.template.name).toBe('T')
  })

  it('404 on unknown template/batch', async () => {
    const r1 = await app.request('/api/templates/999/batches', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    expect(r1.status).toBe(404)
    const r2 = await app.request('/api/batches/999', { headers: H })
    expect(r2.status).toBe(404)
  })

  it('cancel and retry-failed endpoints work', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const batch = (await res.json()) as { id: number }
    const cancel = await app.request(`/api/batches/${batch.id}/cancel`, { method: 'POST', headers: H })
    expect(cancel.status).toBe(200)
    const detail = (await (await app.request(`/api/batches/${batch.id}`, { headers: H })).json()) as any
    expect(detail.batch.status).toBe('canceled')
    const retry = await app.request(`/api/batches/${batch.id}/retry-failed`, { method: 'POST', headers: H })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ retried: 0 })
  })
})

describe('GET /api/uploads', () => {
  it('目录不存在返回空;有文件按修改时间倒序且跳过子目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-ls-'))
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: createDb(':memory:'), comfy: null, events: new EventEmitter(),
    })
    expect(await (await localApp.request('/api/uploads', { headers: H })).json()).toEqual({ files: [] })

    const dir = join(dataDir, 'uploads')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), 'x')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'a.png'), past, past)
    writeFileSync(join(dir, 'b.png'), 'y')
    mkdirSync(join(dir, 'sub'))
    const res = (await (await localApp.request('/api/uploads', { headers: H })).json()) as { files: string[] }
    expect(res.files).toEqual(['b.png', 'a.png'])
  })
})
