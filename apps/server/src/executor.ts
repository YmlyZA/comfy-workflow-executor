import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { buildPrompt, type OutputFile } from '@cwe/shared'
import type { ComfyClient, ComfyHistoryEntry } from './comfy/client.js'
import { extractOutputRefs } from './comfy/client.js'
import type { Db } from './db/index.js'
import * as repo from './db/repo.js'
import type { Job, Template } from './db/schema.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 主机切换的中断模式:放弃当前 job(重置回 pending 而非 failed) */
class AbandonError extends Error {}

/** 已停机(pause 等待中)时,getHistory 连续失败多少轮就判定主机已死并放弃当前 job */
const UNREACHABLE_ABANDON_POLLS = 3
/** 运行中的 worker:主机连续不可达超过此时长即放弃当前 job,让它回池由别的主机接手 */
export const UNREACHABLE_ABANDON_MS = 120_000
/** 连续多少个任务失败判定主机坏掉 */
export const FAILURE_STREAK_LIMIT = 3
/** 租用主机空转多久提醒一次 */
export const IDLE_NOTIFY_MS = 300_000

export interface ExecutorDeps {
  db: Db
  comfy: ComfyClient
  events: EventEmitter
  dataDir: string
  pollMs?: number
  hostId: number
  hostName: string
  hostKind: 'resident' | 'rental'
  /** 连续失败达 FAILURE_STREAK_LIMIT 时回调一次。worker 只上报,停机由 pool 决定 */
  onFailureStreak?: (hostId: number) => void
  /** 租用主机空转达阈值时回调一次 */
  onIdle?: (hostId: number, idleMs: number) => void
  now?: () => number
  unreachableAbandonMs?: number
  idleNotifyMs?: number
}

export class Executor {
  private db: Db
  private comfy: ComfyClient
  private readonly events: EventEmitter
  private readonly dataDir: string
  private readonly pollMs: number
  readonly hostId: number
  private readonly hostName: string
  private readonly hostKind: 'resident' | 'rental'
  private readonly onFailureStreak?: (hostId: number) => void
  private readonly onIdle?: (hostId: number, idleMs: number) => void
  private readonly now: () => number
  private readonly unreachableAbandonMs: number
  private readonly idleNotifyMs: number
  /** 连续失败计数;成功一次清零。内存态,worker 重启即归零 */
  private failureStreak = 0
  /** 本轮空闲的起点(毫秒);null = 当前不处于空闲 */
  private idleSince: number | null = null
  /** 本轮空闲是否已提醒过,防止每轮重复 toast */
  private idleNotified = false
  private readonly clientId = randomUUID()
  private running = false
  /** 是否曾经 start() 过;用于区分"从未起循环,直接调用 runPendingOnce()"(测试/单次调用)
   * 与"起过循环,现在 stop() 了"(pause() 热切换等待收尾)—— 两者 running 都是 false,
   * 但只有后者才该用 UNREACHABLE_ABANDON_POLLS 这套"停机等待"逻辑提前放弃 */
  private started = false
  private currentJobId: number | null = null
  private disconnectWs: (() => void) | null = null
  private loopPromise: Promise<void> | null = null
  private abandonRequested = false
  /** 本地 stored 名 → GPU 侧返回名;进程内去重,重启后靠 overwrite 幂等重传 */
  private readonly gpuUploads = new Map<string, string>()

  constructor(deps: ExecutorDeps) {
    this.db = deps.db
    this.comfy = deps.comfy
    this.events = deps.events
    this.dataDir = deps.dataDir
    this.pollMs = deps.pollMs ?? 2000
    this.hostId = deps.hostId
    this.hostName = deps.hostName
    this.hostKind = deps.hostKind
    this.onFailureStreak = deps.onFailureStreak
    this.onIdle = deps.onIdle
    this.now = deps.now ?? Date.now
    this.unreachableAbandonMs = deps.unreachableAbandonMs ?? UNREACHABLE_ABANDON_MS
    this.idleNotifyMs = deps.idleNotifyMs ?? IDLE_NOTIFY_MS
  }

  /** 起循环。已在跑时直接返回:重复 start 会起出第二个 loop(其中一个成孤儿,
   * 永远不会被 pause 等到),并造成同一批 job 被两条流水线重复认领 */
  start(): void {
    if (this.running) return
    this.running = true
    this.started = true
    this.disconnectWs = this.comfy.connectEvents(this.clientId, (e) => {
      if (e.type === 'progress' && this.currentJobId != null) {
        this.emit({
          type: 'progress',
          jobId: this.currentJobId,
          value: e.data?.value ?? 0,
          max: e.data?.max ?? 0,
        })
      }
    })
    this.loopPromise = this.loop()
  }

  stop(): void {
    this.running = false
    this.disconnectWs?.()
  }

