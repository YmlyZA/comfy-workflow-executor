import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
let deps: AppDeps
let app: ReturnType<typeof createApp>
let calls: string[]
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  db = createDb(':memory:')
  calls = []
  deps = {
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db,
    comfy: new FakeComfy(),
    events: new EventEmitter(),
    executor: {
      pause: async (opts?: { abandon?: boolean }) => {
        calls.push(opts?.abandon ? 'pause-abandon' : 'pause')
      },
      resume: () => calls.push('resume'),
    },
  }
  app = createApp(deps)
})

const j = (method: string, path: string, body?: unknown) =>
  app.request(`/api/hosts${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('hosts CRUD', () => {
  it('创建:url 去尾斜杠;非 http 前缀 400', async () => {
    const res = await j('POST', '', { name: 'A', url: 'http://a:8188//' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).host.url).toBe('http://a:8188')
    expect((await j('POST', '', { name: 'B', url: 'a:8188' })).status).toBe(400)
  })

  it('删 active 409;删普通 ok', async () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    expect((await j('DELETE', `/${a.id}`)).status).toBe(409)
    expect((await j('DELETE', `/${b.id}`)).status).toBe(200)
  })
})

describe('activate', () => {
  it('wait 模式:pause→表切换→resume 顺序;发 comfy-status 事件', async () => {
    repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await j('POST', `/${b.id}/activate`, { mode: 'wait' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['pause', 'resume'])
    expect(repo.getActiveHost(db)?.id).toBe(b.id)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ hostId: b.id, hostName: 'B' })
  })

  it('interrupt 模式走 pause({abandon});已 active 幂等不 pause', async () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    await j('POST', `/${b.id}/activate`, { mode: 'interrupt' })
    expect(calls).toEqual(['pause-abandon', 'resume'])
    calls.length = 0
    await j('POST', `/${b.id}/activate`, { mode: 'wait' })
    expect(calls).toEqual([])
    expect((await j('POST', '/9999/activate', { mode: 'wait' })).status).toBe(404)
    void a
  })
})

describe('PATCH', () => {
  it('改 active 主机 URL 触发重连;改名不触发', async () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    await j('PATCH', `/${a.id}`, { name: 'A2' })
    expect(calls).toEqual([])
    await j('PATCH', `/${a.id}`, { url: 'http://a2:8188' })
    expect(calls).toEqual(['pause', 'resume'])
    expect(repo.getHost(db, a.id)?.url).toBe('http://a2:8188')
  })
})

describe('current/stats', () => {
  it('在线返回摘要;fake 断网返回 online:false', async () => {
    repo.ensureActiveHost(db, 'http://a:8188')
    const res = await app.request('/api/hosts/current/stats', { headers: H })
    const body = (await res.json()) as any
    expect(body.online).toBe(true)
    expect(body.gpuName).toBe('FakeGPU')
    expect(body.vramTotalMB).toBe(8192)
    expect(body.cwe).toBe(true)
    ;(deps.comfy as FakeComfy).getSystemStats = async () => {
      throw new Error('down')
    }
    const res2 = await app.request('/api/hosts/current/stats', { headers: H })
    expect(((await res2.json()) as any).online).toBe(false)
  })
})

describe('/:id/test', () => {
  it('host 不存在 404', async () => {
    expect((await j('POST', '/9999/test')).status).toBe(404)
  })

  it('不可达主机在 3s 超时内返回 reachable:false', async () => {
    const host = repo.createHost(db, { name: 'Dead', url: 'http://127.0.0.1:1' })
    const res = await j('POST', `/${host.id}/test`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).reachable).toBe(false)
  }, 10000)
})
