import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

describe('PATCH /api/templates/order', () => {
  it('重排后 GET 按新顺序返回', async () => {
    const a = await createTemplate()
    const res2 = await app.request('/api/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...templateBody, name: 'T2' }),
    })
    const b = (await res2.json()) as { id: number }
    const patch = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [b.id, a.id] }),
    })
    expect(patch.status).toBe(200)
    const list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list.map((t) => t.id)).toEqual([b.id, a.id])
  })

  it('非法 body 400, 未知 id 404, 不完整 400', async () => {
    const a = await createTemplate()
    const bad = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: 'x' }),
    })
    expect(bad.status).toBe(400)
    const unknown = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [a.id, 999] }),
    })
    expect(unknown.status).toBe(404)
    const incomplete = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [] }),
    })
    expect(incomplete.status).toBe(400)
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

describe('DELETE /api/batches/:id', () => {
  async function makeBatch() {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    return (await res.json()) as { id: number }
  }

  it('删除 pending batch 及其 jobs', async () => {
    const b = await makeBatch()
    const del = await app.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    expect((await app.request(`/api/batches/${b.id}`, { headers: H })).status).toBe(404)
  })

  it('running batch 返回 409', async () => {
    const b = await makeBatch()
    // 直接用 repo 把 batch 置为 running(模拟执行器认领)
    const { claimNextJob } = await import('../src/db/repo.js')
    claimNextJob(db)
    const del = await app.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(409)
    expect(await del.json()).toEqual({ error: 'batch is running' })
  })

  it('未知 id 404', async () => {
    const del = await app.request('/api/batches/999', { method: 'DELETE', headers: H })
    expect(del.status).toBe(404)
  })

  it('purgeOutputs=1 时清理输出目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-del-'))
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: localDb, comfy: null, events: new EventEmitter(),
    })
    const t = await localApp.request('/api/templates', {
      method: 'POST', headers: H, body: JSON.stringify(templateBody),
    })
    const tid = ((await t.json()) as { id: number }).id
    const bRes = await localApp.request(`/api/templates/${tid}/batches`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const bid = ((await bRes.json()) as { id: number }).id
    const outDir = join(dataDir, 'outputs', String(bid))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'x.png'), 'png')
    const del = await localApp.request(`/api/batches/${bid}?purgeOutputs=1`, {
      method: 'DELETE', headers: H,
    })
    expect(del.status).toBe(200)
    expect(existsSync(outDir)).toBe(false)
  })

  it('不带 purgeOutputs 时输出目录保留', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-keep-'))
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: localDb, comfy: null, events: new EventEmitter(),
    })
    const t = await localApp.request('/api/templates', {
      method: 'POST', headers: H, body: JSON.stringify(templateBody),
    })
    const tid = ((await t.json()) as { id: number }).id
    const bRes = await localApp.request(`/api/templates/${tid}/batches`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const bid = ((await bRes.json()) as { id: number }).id
    const outDir = join(dataDir, 'outputs', String(bid))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'x.png'), 'png')
    const del = await localApp.request(`/api/batches/${bid}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    expect(existsSync(outDir)).toBe(true)
  })
})
