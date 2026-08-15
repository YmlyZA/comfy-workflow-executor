import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { Executor, FAILURE_STREAK_LIMIT } from '../src/executor.js'
import { FakeComfy } from './fake-comfy.js'

const TEMPLATE = {
  name: 't',
  comfyJson: { '1': { class_type: 'X', inputs: {} } },
  params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cwe-worker-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(over: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  const db = createDb(':memory:')
  const tpl = repo.createTemplate(db, TEMPLATE)
  const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
  const comfy = new FakeComfy()
  const events = new EventEmitter()
  const ex = new Executor({
    db,
    comfy,
    events,
    dataDir: dir,
    pollMs: 1,
    hostId: host.id,
    hostName: host.name,
    hostKind: 'resident',
    ...over,
  })
  return { db, tpl, host, comfy, events, ex }
}

/** FakeComfy 靠 nextResult 决定下一次 submit 的结果:error 状态即任务失败 */
const ERROR_RESULT = { status: { completed: false, status_str: 'error', messages: ['boom'] } }
const OK_RESULT = {
  status: { completed: true },
  outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
}

describe('worker 盖章', () => {
  it('认领的任务盖上本 worker 的主机章', async () => {
    const { db, tpl, host, ex } = setup()
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    await ex.runPendingOnce()
    const job = repo.getBatchDetail(db, batch.id)!.jobs[0]!
    expect(job.hostId).toBe(host.id)
  })
})

describe('熔断计数', () => {
  it('连续 3 次失败上报一次', async () => {
    const onFailureStreak = vi.fn()
    const { db, tpl, comfy, ex, host } = setup({ onFailureStreak })
    comfy.nextResult = ERROR_RESULT
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }, { p: 3 }] })
    await ex.runPendingOnce()
    await ex.runPendingOnce()
    expect(onFailureStreak).not.toHaveBeenCalled()
    await ex.runPendingOnce()
    expect(onFailureStreak).toHaveBeenCalledTimes(1)
    expect(onFailureStreak).toHaveBeenCalledWith(host.id)
  })

  it('中间成功一次即清零', async () => {
    const onFailureStreak = vi.fn()
    const { db, tpl, comfy, ex } = setup({ onFailureStreak })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }] })
    comfy.nextResult = ERROR_RESULT
    await ex.runPendingOnce()
    await ex.runPendingOnce()
    comfy.nextResult = OK_RESULT
    await ex.runPendingOnce() // 成功 → 清零
    comfy.nextResult = ERROR_RESULT
    await ex.runPendingOnce()
    expect(onFailureStreak).not.toHaveBeenCalled()
    expect(FAILURE_STREAK_LIMIT).toBe(3)
  })
})

describe('停机指令落在 isUp() 的往返里', () => {
  it('isUp 返回前被 stop():本轮不再认领任务', async () => {
    const { db, tpl, comfy, ex } = setup()
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    comfy.isUp = async () => {
      calls++
      await gate
      return true
    }
    ex.start()
    await vi.waitFor(() => expect(calls).toBe(1))
    // 熔断后 pool 推到下一轮的 stopWorker(或用户点停用)正落在这段 await 里
    ex.stop()
    release()
    await ex.pause()
    // 回归点:不复查 running 的话这里会多跑一个任务——熔断实际成了「第 4 次失败才停手」,
    // host-disabled 的提示也要晚整整一个任务才弹出来
    expect(repo.getBatchDetail(db, batch.id)!.jobs[0]!.status).toBe('pending')
  })
})

describe('recover 按主机隔离', () => {
  it('只收割自己主机的 running job', async () => {
    const { db, tpl, host, ex } = setup()
    const other = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const mine = repo.claimNextJob(db, host.id)!
    const theirs = repo.claimNextJob(db, other.id)!
    await ex.recover()
    expect(repo.getJob(db, mine.job.id)!.status).toBe('pending')
    // B 的任务不被 A 碰
    expect(repo.getJob(db, theirs.job.id)!.status).toBe('running')
  })
})

describe('主机不可达超时', () => {
  it('连续不可达达阈值 → 任务回池且 host_id 置空(不计入熔断)', async () => {
    const onFailureStreak = vi.fn()
    let clock = 0
    const { db, tpl, comfy, ex } = setup({
      onFailureStreak,
      now: () => clock,
      unreachableAbandonMs: 1000,
    })
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    // submit 成功后让 getHistory 一直抛错(主机掉线),并在轮询期间推进假时钟
    comfy.getHistory = async () => {
      clock += 400
      throw new Error('ECONNREFUSED')
    }
    await ex.runPendingOnce()
    const job = repo.getBatchDetail(db, batch.id)!.jobs[0]!
    expect(job.status).toBe('pending')
    expect(job.hostId).toBeNull()
    // 不可达不是主机「坏」,不该把健康主机熔断掉
    expect(onFailureStreak).not.toHaveBeenCalled()
  })

  it('未达阈值时继续等待,不放弃任务', async () => {
    let clock = 0
    let calls = 0
    const { db, tpl, comfy, ex } = setup({ now: () => clock, unreachableAbandonMs: 10_000 })
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    comfy.getHistory = async () => {
      calls++
      clock += 100
      if (calls >= 5) {
        // 主机恢复:返回完成结果,任务应正常成功而非被放弃
        return { status: { completed: true }, outputs: {} }
      }
      throw new Error('ECONNREFUSED')
    }
    await ex.runPendingOnce()
    expect(repo.getBatchDetail(db, batch.id)!.jobs[0]!.status).toBe('succeeded')
  })
})

describe('空闲上报', () => {
  it('租用主机空转达阈值上报一次,认领后清零', async () => {
    const onIdle = vi.fn()
    let clock = 0
    const { db, tpl, ex } = setup({
      hostKind: 'rental',
      onIdle,
      now: () => clock,
      idleNotifyMs: 1000,
    })
    await ex.runPendingOnce() // 无活可领 → 开始计时
    clock = 999
    await ex.runPendingOnce()
    expect(onIdle).not.toHaveBeenCalled()
    clock = 1000
    await ex.runPendingOnce()
    expect(onIdle).toHaveBeenCalledTimes(1)
    // 同一次空闲不重复提醒
    clock = 5000
    await ex.runPendingOnce()
    expect(onIdle).toHaveBeenCalledTimes(1)
    // 有活干过之后重新计时
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    await ex.runPendingOnce()
    clock = 10_000
    await ex.runPendingOnce()
    clock = 11_000
    await ex.runPendingOnce()
    expect(onIdle).toHaveBeenCalledTimes(2)
  })

  it('常驻主机不上报空闲', async () => {
    const onIdle = vi.fn()
    let clock = 0
    const { ex } = setup({ hostKind: 'resident', onIdle, now: () => clock, idleNotifyMs: 1000 })
    await ex.runPendingOnce()
    clock = 99_999
    await ex.runPendingOnce()
    expect(onIdle).not.toHaveBeenCalled()
  })
})
