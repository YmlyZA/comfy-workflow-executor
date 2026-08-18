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
    // 真实调用方(disable / DELETE / 熔断)都先落库再停 worker:收尾结束时池会按
    // hosts 表再对齐一次,库里仍写着「参与调度」的主机本就该被重新起起来
    repo.setHostEnabled(db, a.id, false)
    await pool.stopWorker(a.id)
    expect(pool.hasWorker(a.id)).toBe(false)
  })
})

/** 让 A 的 worker 卡在 isUp() 上:pause() 要等 loop 收尾,于是 stopWorker 一直停在收尾中,
 * 精确复现「停用-等当前任务跑完」那几分钟的窗口 */
function hostStuckInLoop(): { hostId: number; fake: FakeComfy; release: () => void } {
  const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
  const fake = new FakeComfy()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  fake.isUp = async () => {
    await gate
    return true
  }
  clients.set('http://a:8188', fake)
  pool.syncFromDb()
  return { hostId: a.id, fake, release }
}

describe('收尾期间的重新启用', () => {
  it('收尾没结束不重复起 worker,收尾结束后自己回池', async () => {
    const { hostId, release } = hostStuckInLoop()
    repo.setHostEnabled(db, hostId, false)
    const stopping = pool.stopWorker(hostId) // 「等当前任务跑完」,一直不返回
    expect(pool.hasWorker(hostId)).toBe(false)
    expect(pool.isDraining(hostId)).toBe(true)

    // 收尾途中用户又把它设回「参与调度」(UI 60s 轮询会把卡片刷回可点状态)
    repo.setHostEnabled(db, hostId, true)
    pool.syncFromDb()
    // 回归点:旧实现在这里起出 worker #2,它的 recover() 会把 #1 手上还在跑的
    // job 重置回 pending,同一个 job 于是在两块 GPU 上各跑一遍
    expect(pool.hasWorker(hostId)).toBe(false)
    expect(pool.size()).toBe(0)

    release()
    await stopping
    // 收尾结束后自动补起,不需要用户再点一次
    expect(pool.hasWorker(hostId)).toBe(true)
  })

  it('收尾中的主机被删/被停用时不会莫名其妙地回来', async () => {
    const { hostId, release } = hostStuckInLoop()
    repo.setHostEnabled(db, hostId, false)
    const stopping = pool.stopWorker(hostId)
    release()
    await stopping
    expect(pool.hasWorker(hostId)).toBe(false)
    expect(pool.isDraining(hostId)).toBe(false)
  })

  it('收尾中再发 abandon 不被降级成等待(中断意图必须送达)', async () => {
    const { hostId, fake, release } = hostStuckInLoop()
    // 并发的 syncFromDb 先用「优雅」模式把它挪进收尾
    const draining = pool.stopWorker(hostId)
    expect(pool.isDraining(hostId)).toBe(true)
    // 紧接着 disable(interrupt) 进来:旧实现在 workers 里查不到就直接返回,
    // 路由回了成功,任务既没被中断也没回池
    const abandoning = pool.stopWorker(hostId, { abandon: true })
    await vi.waitFor(() => expect(fake.interrupts).toBe(1))
    release()
    await Promise.all([draining, abandoning])
  })
})

describe('单台主机起 worker 失败', () => {
  it('不连累其他主机,也不在池里留下永不重建的死条目', () => {
    const bad = repo.createHost(db, { name: 'BAD', url: 'bad-url' })
    const good = repo.createHost(db, { name: 'G', url: 'http://g:8188' })
    // 真实场景:无 scheme 的 URL 会让 connectEvents 里的 new WebSocket 同步抛
    const broken = new FakeComfy()
    broken.connectEvents = () => {
      throw new TypeError('Invalid URL')
    }
    clients.set('bad-url', broken)
    pool.syncFromDb()
    expect(pool.hasWorker(bad.id)).toBe(false)
    // 回归点:旧实现抛在循环里,排在坏主机后面的好主机全都拿不到 worker
    expect(pool.hasWorker(good.id)).toBe(true)
    // 死条目会挡住重建:URL 改好后再 sync 应该能起来
    clients.set('bad-url', new FakeComfy())
    pool.syncFromDb()
    expect(pool.hasWorker(bad.id)).toBe(true)
  })
})
