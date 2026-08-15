import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { startHostMonitor } from '../src/host-monitor.js'
import { FakeComfy } from './fake-comfy.js'

describe('host-monitor 多主机', () => {
  it('探测全部主机并逐台广播,快照可读', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const events = new EventEmitter()
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    const clients: Record<string, FakeComfy> = {
      'http://a:8188': Object.assign(new FakeComfy(), { up: true }),
      'http://b:8188': Object.assign(new FakeComfy(), { up: false }),
    }
    const monitor = startHostMonitor({ db, events, comfyFactory: (url) => clients[url]! }, 60_000)
    await vi.waitFor(() => expect(seen.length).toBe(2))
    monitor.stop()
    expect(monitor.snapshot()).toEqual({ [a.id]: true, [b.id]: false })
    expect(seen.find((e) => e.hostId === a.id).online).toBe(true)
    expect(seen.find((e) => e.hostId === b.id).online).toBe(false)
  })

  it('停用的主机也探测(便于用户判断能否启用)', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.setHostEnabled(db, a.id, false)
    const events = new EventEmitter()
    const monitor = startHostMonitor({ db, events, comfyFactory: () => new FakeComfy() }, 60_000)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(true))
    monitor.stop()
  })

  it('主机被删除后从快照中移除', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const events = new EventEmitter()
    const monitor = startHostMonitor({ db, events, comfyFactory: () => new FakeComfy() }, 5)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(true))
    repo.deleteHost(db, a.id)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBeUndefined())
    monitor.stop()
  })
})
