import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { CreateBatchInput, CreateTemplateInput, OutputFile } from '@cwe/shared'
import type { Db } from './index.js'
import { batches, jobs, templates, type Batch, type Job, type Template } from './schema.js'

const now = () => new Date().toISOString()

// -- templates --

export function createTemplate(db: Db, input: CreateTemplateInput): Template {
  return db.insert(templates).values(input).returning().get()
}

export function listTemplates(db: Db): Template[] {
  return db.select().from(templates).orderBy(asc(templates.id)).all()
}

export function getTemplate(db: Db, id: number): Template | undefined {
  return db.select().from(templates).where(eq(templates.id, id)).get()
}

export function deleteTemplate(db: Db, id: number): void {
  db.delete(templates).where(eq(templates.id, id)).run()
}

// -- batches --

export function createBatch(db: Db, templateId: number, input: CreateBatchInput): Batch {
  return db.transaction((tx) => {
    const batch = tx.insert(batches).values({ templateId, name: input.name }).returning().get()
    tx.insert(jobs)
      .values(input.jobs.map((params, i) => ({ batchId: batch.id, sortOrder: i, params })))
      .run()
    return batch
  })
}

export function listBatches(
  db: Db,
): Array<Batch & { templateName: string; total: number; succeeded: number; failed: number }> {
  return db
    .select({
      id: batches.id,
      templateId: batches.templateId,
      name: batches.name,
      status: batches.status,
      createdAt: batches.createdAt,
      templateName: templates.name,
      total: sql<number>`count(${jobs.id})`,
      succeeded: sql<number>`sum(case when ${jobs.status} = 'succeeded' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${jobs.status} = 'failed' then 1 else 0 end)`,
    })
    .from(batches)
    .innerJoin(templates, eq(batches.templateId, templates.id))
    .leftJoin(jobs, eq(jobs.batchId, batches.id))
    .groupBy(batches.id)
    .orderBy(sql`${batches.id} desc`)
    .all()
}

export function getBatchDetail(
  db: Db,
  id: number,
): { batch: Batch; template: Template; jobs: Job[] } | undefined {
  const batch = db.select().from(batches).where(eq(batches.id, id)).get()
  if (!batch) return undefined
  const template = getTemplate(db, batch.templateId)
  if (!template) return undefined
  const rows = db.select().from(jobs).where(eq(jobs.batchId, id)).orderBy(asc(jobs.sortOrder)).all()
  return { batch, template, jobs: rows }
}

// -- executor queue --

export function claimNextJob(db: Db): { job: Job; template: Template } | undefined {
  return db.transaction((tx) => {
    const row = tx
      .select({ job: jobs, batch: batches })
      .from(jobs)
      .innerJoin(batches, eq(jobs.batchId, batches.id))
      .where(and(eq(jobs.status, 'pending'), inArray(batches.status, ['pending', 'running'])))
      .orderBy(asc(batches.id), asc(jobs.sortOrder))
      .limit(1)
      .get()
    if (!row) return undefined
    const template = tx.select().from(templates).where(eq(templates.id, row.batch.templateId)).get()
    if (!template) return undefined
    const job = tx
      .update(jobs)
      .set({ status: 'running', startedAt: now(), error: null })
      .where(and(eq(jobs.id, row.job.id), eq(jobs.status, 'pending')))
      .returning()
      .get()
    if (!job) return undefined
    if (row.batch.status === 'pending') {
      tx.update(batches).set({ status: 'running' }).where(eq(batches.id, row.batch.id)).run()
    }
    return { job, template }
  })
}

export function setJobPromptId(db: Db, jobId: number, promptId: string): void {
  db.update(jobs).set({ comfyPromptId: promptId }).where(eq(jobs.id, jobId)).run()
}

export function finishJob(db: Db, jobId: number, outputs: OutputFile[]): void {
  db.update(jobs)
    .set({ status: 'succeeded', outputs, finishedAt: now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    .run()
}

export function failJob(db: Db, jobId: number, error: string): void {
  db.update(jobs)
    .set({ status: 'failed', error, finishedAt: now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    .run()
}

export function getJob(db: Db, jobId: number): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, jobId)).get()
}

export function getBatchStatus(db: Db, batchId: number): Batch['status'] | undefined {
  return db.select({ status: batches.status }).from(batches).where(eq(batches.id, batchId)).get()?.status
}

export function listRunningJobs(db: Db): Job[] {
  return db.select().from(jobs).where(eq(jobs.status, 'running')).all()
}

export function resetJobToPending(db: Db, jobId: number): void {
  db.update(jobs)
    .set({ status: 'pending', comfyPromptId: null, startedAt: null })
    .where(eq(jobs.id, jobId))
    .run()
}

export function markBatchCompletedIfDone(db: Db, batchId: number): boolean {
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, batchId)).get()
    if (!batch || batch.status !== 'running') return false
    const open = tx
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), inArray(jobs.status, ['pending', 'running'])))
      .get()
    if ((open?.n ?? 0) > 0) return false
    tx.update(batches).set({ status: 'completed' }).where(eq(batches.id, batchId)).run()
    return true
  })
}

export function cancelBatch(db: Db, id: number): Job | undefined {
  return db.transaction((tx) => {
    const running = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, id), eq(jobs.status, 'running')))
      .get()
    tx.update(jobs)
      .set({ status: 'canceled', finishedAt: now() })
      .where(and(eq(jobs.batchId, id), inArray(jobs.status, ['pending', 'running'])))
      .run()
    tx.update(batches).set({ status: 'canceled' }).where(eq(batches.id, id)).run()
    return running
  })
}

export function retryFailedJobs(db: Db, batchId: number): number {
  return db.transaction((tx) => {
    const res = tx
      .update(jobs)
      .set({ status: 'pending', error: null, comfyPromptId: null, startedAt: null, finishedAt: null })
      .where(and(eq(jobs.batchId, batchId), eq(jobs.status, 'failed')))
      .run()
    if (res.changes > 0) {
      tx.update(batches).set({ status: 'running' }).where(eq(batches.id, batchId)).run()
    }
    return res.changes
  })
}
