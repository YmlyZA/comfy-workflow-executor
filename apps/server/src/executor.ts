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

export interface ExecutorDeps {
  db: Db
  comfy: ComfyClient
  events: EventEmitter
  dataDir: string
  pollMs?: number
}

export class Executor {
  private db: Db
  private comfy: ComfyClient
  private readonly events: EventEmitter
  private readonly dataDir: string
  private readonly pollMs: number
  private readonly clientId = randomUUID()
  private running = false
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
  }

  start(): void {
    this.running = true
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
   * waitForHistory 察觉标志后抛 AbandonError,job 重置回 pending 由新主机重跑 */
  async pause(opts?: { abandon?: boolean }): Promise<void> {
    this.stop()
    if (opts?.abandon) {
      this.abandonRequested = true
      await this.comfy.interrupt().catch(() => {})
    }
    await this.loopPromise
    this.loopPromise = null
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
    const claimed = repo.claimNextJob(this.db)
    if (!claimed) return false
    const { job, template } = claimed
    this.currentJobId = job.id
    this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'running' })
    try {
      const outputs = await this.execute(job, template)
      repo.finishJob(this.db, job.id, outputs)
      const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'succeeded'
      this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: finalStatus })
    } catch (err) {
      if (err instanceof AbandonError) {
        repo.resetJobToPending(this.db, job.id)
        this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'pending' })
      } else {
        repo.failJob(this.db, job.id, err instanceof Error ? err.message : String(err))
        const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'failed'
        this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: finalStatus })
      }
    } finally {
      this.currentJobId = null
    }
    repo.markBatchCompletedIfDone(this.db, job.batchId)
    const batchStatus = repo.getBatchStatus(this.db, job.batchId) ?? 'running'
    this.emit({ type: 'batch-updated', batchId: job.batchId, status: batchStatus })
    return true
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
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
        continue
      }
      backoff = this.pollMs
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

  /** 启动时收割/重置 running 状态残留的 job。 */
  async recover(): Promise<void> {
    for (const job of repo.listRunningJobs(this.db)) {
      let recovered = false
      if (job.comfyPromptId) {
        try {
          const entry = await this.comfy.getHistory(job.comfyPromptId)
          if (entry?.status?.completed) {
            repo.finishJob(this.db, job.id, await this.collectOutputs(job, entry))
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