  /** 停下并等当前任务/轮询收尾(导入热切换与主机切换共用)。
   * abandon:放弃当前 job——对旧主机发 interrupt(失败吞掉,主机可能已死),
   * waitForHistory 察觉标志后抛 AbandonError,job 重置回 pending 由新主机重跑。
   *
   * stop() 必须排在 interrupt 之前:interrupt 是一次网络往返,期间若循环还在跑,
   * 它会立刻认领并提交下一个 job(甚至把刚被放弃的这个重新捞起来)提交到即将被
   * 弃用的旧主机上。先置 running=false 才能保证这轮往返里循环不再取新活。 */
  async pause(opts?: { abandon?: boolean }): Promise<void> {
    this.stop()
    if (opts?.abandon) {
      this.abandonRequested = true
      await this.comfy.interrupt().catch(() => {})
    }
    // 捕获自己要等的那个 loop:若期间已有人 start 了新 loop,不能把新的 loopPromise
    // 抹成 null(否则下一次 pause 会瞬间返回,却有循环仍在后台跑)
    const pending = this.loopPromise
    await pending
    if (this.loopPromise === pending) this.loopPromise = null
    this.abandonRequested = false
  }

  /** 换库/换主机后重启;GPU 上传映射清空,靠 overwrite 幂等重传 */
  resume(db: Db, comfy?: ComfyClient): void {
    this.db = db
    if (comfy) this.comfy = comfy
    this.gpuUploads.clear()
    this.start()
  }

  private async loop(): Promise<void> {
    await this.recover().catch((err) => console.error('recover failed', err))
    let offlineBackoff = this.pollMs
    while (this.running) {
      if (!(await this.comfy.isUp())) {
        await sleep(offlineBackoff)
        offlineBackoff = Math.min(offlineBackoff * 2, 30_000)
        continue
      }
      offlineBackoff = this.pollMs
      const didWork = await this.runPendingOnce().catch((err) => {
        console.error('executor iteration failed', err)
        return false
      })
      if (!didWork) await sleep(this.pollMs)
    }
  }

