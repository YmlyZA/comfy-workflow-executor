import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

const comfyJson = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } }
const params = [
  { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' as const },
]

let db: Db
beforeEach(() => {
  db = createDb(':memory:')
})

function seedBatch(jobs = [{ prompt: 'a' }, { prompt: 'b' }]) {
  const t = repo.createTemplate(db, { name: 'T', comfyJson, params })
  const b = repo.createBatch(db, t.id, { name: 'B', jobs })
  return { t, b }
}

describe('templates', () => {
  it('create/list/get/delete roundtrip', () => {
    const t = repo.createTemplate(db, { name: 'T', comfyJson, params })
    expect(repo.listTemplates(db)).toHaveLength(1)
    expect(repo.getTemplate(db, t.id)?.params[0]?.key).toBe('prompt')
    repo.deleteTemplate(db, t.id)
    expect(repo.listTemplates(db)).toHaveLength(0)
  })
})

describe('claimNextJob', () => {
  it('claims jobs in order and marks batch running', () => {
    const { b } = seedBatch()
    const c1 = repo.claimNextJob(db)
    expect(c1?.job.params).toEqual({ prompt: 'a' })
    expect(c1?.job.status).toBe('running')
    expect(c1?.template.name).toBe('T')
    expect(repo.getBatchDetail(db, b.id)?.batch.status).toBe('running')
    const c2 = repo.claimNextJob(db)
    expect(c2?.job.params).toEqual({ prompt: 'b' })
  })

  it('returns undefined when nothing pending', () => {
    expect(repo.claimNextJob(db)).toBeUndefined()
  })

  it('skips jobs of canceled batches', () => {
    const { b } = seedBatch()
    repo.cancelBatch(db, b.id)
    expect(repo.claimNextJob(db)).toBeUndefined()
  })
})

describe('finish/fail guards', () => {
  it('finishJob only applies to running jobs', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    repo.finishJob(db, job.id, [{ path: '1/0.png', filename: '0.png' }])
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('succeeded')
    expect(detail.jobs[0]?.outputs).toEqual([{ path: '1/0.png', filename: '0.png' }])
  })

  it('failJob does not overwrite canceled job', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    repo.cancelBatch(db, b.id) // running job 状态置 canceled
    repo.failJob(db, job.id, 'boom')
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('canceled')
  })
})

describe('batch lifecycle', () => {
  it('markBatchCompletedIfDone completes when all jobs terminal', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    expect(repo.markBatchCompletedIfDone(db, b.id)).toBe(false)
    repo.finishJob(db, job.id, [])
    expect(repo.markBatchCompletedIfDone(db, b.id)).toBe(true)
    expect(repo.getBatchDetail(db, b.id)?.batch.status).toBe('completed')
  })

  it('cancelBatch cancels pending+running jobs and returns running one', () => {
    const { b } = seedBatch()
    const { job } = repo.claimNextJob(db)!
    const running = repo.cancelBatch(db, b.id)
    expect(running?.id).toBe(job.id)
    const statuses = repo.getBatchDetail(db, b.id)!.jobs.map((j) => j.status)
    expect(statuses).toEqual(['canceled', 'canceled'])
  })

  it('retryFailedJobs resets failed to pending and reopens batch', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    repo.failJob(db, job.id, 'boom')
    repo.markBatchCompletedIfDone(db, b.id)
    expect(repo.retryFailedJobs(db, b.id)).toBe(1)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('pending')
    expect(detail.jobs[0]?.error).toBeNull()
    expect(detail.batch.status).toBe('running')
    expect(repo.claimNextJob(db)?.job.id).toBe(job.id)
  })

  it('listBatches includes template name and counts', () => {
    const { b } = seedBatch()
    const { job } = repo.claimNextJob(db)!
    repo.finishJob(db, job.id, [])
    const rows = repo.listBatches(db)
    expect(rows[0]).toMatchObject({ id: b.id, templateName: 'T', total: 2, succeeded: 1, failed: 0 })
  })

  it('recovery helpers list and reset running jobs', () => {
    seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    expect(repo.listRunningJobs(db).map((j) => j.id)).toEqual([job.id])
    repo.resetJobToPending(db, job.id)
    expect(repo.listRunningJobs(db)).toHaveLength(0)
    expect(repo.claimNextJob(db)?.job.id).toBe(job.id)
  })
})
