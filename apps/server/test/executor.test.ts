import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ParamDef, ParamValues } from '@cwe/shared'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { Executor } from '../src/executor.js'
import type { ComfyClient, ComfyHistoryEntry, OutputRef } from '../src/comfy/client.js'

class FakeComfy implements ComfyClient {
  up = true
  submitted: Array<Record<string, any>> = []
  uploads: string[] = []
  history = new Map<string, ComfyHistoryEntry>()
  private n = 0
  /** 每次 submit 后自动写入的 history 结果；null 表示留空（pending 中） */
  nextResult: ComfyHistoryEntry | null = {
    status: { completed: true },
    outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
  }

  async isUp() {
    return this.up
  }
  async interrupt() {}
  async uploadImage(filePath: string) {
    this.uploads.push(filePath)
    return `uploaded-${basename(filePath)}`
  }
  async submit(prompt: Record<string, any>) {
    this.submitted.push(prompt)
    const id = `p${++this.n}`
    if (this.nextResult) this.history.set(id, this.nextResult)
    return id
  }
  async getHistory(promptId: string) {
    return this.history.get(promptId) ?? null
  }
  async downloadOutput(_ref: OutputRef, destPath: string) {
    await writeFile(destPath, 'png-bytes')
  }
  connectEvents() {
    return () => {}
  }
}

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
})
