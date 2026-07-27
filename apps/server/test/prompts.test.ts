import { EventEmitter } from 'node:events'
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

async function post(path: string, body: unknown) {
  return app.request(`/api/prompts${path}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body),
  })
}

async function listKeys(): Promise<string[]> {
  const res = await app.request('/api/prompts', { headers: H })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { prompts: Array<{ key: string }> }
  return body.prompts.map((p) => p.key)
}

describe('prompts CRUD', () => {
  it('增查改删全链路,删除幂等', async () => {
    const created = await post('', { key: '人物.少女', content: '1girl, solo' })
    expect(created.status).toBe(201)
    const row = (await created.json()) as { id: number; key: string; content: string }
    expect(row).toMatchObject({ key: '人物.少女', content: '1girl, solo' })

    expect(await listKeys()).toEqual(['人物.少女'])

    const upd = await app.request(`/api/prompts/${row.id}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ content: '1girl' }),
    })
    expect(upd.status).toBe(200)
    expect(((await upd.json()) as { content: string }).content).toBe('1girl')

    const updKey = await app.request(`/api/prompts/${row.id}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ key: '人物.女孩' }),
    })
    expect(updKey.status).toBe(200)
    expect(((await updKey.json()) as { key: string }).key).toBe('人物.女孩')

    const del = await app.request(`/api/prompts/${row.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    const again = await app.request(`/api/prompts/${row.id}`, { method: 'DELETE', headers: H })
    expect(again.status).toBe(200)
    expect(await listKeys()).toEqual([])
  })

  it('列表按 key 升序', async () => {
    await post('', { key: 'b.x', content: '2' })
    await post('', { key: 'a.y', content: '1' })
    expect(await listKeys()).toEqual(['a.y', 'b.x'])
  })

  it('POST 重复 key 409;PUT 改 key 撞已有 409', async () => {
    await post('', { key: 'a', content: '1' })
    const dup = await post('', { key: 'a', content: '2' })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'key 已存在' })

    const other = await post('', { key: 'b', content: '3' })
    const { id } = (await other.json()) as { id: number }
    const clash = await app.request(`/api/prompts/${id}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ key: 'a' }),
    })
    expect(clash.status).toBe(409)
  })

  it('key/content 校验 400;PUT 不存在 404', async () => {
    const bads = [
      { key: '', content: 'x' },
      { key: '   ', content: 'x' },
      { key: 'a b', content: 'x' },
      { key: 'a\tb', content: 'x' },
      { key: 'ok', content: '' },
      { key: 'ok', content: '   ' },
    ]
    for (const bad of bads) {
      expect((await post('', bad)).status).toBe(400)
    }
    const missing = await app.request('/api/prompts/999', {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ content: 'x' }),
    })
    expect(missing.status).toBe(404)
  })
})

describe('prompts 导入导出', () => {
  it('export 返回全量与固定格式,带下载头', async () => {
    await post('', { key: 'b', content: '2' })
    await post('', { key: 'a', content: '1' })
    const res = await app.request('/api/prompts/export', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('cwe-prompts-')
    expect(await res.json()).toEqual({
      version: 1,
      prompts: [
        { key: 'a', content: '1' },
        { key: 'b', content: '2' },
      ],
    })
  })

  it('import 按 key upsert 并计数', async () => {
    await post('', { key: 'a', content: 'old' })
    const res = await post('/import', {
      version: 1,
      prompts: [
        { key: 'a', content: 'new' },
        { key: 'c', content: '3' },
      ],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: 1, updated: 1 })
    const exp = await app.request('/api/prompts/export', { headers: H })
    expect(((await exp.json()) as { prompts: Array<{ key: string; content: string }> }).prompts).toEqual([
      { key: 'a', content: 'new' },
      { key: 'c', content: '3' },
    ])
  })

  it('import 非法格式整体拒绝,库不变', async () => {
    await post('', { key: 'keep', content: 'x' })
    const bads = [
      {},
      { prompts: 'nope' },
      { prompts: [{ key: 'ok' }] },
      { prompts: [{ content: 'x' }] },
      { prompts: [{ key: 'bad key', content: 'x' }] },
      { prompts: [{ key: 'ok', content: '' }] },
    ]
    for (const bad of bads) {
      expect((await post('/import', bad)).status).toBe(400)
    }
    expect(await listKeys()).toEqual(['keep'])
  })
})
