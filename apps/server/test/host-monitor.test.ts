import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { startHostMonitor } from '../src/host-monitor.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
beforeEach(() => {
  db = createDb(':memory:')
})

describe('host monitor', () => {
  it('状态翻转才发 comfy-status,稳定态不发', async () => {
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    const comfy = new FakeComfy()
    const events = new EventEmitter()
    const seen: any[] = []
    events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const stop = startHostMonitor({ db, comfy, events }, 5)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ online: true, hostId: host.id, hostName: host.name })
    await new Promise((r) => setTimeout(r, 30)) // 多个周期稳定在线,不重复发
    expect(seen).toHaveLength(1)
    comfy.up = false
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toMatchObject({ online: false })
    stop()
  })

  it('comfy 为 null 视为离线', async () => {
    const events = new EventEmitter()
    const seen: any[] = []
    events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const stop = startHostMonitor({ db, comfy: null, events }, 5)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].online).toBe(false)
    stop()
  })
})

describe('health host 字段', () => {
  it('返回 active host 摘要;无 hosts 时为 null', async () => {
    const app = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db,
      comfy: null,
      events: new EventEmitter(),
    })
    const H = { Authorization: 'Bearer secret' }
    let body = (await (await app.request('/api/health', { headers: H })).json()) as any
    expect(body.host).toBeNull()
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    body = (await (await app.request('/api/health', { headers: H })).json()) as any
    expect(body.host).toEqual({ id: host.id, name: host.name })
  })
})
