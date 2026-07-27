import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

let db: Db
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  db = createDb(':memory:')
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db,
    comfy: null,
    events: new EventEmitter(),
  })
})

const comfyJson = {
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 4 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
}

const seedParam = { key: 'seed', label: 'Seed', nodeId: '3', inputName: 'seed', type: 'seed' as const }
const seed2Param = { key: 'seed2', label: 'Seed2', nodeId: '3', inputName: 'steps', type: 'seed' as const }
const promptParam = { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' as const }

function makeTemplate(params: Array<typeof seedParam | typeof promptParam>) {
  return repo.createTemplate(db, { name: 'T', comfyJson, params })
}

/** 用 repo 层把队列里的 pending 任务全部跑成 succeeded */
function succeedAll() {
  for (;;) {
    const claimed = repo.claimNextJob(db)
    if (!claimed) break
    repo.finishJob(db, claimed.job.id, [])
    repo.markBatchCompletedIfDone(db, claimed.job.batchId)
  }
}

async function reroll(batchId: number, jobId: number) {
  return app.request(`/api/batches/${batchId}/jobs/${jobId}/reroll`, { method: 'POST', headers: H })
}

describe('POST /api/batches/:id/jobs/:jobId/reroll', () => {
  it('成功:追加新 pending job,seed 换随机,sortOrder 递增,batch 复活 running', async () => {
    const t = makeTemplate([seedParam, promptParam])
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{ seed: 42, prompt: 'a' }] })
    succeedAll()
    expect(repo.getBatchStatus(db, b.id)).toBe('completed')
    const src = repo.getBatchDetail(db, b.id)!.jobs[0]!
    const res = await reroll(b.id, src.id)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { jobId: number; sortOrder: number }
    expect(body.sortOrder).toBe(1)
    const fresh = repo.getJob(db, body.jobId)!
    expect(fresh.status).toBe('pending')
    expect(fresh.params.prompt).toBe('a')
    expect(typeof fresh.params.seed).toBe('number')
    expect(fresh.params.seed).not.toBe(42)
    expect(repo.getBatchStatus(db, b.id)).toBe('running')
  })

  it('复活的 batch 可被认领,完成后回 completed', async () => {
    const t = makeTemplate([seedParam])
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{ seed: 1 }] })
    succeedAll()
    const src = repo.getBatchDetail(db, b.id)!.jobs[0]!
    const res = await reroll(b.id, src.id)
    expect(res.status).toBe(201)
    succeedAll()
    expect(repo.getBatchStatus(db, b.id)).toBe('completed')
    const all = repo.getBatchDetail(db, b.id)!.jobs
    expect(all).toHaveLength(2)
    expect(all.every((j) => j.status === 'succeeded')).toBe(true)
  })

  it('多个 seed 参数各自替换为随机数', async () => {
    const t = makeTemplate([seedParam, seed2Param])
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{ seed: 7, seed2: 8 }] })
    succeedAll()
    const src = repo.getBatchDetail(db, b.id)!.jobs[0]!
    const res = await reroll(b.id, src.id)
    expect(res.status).toBe(201)
    const fresh = repo.getJob(db, ((await res.json()) as { jobId: number }).jobId)!
    expect(typeof fresh.params.seed).toBe('number')
    expect(typeof fresh.params.seed2).toBe('number')
    expect(fresh.params.seed).not.toBe(7)
    expect(fresh.params.seed2).not.toBe(8)
  })

  it('源 params 缺 seed key 时也写入随机值(覆盖模板默认)', async () => {
    const t = makeTemplate([seedParam, promptParam])
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{ prompt: 'a' }] })
    succeedAll()
    const src = repo.getBatchDetail(db, b.id)!.jobs[0]!
    const res = await reroll(b.id, src.id)
    expect(res.status).toBe(201)
    const fresh = repo.getJob(db, ((await res.json()) as { jobId: number }).jobId)!
    expect(typeof fresh.params.seed).toBe('number')
  })

  it('非 succeeded job 返回 400(failed 与 pending)', async () => {
    const t = makeTemplate([seedParam])
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{ seed: 1 }, { seed: 2 }] })
    const claimed = repo.claimNextJob(db)!
    repo.failJob(db, claimed.job.id, 'boom')
    const jobsNow = repo.getBatchDetail(db, b.id)!.jobs
    const failedJob = jobsNow.find((j) => j.status === 'failed')!
    const pendingJob = jobsNow.find((j) => j.status === 'pending')!
    expect((await reroll(b.id, failedJob.id)).status).toBe(400)
    expect((await reroll(b.id, pendingJob.id)).status).toBe(400)
  })

  it('模板无 seed 参数返回 409 且不插任务', async () => {
    const t = makeTemplate([promptParam])
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{ prompt: 'a' }] })
    succeedAll()
    const src = repo.getBatchDetail(db, b.id)!.jobs[0]!
    const res = await reroll(b.id, src.id)
    expect(res.status).toBe(409)
    expect(repo.getBatchDetail(db, b.id)!.jobs).toHaveLength(1)
    expect(repo.getBatchStatus(db, b.id)).toBe('completed')
  })

  it('batch 不存在/job 不存在/job 不属于该 batch 返回 404', async () => {
    const t = makeTemplate([seedParam])
    const b1 = repo.createBatch(db, t.id, { name: 'B1', jobs: [{ seed: 1 }] })
    const b2 = repo.createBatch(db, t.id, { name: 'B2', jobs: [{ seed: 2 }] })
    succeedAll()
    const j1 = repo.getBatchDetail(db, b1.id)!.jobs[0]!
    expect((await reroll(999, j1.id)).status).toBe(404)
    expect((await reroll(b1.id, 999)).status).toBe(404)
    expect((await reroll(b2.id, j1.id)).status).toBe(404)
  })
})
