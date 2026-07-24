import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { buildPrompt, type OutputFile } from '@cwe/shared'
import type { ComfyClient, ComfyHistoryEntry } from './comfy/client.js'
import { extractOutputRefs } from './comfy/client.js'
import type { Db } from './db/index.js'
import * as repo from './db/repo.js'
import type { Job, Template } from './db/schema.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ExecutorDeps {
  db: Db
  comfy: ComfyClient
  events: EventEmitter
  dataDir: string
  pollMs?: number
}

export class Executor {
  private readonly db: Db
  private readonly comfy: ComfyClient
  private readonly events: EventEmitter
  private readonly dataDir: string
  private readonly pollMs: number
  private readonly clientId = randomUUID()
  private running = false
  private currentJobId: number | null = null
  private disconnectWs: (() => void) | null = null

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
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.disconnectWs?.()
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
      repo.failJob(this.db, job.id, err instanceof Error ? err.message : String(err))
      const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'failed'
      this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: finalStatus })
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
        values[def.key] = await this.comfy.uploadImage(join(this.dataDir, 'uploads', v))
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
    for (;;) {
      let entry: ComfyHistoryEntry | null
      try {
        entry = await this.comfy.getHistory(promptId)
      } catch {
        // ComfyUI 掉线：等待重连，batch 保持 running 不失败
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
      outputs.push({ path: `${job.batchId}/${filename}`, filename })
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