  /** 处理一个 pending job；无任务返回 false。测试入口。 */
  async runPendingOnce(): Promise<boolean> {
    const claimed = repo.claimNextJob(this.db, this.hostId)
    if (!claimed) {
      this.trackIdle()
      return false
    }
    this.idleSince = null
    this.idleNotified = false
    const { job, template } = claimed
    this.currentJobId = job.id
    this.emit({
      type: 'job-updated',
      jobId: job.id,
      batchId: job.batchId,
      status: 'running',
      hostId: this.hostId,
    })
    try {
      const outputs = await this.execute(job, template)
      repo.finishJob(this.db, job.id, outputs)
      this.failureStreak = 0
      const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'succeeded'
      this.emit({
        type: 'job-updated',
        jobId: job.id,
        batchId: job.batchId,
        status: finalStatus,
        hostId: this.hostId,
      })
    } catch (err) {
      if (err instanceof AbandonError) {
        // 主动放弃/主机不可达:不是主机「坏」,不计入熔断
        repo.resetJobToPending(this.db, job.id)
        this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'pending' })
      } else {
        repo.failJob(this.db, job.id, err instanceof Error ? err.message : String(err))
        const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'failed'
        this.emit({
          type: 'job-updated',
          jobId: job.id,
          batchId: job.batchId,
          status: finalStatus,
          hostId: this.hostId,
        })
        this.failureStreak++
        if (this.failureStreak >= FAILURE_STREAK_LIMIT) {
          this.failureStreak = 0
          this.onFailureStreak?.(this.hostId)
        }
      }
    } finally {
      this.currentJobId = null
    }
    repo.markBatchCompletedIfDone(this.db, job.batchId)
    const batchStatus = repo.getBatchStatus(this.db, job.batchId) ?? 'running'
    this.emit({ type: 'batch-updated', batchId: job.batchId, status: batchStatus })
    return true
  }

  /** 租用主机空转计时:达阈值上报一次,直到下次真正干活才会再次计时 */
  private trackIdle(): void {
    if (this.hostKind !== 'rental' || !this.onIdle) return
    const t = this.now()
    if (this.idleSince === null) {
      this.idleSince = t
      return
    }
    const idleMs = t - this.idleSince
    if (!this.idleNotified && idleMs >= this.idleNotifyMs) {
      this.idleNotified = true
      this.onIdle(this.hostId, idleMs)
    }
  }

  private async execute(job: Job, template: Template): Promise<OutputFile[]> {
    const values = { ...job.params }
    for (const def of template.params) {
      if (def.type !== 'image') continue
      const v = values[def.key] ?? def.default
      if (typeof v === 'string' && v) {
        const local = join(this.dataDir, 'uploads', v)
        // 本地 uploads 有则上传替换;没有(或含 ../绝对路径)原样传,引用 GPU 侧 input 已有文件
        if (!v.includes('..') && !isAbsolute(v) && existsSync(local)) {
          let gpuName = this.gpuUploads.get(v)
          if (!gpuName) {
            gpuName = await this.comfy.uploadImage(local)
            this.gpuUploads.set(v, gpuName)
          }
          values[def.key] = gpuName
        }
      }
    }
    const prompt = buildPrompt(template.comfyJson, template.params, values)
    const promptId = await this.comfy.submit(prompt, this.clientId)
    repo.setJobPromptId(this.db, job.id, promptId)
    const entry = await this.waitForHistory(promptId)
    return this.collectOutputs(job, entry)
  }

  private async waitForHistory(promptId: string): Promise<ComfyHistoryEntry> {
    let backoff = this.pollMs
    let lostCount = 0
    let errorCount = 0
    let unreachableSince: number | null = null
    for (;;) {
      if (this.abandonRequested) throw new AbandonError('主机切换,放弃当前任务')
      let entry: ComfyHistoryEntry | null
      let stillQueued = true
      try {
        entry = await this.comfy.getHistory(promptId)
        if (entry === null) {
          // history 尚未写入：正常情况下 prompt 仍在 ComfyUI 的队列中（排队或执行中）。
          // 只有当它既不在 history 也不在队列里时，才可能是 ComfyUI 重启丢失了任务。
          const queued = await this.comfy.getQueuedIds()
          stillQueued = queued.has(promptId)
        }
      } catch {
        // ComfyUI 掉线 / 查询失败：等待重连，batch 保持 running 不失败
        errorCount++
        if (unreachableSince === null) unreachableSince = this.now()
        // 例外 1:已被 stop()(热切换等待模式在等收尾)且主机连续多轮不可达 —— 说明这台
        // 主机已经死了,再等下去 pause() 永远不返回、切换界面一直转圈。started 用来排除
        // "从未 start() 过、直接调用 runPendingOnce()"(单测/单次调用)这种同样 running=false
        // 但根本不在热切换收尾中的场景,否则它会被这套"停机等待"逻辑提前误判放弃。
        if (this.started && !this.running && errorCount >= UNREACHABLE_ABANDON_POLLS) {
          throw new AbandonError('主机连续不可达,放弃当前任务')
        }
        // 例外 2:运行中的 worker 连续不可达超过阈值 —— 并行下不能无限等,否则这台主机
        // 手上的任务成了僵尸:别的主机照常干活,它永远 running,batch 永远完不成。
        if (this.now() - unreachableSince >= this.unreachableAbandonMs) {
          throw new AbandonError('主机不可达超时,任务回池由其他主机接手')
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
        continue
      }
      backoff = this.pollMs
      errorCount = 0
      unreachableSince = null
      if (entry?.status?.completed) return entry
      if (entry?.status?.status_str === 'error') {
        throw new Error(
          `comfyui execution error: ${JSON.stringify(entry.status.messages ?? []).slice(0, 500)}`,
        )
      }
      if (entry === null) {
        if (stillQueued) {
          lostCount = 0
        } else {
          // 队列相对 history 移除可能有短暂延迟，因此要求连续多次观测到
          // "不在队列且不在 history" 才判定丢失。
          lostCount++
          if (lostCount >= 3) {
            throw new Error('prompt disappeared from comfyui queue/history (comfyui restarted?)')
          }
        }
      } else {
        lostCount = 0
      }
      await sleep(this.pollMs)
    }
  }

  private async collectOutputs(job: Job, entry: ComfyHistoryEntry): Promise<OutputFile[]> {
    const refs = extractOutputRefs(entry)
    const dir = join(this.dataDir, 'outputs', String(job.batchId))
    mkdirSync(dir, { recursive: true })
    const outputs: OutputFile[] = []
    for (const [i, ref] of refs.entries()) {
      const filename = `${job.sortOrder}-${i}-${ref.filename}`
      await this.comfy.downloadOutput(ref, join(dir, filename))
      outputs.push({
        path: `${job.batchId}/${filename}`,
        filename,
        gpu: { filename: ref.filename, subfolder: ref.subfolder },
      })
    }
    return outputs
  }

  /** 启动时收割/重置**本主机**残留的 running job。
   * 并行下不能收割全表:那会把其他主机正在跑的任务判死。 */
  async recover(): Promise<void> {
    for (const job of repo.listRunningJobsByHost(this.db, this.hostId)) {
      let recovered = false
      if (job.comfyPromptId) {
        try {
          const entry = await this.comfy.getHistory(job.comfyPromptId)
          if (entry?.status?.completed) {
            repo.finishJob(this.db, job.id, await this.collectOutputs(job, entry))
            recovered = true
          } else if (entry?.status?.status_str === 'error') {
            // history 已记录执行失败:直接置 failed,重置回 pending 只会原样再错一遍
            repo.failJob(
              this.db,
              job.id,
              `comfyui execution error: ${JSON.stringify(entry.status.messages ?? []).slice(0, 500)}`,
            )
            recovered = true
          }
        } catch {
          /* comfy 不可达 → 走重置 */
        }
      }
      if (!recovered) repo.resetJobToPending(this.db, job.id)
      repo.markBatchCompletedIfDone(this.db, job.batchId)
    }
  }

  private emit(payload: Record<string, unknown>): void {
    this.events.emit('event', payload)
  }
}
