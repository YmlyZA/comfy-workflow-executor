import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { ExecutorPool } from '../src/executor-pool.js'
import { FakeComfy } from './fake-comfy.js'

const TEMPLATE = {
  name: 't',
  comfyJson: { '1': { class_type: 'X', inputs: {} } },
  params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
}
const ERROR_RESULT = { status: { completed: false, status_str: 'error', messages: ['boom'] } }

let dir: string
let db: Db
let events: EventEmitter
let pool: ExecutorPool
let clients: Map<string, FakeComfy>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cwe-pool-'))
  db = createDb(':memory:')
  events = new EventEmitter()
  clients = new Map()
  pool = new ExecutorPool({
    db,
    events,
    dataDir: dir,
    pollMs: 1,
    comfyFactory: (url) => {
      let c = clients.get(url)
      if (!c) {
        c = new FakeComfy()
        clients.set(url, c)
      }
      return c
    },
  })
})
afterEach(async () => {
  await pool.pauseAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('syncFromDb', () => {
  it('为每台启用主机起一个 worker', () => {
    repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    pool.syncFromDb()
    expect(pool.size()).toBe(2)
  })

  it('幂等:连调两次不会重复起 worker', () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    pool.syncFromDb()
    expect(pool.size()).toBe(1)
    expect(pool.hasWorker(a.id)).toBe(true)
  })

  it('停用的主机不起 worker,已起的会被移除', async () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    expect(pool.hasWorker(a.id)).toBe(true)
    repo.setHostEnabled(db, a.id, false)
    pool.syncFromDb()
    await vi.waitFor(() => expect(pool.hasWorker(a.id)).toBe(false))
  })
})

describe('熔断', () => {
  it('worker 连续 3 次失败 → 主机落库停用 + 广播 host-disabled', async () => {
    const tpl = repo.createTemplate(db, TEMPLATE)
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }, { p: 3 }] })
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    clients.set('http://a:8188', Object.assign(new FakeComfy(), { nextResult: ERROR_RESULT }))
    pool.syncFromDb()
    await vi.waitFor(
      () => {
        const host = repo.getHost(db, a.id)!
        expect(host.enabled).toBe(0)
        expect(host.disabledReason).toContain('连续')
      },
      { timeout: 5000 },
    )
    await vi.waitFor(() => expect(pool.hasWorker(a.id)).toBe(false))
    expect(seen.some((e) => e.type === 'host-disabled' && e.hostId === a.id)).toBe(true)
  })
})

describe('reclaimOrphans', () => {
  it('把不属于任何启用主机的 running job 重置回 pending', () => {
    const tpl = repo.createTemplate(db, TEMPLATE)
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const onA = repo.claimNextJob(db, a.id)!
    const onB = repo.claimNextJob(db, b.id)!
    repo.setHostEnabled(db, b.id, false)
    expect(pool.reclaimOrphans()).toBe(1)
    expect(repo.getJob(db, onB.job.id)!.status).toBe('pending')
    expect(repo.getJob(db, onA.job.id)!.status).toBe('running')
  })
})

describe('stopWorker', () => {
  it('停用后 worker 从池中移除', async () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    await pool.stopWorker(a.id)
    expect(pool.hasWorker(a.id)).toBe(false)
  })
})
