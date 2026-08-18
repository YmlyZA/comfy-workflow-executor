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
  /**
   * 正在收尾(stopWorker 已把它摘出 workers、还在 await pause())的 worker。
   *
   * 没有它的话,优雅停机期间这台主机对 syncFromDb 是「不存在」的:管理员点了
   * 停用-等当前任务跑完、又在 6 分钟的收尾里把它重新设为参与调度,syncFromDb
   * 就会再起一个 worker,新 worker 的 recover() 把 1 号 worker 手上那个还在跑的
   * job 重置回 pending,同一个 job 于是在两块 GPU 上各跑一遍——整套设计赖以成立
   * 的「一个 job 只在一台主机上执行」被两次普通点击破坏。
   */
  private readonly draining = new Map<number, Executor>()

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
      // 收尾中的主机不重复起 worker;收尾结束时 stopWorker 会再 sync 一次,
      // 那时若它仍是「参与调度」就自动回来,不需要用户再点一次
      if (this.workers.has(host.id) || this.draining.has(host.id)) continue
      // 单台起不来不能连累后面的主机:new WebSocket(坏 URL) 会同步抛,
      // 抛在 map 里留个永远不会被重建的死条目、并让循环剩下的主机全都没 worker
      try {
        const worker = this.spawn(host)
        this.workers.set(host.id, worker)
        worker.start()
      } catch (err) {
        this.workers.delete(host.id)
        console.error(`start worker failed (host ${host.id} ${host.url})`, err)
      }
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
    // 已在收尾中的也要接住:并发的 syncFromDb 可能刚用「优雅」模式把它挪进 draining,
    // 此时 disable(interrupt) 若因 workers 里查不到就直接返回,中断意图会被悄悄降级成
    // 等待——路由回了成功,任务既没被打断也没回池。pause() 可重入,再调一次即可补发
    // abandon(两次调用 await 的是同一个 loopPromise)
    const worker = this.workers.get(hostId) ?? this.draining.get(hostId)
    if (!worker) return
    // 先出池:并发的 syncFromDb 不会再看到它,避免重复停机
    this.workers.delete(hostId)
    this.draining.set(hostId, worker)
    try {
      await worker.pause(opts)
    } finally {
      // 收尾期间若又被 stopWorker 换过(理论上不会:同一 hostId 的 worker 只有一个),
      // 不抢别人的收尾记录
      if (this.draining.get(hostId) === worker) {
        this.draining.delete(hostId)
        // 收尾中被重新设为参与调度的主机,在这里自己回来。这段可能跑在备份恢复
        // 换库之后(旧 db 句柄已被关闭):drain 跨越数据库切换是正常情况,
        // resumeAll 早晚会用新句柄重建整个池,这里的 syncFromDb 只是锦上添花,
        // 吞掉即可,不能让它成为悬空 promise 里的未捕获异常。
        try {
          this.syncFromDb()
        } catch (err) {
          console.error(`syncFromDb after drain failed (host ${hostId})`, err)
        }
      }
    }
  }

  /** 改主机 URL 后重建该 worker 的 client */
  async restartWorker(hostId: number): Promise<void> {
    await this.stopWorker(hostId)
    this.syncFromDb()
  }

  /** 收尾中的 worker 也要等:它还在跑任务,漏掉它等于「pauseAll 返回了但还有人在写库」 */
  async pauseAll(opts?: { abandon?: boolean }): Promise<void> {
    const all = new Set([...this.workers.values(), ...this.draining.values()])
    await Promise.all([...all].map((w) => w.pause(opts)))
  }

  /** 数据导入换库后恢复。导入的库自带 hosts 表,旧主机 id 与新库无关:全部丢弃重建 */
  resumeAll(db: Db): void {
    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()
    // 旧库的收尾记录一并作废(它们的 pause() 仍在 await,finally 里的身份校验会
    // 发现自己已不在 draining 中,于是不会再拿新库 sync 一次)
    this.draining.clear()
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

  /** 该主机是否正在收尾(已停止取新活、仍在等当前任务) */
  isDraining(hostId: number): boolean {
    return this.draining.has(hostId)
  }

  size(): number {
    return this.workers.size
  }
}
