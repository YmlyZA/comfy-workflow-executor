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
    const monitor = startHostMonitor(
      { getDb: () => db, events, comfyFactory: (url) => clients[url]! },
      60_000,
    )
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
    const monitor = startHostMonitor({ getDb: () => db, events, comfyFactory: () => new FakeComfy() }, 60_000)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(true))
    monitor.stop()
  })

  it('主机被删除后从快照中移除', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const events = new EventEmitter()
    const monitor = startHostMonitor({ getDb: () => db, events, comfyFactory: () => new FakeComfy() }, 5)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(true))
    repo.deleteHost(db, a.id)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBeUndefined())
    monitor.stop()
  })

  it('db 句柄被换掉后(数据导入热切换)探测跟着走新库,不会卡在已关闭的旧库上', async () => {
    let db = createDb(':memory:')
    // url 带 unreachable 的探测故意做成不通:旧库两台主机(id 与新库主机可能撞号,
    // :memory: 库各自的自增都从 1 开始)全部是 false,这样下面等到的 true 只能来自
    // 新库那次真实的 tick,不会是旧状态因为 id 撞号而残留下来的假阳性
    const a = repo.createHost(db, { name: 'A', url: 'http://unreachable-a:8188' })
    const events = new EventEmitter()
    // getDb 读的是外层这个可变的 db 变量——和 index.ts/backup.ts 里
    // `deps.hostMonitor = startHostMonitor({ getDb: () => deps.db, ... })`、
    // `deps.db = reopened` 是同一种"读同一份可变引用"的写法
    const monitor = startHostMonitor(
      {
        getDb: () => db,
        events,
        comfyFactory: (url) => Object.assign(new FakeComfy(), { up: !url.includes('unreachable') }),
      },
      5,
    )
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(false))

    // 模拟数据导入:关掉旧库,换一份全新的库(旧主机在新库里不存在)
    db.$client.close()
    const newDb = createDb(':memory:')
    const b = repo.createHost(newDb, { name: 'B', url: 'http://b:8188' })
    db = newDb

    // 若 db 是构造时按值捕获的,这里会永远等不到:tick() 会一直对着已关闭的旧句柄
    // 报错(try 只有 finally,没有 catch,异常吞不掉),快照永久停在旧状态
    await vi.waitFor(() => expect(monitor.snapshot()[b.id]).toBe(true))
    monitor.stop()
  })
})
