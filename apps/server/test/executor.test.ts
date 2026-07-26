import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ParamDef, ParamValues } from '@cwe/shared'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { Executor } from '../src/executor.js'
import { FakeComfy } from './fake-comfy.js'

const comfyJson = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
}
const params = [
  { key: 'prompt', label: 'P', nodeId: '6', inputName: 'text', type: 'text' as const },
]

let db: Db
let comfy: FakeComfy
let events: EventEmitter
let dataDir: string

beforeEach(() => {
  db = createDb(':memory:')
  comfy = new FakeComfy()
  events = new EventEmitter()
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-'))
})

function makeExecutor() {
  return new Executor({ db, comfy, events, dataDir, pollMs: 5 })
}

function seed(
  jobs: ParamValues[] = [{ prompt: 'a' }],
  p: ParamDef[] = params,
  json: Record<string, any> = comfyJson,
) {
  const t = repo.createTemplate(db, { name: 'T', comfyJson: json, params: p })
  return repo.createBatch(db, t.id, { name: 'B', jobs })
}

describe('executor', () => {
  it('runs a job to success and stores outputs on disk', async () => {
    const b = seed()
    const ex = makeExecutor()
    expect(await ex.runPendingOnce()).toBe(true)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('succeeded')
    expect(detail.batch.status).toBe('completed')
    const out = detail.jobs[0]!.outputs![0]!
    expect(out.path).toBe(`${b.id}/0-0-out.png`)
    expect(readFileSync(join(dataDir, 'outputs', out.path), 'utf8')).toBe('png-bytes')
    // 参数注入进了提交的 prompt
    expect(comfy.submitted[0]?.['6'].inputs.text).toBe('a')
  })

  it('uploads image params before submit', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'uploads'), { recursive: true })
    await writeFile(join(dataDir, 'uploads', 'input.png'), 'x')
    seed([{ prompt: 'a', img: 'input.png' }], p)
    const ex = makeExecutor()
    await ex.runPendingOnce()
    expect(comfy.uploads[0]).toBe(join(dataDir, 'uploads', 'input.png'))
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('uploaded-input.png')
  })

  it('marks job failed when comfy reports error', async () => {
    comfy.nextResult = { status: { completed: false, status_str: 'error', messages: ['boom'] } }
    const b = seed()
    const ex = makeExecutor()
    await ex.runPendingOnce()
    const job = repo.getBatchDetail(db, b.id)!.jobs[0]!
    expect(job.status).toBe('failed')
    expect(job.error).toContain('boom')
  })

  it('marks job failed when submit rejects', async () => {
    comfy.submit = async () => {
      throw new Error('400 invalid prompt')
    }
    const b = seed()
    await makeExecutor().runPendingOnce()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('failed')
  })

  it('returns false when no pending jobs', async () => {
    expect(await makeExecutor().runPendingOnce()).toBe(false)
  })

  it('recover(): finished-in-history running job is harvested', async () => {
    const b = seed()
    const claimed = repo.claimNextJob(db)!
    repo.setJobPromptId(db, claimed.job.id, 'p-old')
    comfy.history.set('p-old', comfy.nextResult!)
    await makeExecutor().recover()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('succeeded')
  })

  it('recover(): unknown running job resets to pending', async () => {
    const b = seed()
    repo.claimNextJob(db)
    await makeExecutor().recover()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('pending')
  })

  it('recover(): comfy down resets running jobs to pending', async () => {
    const b = seed()
    const claimed = repo.claimNextJob(db)!
    repo.setJobPromptId(db, claimed.job.id, 'p-x')
    comfy.up = false
    comfy.getHistory = async () => {
      throw new Error('ECONNREFUSED')
    }
    await makeExecutor().recover()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('pending')
  })

  it('emits job-updated and progress events', async () => {
    seed()
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    await makeExecutor().runPendingOnce()
    const types = seen.map((e) => e.type)
    expect(types).toContain('job-updated')
    expect(types).toContain('batch-updated')
  })

  it('emits canceled (not succeeded) when batch canceled mid-run', async () => {
    const b = seed()
    const completed = comfy.nextResult!
    let first = true
    comfy.getHistory = async (promptId: string) => {
      if (first) {
        first = false
        repo.cancelBatch(db, b.id)
        return completed
      }
      return comfy.history.get(promptId) ?? null
    }
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    await makeExecutor().runPendingOnce()

    const job = repo.getBatchDetail(db, b.id)!.jobs[0]!
    expect(job.status).toBe('canceled')

    const jobEvents = seen.filter((e) => e.type === 'job-updated' && e.jobId === job.id)
    expect(jobEvents.some((e) => e.status === 'succeeded')).toBe(false)
    expect(jobEvents.some((e) => e.status === 'canceled')).toBe(true)

    const batchEvents = seen.filter((e) => e.type === 'batch-updated' && e.batchId === b.id)
    expect(batchEvents.some((e) => e.status === 'running')).toBe(false)
    expect(batchEvents.every((e) => e.status === 'canceled')).toBe(true)
  })

  it('fails job when prompt disappears from queue/history after comfyui restart', async () => {
    comfy.nextResult = null
    const b = seed()
    expect(comfy.queued.size).toBe(0)
    const ex = makeExecutor()
    expect(await ex.runPendingOnce()).toBe(true)
    const job = repo.getBatchDetail(db, b.id)!.jobs[0]!
    expect(job.status).toBe('failed')
    expect(job.error).toContain('disappeared')
  })

  it('survives many null history polls while prompt stays in comfyui queue (real-world long job)', async () => {
    comfy.historyDelayPolls = 8 // well past the old 5-null-poll threshold
    const b = seed()
    const ex = makeExecutor()
    expect(await ex.runPendingOnce()).toBe(true)
    const job = repo.getBatchDetail(db, b.id)!.jobs[0]!
    expect(job.status).toBe('succeeded')
  })

  it('survives transient getHistory errors', async () => {
    const b = seed()
    const completed = comfy.nextResult!
    let first = true
    comfy.getHistory = async (promptId: string) => {
      if (first) {
        first = false
        throw new Error('ECONNREFUSED')
      }
      return comfy.history.get(promptId) ?? completed
    }
    await makeExecutor().runPendingOnce()
    const job = repo.getBatchDetail(db, b.id)!.jobs[0]!
    expect(job.status).toBe('succeeded')
  })

  it('image 参数本地不存在时原样注入(引用 GPU 侧文件)', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    seed([{ prompt: 'a', img: 'gpu-side.png' }], p)
    await makeExecutor().runPendingOnce()
    expect(comfy.uploads).toHaveLength(0)
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('gpu-side.png')
  })

  it('image 参数含 .. 时不读本地原样传', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    seed([{ prompt: 'a', img: '../secret.png' }], p)
    await makeExecutor().runPendingOnce()
    expect(comfy.uploads).toHaveLength(0)
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('../secret.png')
  })

  it('同一本地文件多个 job 只上传一次(进程内缓存)', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'uploads'), { recursive: true })
    await writeFile(join(dataDir, 'uploads', 'input.png'), 'x')
    seed(
      [
        { prompt: 'a', img: 'input.png' },
        { prompt: 'b', img: 'input.png' },
      ],
      p,
    )
    const ex = makeExecutor()
    await ex.runPendingOnce()
    await ex.runPendingOnce()
    expect(comfy.uploads).toHaveLength(1)
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('uploaded-input.png')
    expect(comfy.submitted[1]?.['10'].inputs.image).toBe('uploaded-input.png')
  })

  it('outputs 带 GPU 侧引用(供删除 batch 时清理)', async () => {
    const b = seed()
    await makeExecutor().runPendingOnce()
    const out = repo.getBatchDetail(db, b.id)!.jobs[0]!.outputs![0]!
    expect(out.gpu).toEqual({ filename: 'out.png', subfolder: '' })
  })
})
