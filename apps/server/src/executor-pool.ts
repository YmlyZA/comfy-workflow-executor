import type { EventEmitter } from 'node:events'
import type { ComfyClient } from './comfy/client.js'
import type { Db } from './db/index.js'
import type { Host } from './db/schema.js'
import * as repo from './db/repo.js'
import { Executor, FAILURE_STREAK_LIMIT } from './executor.js'

export interface ExecutorPoolDeps {
  db: Db
  events: EventEmitter
  dataDir: string
  comfyFactory: (url: string) => ComfyClient
  pollMs?: number
  now?: () => number
}

/**
 * 每台「参与调度」的主机一个 Executor 实例,本类只管生命周期。
 *
 * 边界:worker 不改自己的生死。熔断由 worker 上报、本类落库并停机——否则
 * worker 自杀式停机会与 syncFromDb 的对齐逻辑打架。
 */
export class ExecutorPool {
  private db: Db
  private readonly events: EventEmitter
  private readonly dataDir: string
  private readonly comfyFactory: (url: string) => ComfyClient
  private readonly pollMs?: number
  private readonly now?: () => number
  private readonly workers = new Map<number, Executor>()

  constructor(deps: ExecutorPoolDeps) {
    this.db = deps.db
    this.events = deps.events
    this.dataDir = deps.dataDir
    this.comfyFactory = deps.comfyFactory
    this.pollMs = deps.pollMs
    this.now = deps.now
  }

  /** 按 hosts 表对齐 worker 集合。幂等:已有 worker 的主机不会被重复起 */
  syncFromDb(): void {
    const enabled = repo.listEnabledHosts(this.db)
    const wanted = new Set(enabled.map((h) => h.id))
    for (const hostId of [...this.workers.keys()]) {
      if (!wanted.has(hostId)) void this.stopWorker(hostId)
    }
    for (const host of enabled) {
      if (this.workers.has(host.id)) continue
      const worker = this.spawn(host)
      this.workers.set(host.id, worker)
      worker.start()
    }
  }

  private spawn(host: Host): Executor {
    return new Executor({
      db: this.db,
      comfy: this.comfyFactory(host.url),
      events: this.events,
      dataDir: this.dataDir,
      pollMs: this.pollMs,
      hostId: host.id,
      hostName: host.name,
      hostKind: host.kind,
      now: this.now,
      onFailureStreak: (hostId) => this.handleFailureStreak(hostId),
      onIdle: (hostId, idleMs) => this.handleIdle(hostId, idleMs),
    })
  }

  /**
   * 熔断上报处理。**必须推到下一轮事件循环**:worker 是在自己的循环里回调进来的,
   * 此处若同步 await 它的 pause(),而 pause() 要等的正是那个调用方 loop —— 自己等
   * 自己,永久死锁。setImmediate 让当前迭代先返回。
   */
  private handleFailureStreak(hostId: number): void {
    setImmediate(() => void this.disableForFailure(hostId))
  }

  private async disableForFailure(hostId: number): Promise<void> {
    const host = repo.setHostEnabled(
      this.db,
      hostId,
      false,
      `连续 ${FAILURE_STREAK_LIMIT} 次任务失败`,
    )
    await this.stopWorker(hostId)
    this.events.emit('event', {
      type: 'host-disabled',
      hostId,
      hostName: host?.name ?? null,
      reason: host?.disabledReason ?? null,
    })
  }

  private handleIdle(hostId: number, idleMs: number): void {
    const host = repo.getHost(this.db, hostId)
    this.events.emit('event', {
      type: 'host-idle',
      hostId,
      hostName: host?.name ?? null,
      idleMinutes: Math.floor(idleMs / 60_000),
    })
  }

  /** 停一台 worker。abandon=true 时放弃在跑的任务并重置回 pending */
  async stopWorker(hostId: number, opts?: { abandon?: boolean }): Promise<void> {
    const worker = this.workers.get(hostId)
    if (!worker) return
    // 先出池:并发的 syncFromDb 不会再看到它,避免重复停机
    this.workers.delete(hostId)
    await worker.pause(opts)
  }

  /** 改主机 URL 后重建该 worker 的 client */
  async restartWorker(hostId: number): Promise<void> {
    await this.stopWorker(hostId)
    this.syncFromDb()
  }

  async pauseAll(opts?: { abandon?: boolean }): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.pause(opts)))
  }

  /** 数据导入换库后恢复。导入的库自带 hosts 表,旧主机 id 与新库无关:全部丢弃重建 */
  resumeAll(db: Db): void {
    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()
    this.db = db
    this.reclaimOrphans()
    this.syncFromDb()
  }

  /** 启动时回收无主的 running job(主机已删/已停用/历史数据没盖章) */
  reclaimOrphans(): number {
    return repo.reclaimOrphanJobs(
      this.db,
      repo.listEnabledHosts(this.db).map((h) => h.id),
    )
  }

  hasWorker(hostId: number): boolean {
    return this.workers.has(hostId)
  }

  size(): number {
    return this.workers.size
  }
}
