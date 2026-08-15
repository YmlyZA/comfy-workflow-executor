import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { jobs } from '../src/db/schema.js'

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

  it('deleteTemplate throws when batches still reference it', () => {
    const { t } = seedBatch()
    expect(() => repo.deleteTemplate(db, t.id)).toThrow()
  })
})

describe('claimNextJob', () => {
  it('claims jobs in order and marks batch running', () => {
    const { b } = seedBatch()
    const c1 = repo.claimNextJob(db, 1)
    expect(c1?.job.params).toEqual({ prompt: 'a' })
    expect(c1?.job.status).toBe('running')
    expect(c1?.template.name).toBe('T')
    expect(repo.getBatchDetail(db, b.id)?.batch.status).toBe('running')
    const c2 = repo.claimNextJob(db, 1)
    expect(c2?.job.params).toEqual({ prompt: 'b' })
  })

  it('returns undefined when nothing pending', () => {
    expect(repo.claimNextJob(db, 1)).toBeUndefined()
  })

  it('skips jobs of canceled batches', () => {
    const { b } = seedBatch()
    repo.cancelBatch(db, b.id)
    expect(repo.claimNextJob(db, 1)).toBeUndefined()
  })

  it('leaves job pending when template row is gone', () => {
    const { b } = seedBatch()
    // Bypass FK enforcement to simulate a dangling template reference, since
    // foreign_keys=ON now prevents deleteTemplate from doing this normally.
    // drizzle-orm's better-sqlite3 driver exposes the raw Database as $client.
    ;(db as any).$client.exec('PRAGMA foreign_keys=OFF; DELETE FROM templates; PRAGMA foreign_keys=ON')
    expect(repo.claimNextJob(db, 1)).toBeUndefined()
    const rows = db.select().from(jobs).where(eq(jobs.batchId, b.id)).all()
    expect(rows.every((j) => j.status === 'pending')).toBe(true)
  })
})

describe('finish/fail guards', () => {
  it('finishJob only applies to running jobs', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db, 1)!
    repo.finishJob(db, job.id, [{ path: '1/0.png', filename: '0.png' }])
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('succeeded')
    expect(detail.jobs[0]?.outputs).toEqual([{ path: '1/0.png', filename: '0.png' }])
  })

  it('failJob does not overwrite canceled job', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db, 1)!
    repo.cancelBatch(db, b.id) // running job 状态置 canceled
    repo.failJob(db, job.id, 'boom')
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('canceled')
  })
})

describe('batch lifecycle', () => {
  it('markBatchCompletedIfDone completes when all jobs terminal', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db, 1)!
    expect(repo.markBatchCompletedIfDone(db, b.id)).toBe(false)
    repo.finishJob(db, job.id, [])
    expect(repo.markBatchCompletedIfDone(db, b.id)).toBe(true)
    expect(repo.getBatchDetail(db, b.id)?.batch.status).toBe('completed')
  })

  it('cancelBatch cancels pending+running jobs and returns running one', () => {
    const { b } = seedBatch()
    const { job } = repo.claimNextJob(db, 1)!
    const running = repo.cancelBatch(db, b.id)
    expect(running?.id).toBe(job.id)
    const statuses = repo.getBatchDetail(db, b.id)!.jobs.map((j) => j.status)
    expect(statuses).toEqual(['canceled', 'canceled'])
  })

  it('retryFailedJobs resets failed to pending and reopens batch', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db, 1)!
    repo.failJob(db, job.id, 'boom')
    repo.markBatchCompletedIfDone(db, b.id)
    expect(repo.retryFailedJobs(db, b.id)).toBe(1)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('pending')
    expect(detail.jobs[0]?.error).toBeNull()
    expect(detail.batch.status).toBe('running')
    expect(repo.claimNextJob(db, 1)?.job.id).toBe(job.id)
  })

  it('listBatches includes template name and counts', () => {
    const { b } = seedBatch()
    const { job } = repo.claimNextJob(db, 1)!
    repo.finishJob(db, job.id, [])
    const rows = repo.listBatches(db)
    expect(rows[0]).toMatchObject({ id: b.id, templateName: 'T', total: 2, succeeded: 1, failed: 0 })
  })

  it('recovery helpers list and reset running jobs', () => {
    seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db, 1)!
    expect(repo.listRunningJobs(db).map((j) => j.id)).toEqual([job.id])
    repo.resetJobToPending(db, job.id)
    expect(repo.listRunningJobs(db)).toHaveLength(0)
    expect(repo.claimNextJob(db, 1)?.job.id).toBe(job.id)
  })
})

describe('template sort_order', () => {
  it('新建模板追加到末尾, listTemplates 按 sort_order 返回', () => {
    const a = repo.createTemplate(db, { name: 'A', comfyJson: {}, params: [] })
    const b = repo.createTemplate(db, { name: 'B', comfyJson: {}, params: [] })
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder)
    expect(repo.listTemplates(db).map((t) => t.name)).toEqual(['A', 'B'])
  })

  it('reorderTemplates 持久化新顺序', () => {
    const a = repo.createTemplate(db, { name: 'A', comfyJson: {}, params: [] })
    const b = repo.createTemplate(db, { name: 'B', comfyJson: {}, params: [] })
    const c = repo.createTemplate(db, { name: 'C', comfyJson: {}, params: [] })
    expect(repo.reorderTemplates(db, [c.id, a.id, b.id])).toBe('ok')
    expect(repo.listTemplates(db).map((t) => t.name)).toEqual(['C', 'A', 'B'])
  })

  it('reorderTemplates 拒绝未知 id 与不完整列表', () => {
    const a = repo.createTemplate(db, { name: 'A', comfyJson: {}, params: [] })
    repo.createTemplate(db, { name: 'B', comfyJson: {}, params: [] })
    expect(repo.reorderTemplates(db, [a.id, 999])).toBe('unknown-id')
    expect(repo.reorderTemplates(db, [a.id])).toBe('incomplete')
    expect(repo.reorderTemplates(db, [a.id, a.id])).toBe('incomplete')
  })
})

describe('sort_order migration', () => {
  it('旧库(无 sort_order 列)打开时自动迁移并按 id 初始化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwe-mig-'))
    const path = join(dir, 'old.db')
    const raw = new Database(path)
    raw.exec(`CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      comfy_json TEXT NOT NULL,
      params TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`)
    raw.prepare(`INSERT INTO templates (name, comfy_json, params) VALUES ('old', '{}', '[]')`).run()
    raw.close()
    const migrated = createDb(path)
    const rows = repo.listTemplates(migrated)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sortOrder).toBe(rows[0]!.id)
  })
})
