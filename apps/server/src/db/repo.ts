import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import type { CreateBatchInput, CreateTemplateInput, OutputFile, ParamValues } from '@cwe/shared'
import type { Db } from './index.js'
import { batches, inputHistory, jobs, templates, type Batch, type Job, type Template } from './schema.js'

const now = () => new Date().toISOString()

// -- templates --

export function createTemplate(db: Db, input: CreateTemplateInput): Template {
  return db.transaction((tx) => {
    const max = tx
      .select({ m: sql<number>`coalesce(max(${templates.sortOrder}), 0)` })
      .from(templates)
      .get()
    return tx
      .insert(templates)
      .values({ ...input, sortOrder: (max?.m ?? 0) + 1 })
      .returning()
      .get()
  })
}

export function listTemplates(db: Db): Template[] {
  return db.select().from(templates).orderBy(asc(templates.sortOrder), asc(templates.id)).all()
}

export function getTemplate(db: Db, id: number): Template | undefined {
  return db.select().from(templates).where(eq(templates.id, id)).get()
}

export function deleteTemplate(db: Db, id: number): void {
  db.delete(templates).where(eq(templates.id, id)).run()
}

export function renameTemplate(db: Db, id: number, name: string): Template | undefined {
  return db.update(templates).set({ name }).where(eq(templates.id, id)).returning().get()
}

/** 全量重排:ids 必须恰好覆盖全部模板且不重复 */
export function reorderTemplates(db: Db, ids: number[]): 'ok' | 'unknown-id' | 'incomplete' {
  return db.transaction((tx) => {
    const existing = tx.select({ id: templates.id }).from(templates).all().map((r) => r.id)
    const known = new Set(existing)
    if (ids.some((id) => !known.has(id))) return 'unknown-id'
    if (ids.length !== existing.length || new Set(ids).size !== ids.length) return 'incomplete'
    ids.forEach((id, i) => {
      tx.update(templates).set({ sortOrder: i + 1 }).where(eq(templates.id, id)).run()
    })
    return 'ok'
  })
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

/** 相邻 batch 导航:prev=更早(小于当前的最大 id),next=更新(大于当前的最小 id) */
export function getBatchNav(db: Db, id: number): { prevId: number | null; nextId: number | null } {
  const prev = db.select({ id: batches.id }).from(batches).where(lt(batches.id, id)).orderBy(desc(batches.id)).limit(1).get()
  const next = db.select({ id: batches.id }).from(batches).where(gt(batches.id, id)).orderBy(asc(batches.id)).limit(1).get()
  return { prevId: prev?.id ?? null, nextId: next?.id ?? null }
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

export type RerollResult =
  | { kind: 'ok'; job: Job }
  | { kind: 'batch-not-found' }
  | { kind: 'job-not-found' }
  | { kind: 'not-succeeded' }
  | { kind: 'no-seed' }

/** 重roll:复制成功 job 的参数,seed 参数换独立随机值,追加到批尾并把 batch 置回 running */
export function rerollJob(db: Db, batchId: number, jobId: number): RerollResult {
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, batchId)).get()
    if (!batch) return { kind: 'batch-not-found' as const }
    const src = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.batchId, batchId)))
      .get()
    if (!src) return { kind: 'job-not-found' as const }
    if (src.status !== 'succeeded') return { kind: 'not-succeeded' as const }
    const template = tx.select().from(templates).where(eq(templates.id, batch.templateId)).get()
    const seedKeys = (template?.params ?? []).filter((p) => p.type === 'seed').map((p) => p.key)
    if (seedKeys.length === 0) return { kind: 'no-seed' as const }
    const params = { ...src.params }
    for (const key of seedKeys) params[key] = Math.floor(Math.random() * 2 ** 31)
    const max = tx
      .select({ m: sql<number>`coalesce(max(${jobs.sortOrder}), -1)` })
      .from(jobs)
      .where(eq(jobs.batchId, batchId))
      .get()
    const job = tx
      .insert(jobs)
      .values({ batchId, sortOrder: (max?.m ?? -1) + 1, params })
      .returning()
      .get()
    tx.update(batches).set({ status: 'running' }).where(eq(batches.id, batchId)).run()
    return { kind: 'ok' as const, job }
  })
}

/** 状态检查与删除同事务,避免与执行器认领竞态;jobs 无级联须先删 */
export function deleteBatch(db: Db, id: number): 'ok' | 'not-found' | 'running' {
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, id)).get()
    if (!batch) return 'not-found'
    if (batch.status === 'running') return 'running'
    tx.delete(jobs).where(eq(jobs.batchId, id)).run()
    tx.delete(batches).where(eq(batches.id, id)).run()
    return 'ok'
  })
}

// -- input history --

/** 建批时记录 text 参数值:同批 (key,value) 去重后 upsert,再按 key 修剪到 limit */
export function recordInputHistory(
  db: Db,
  textKeys: string[],
  jobsParams: ParamValues[],
  limit: number,
): void {
  if (textKeys.length === 0) return
  const seen = new Set<string>()
  const entries: Array<{ key: string; value: string }> = []
  for (const params of jobsParams) {
    for (const key of textKeys) {
      const v = params[key]
      if (typeof v !== 'string' || v.trim() === '') continue
      const dedup = `${key}\u0000${v}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      entries.push({ key, value: v })
    }
  }
  if (entries.length === 0) return
  db.transaction((tx) => {
    const ts = now()
    const maxSeq = tx.select({ m: sql<number>`coalesce(max(touch_seq), 0)` }).from(inputHistory).get()
    let seq = maxSeq?.m ?? 0
    for (const e of entries) {
      seq += 1
      tx.insert(inputHistory)
        .values({ paramKey: e.key, value: e.value, lastUsedAt: ts, touchSeq: seq })
        .onConflictDoUpdate({
          target: [inputHistory.paramKey, inputHistory.value],
          set: { useCount: sql`${inputHistory.useCount} + 1`, lastUsedAt: ts, touchSeq: seq },
        })
        .run()
    }
    for (const key of new Set(entries.map((e) => e.key))) {
      tx.run(sql`DELETE FROM input_history WHERE param_key = ${key} AND id NOT IN (
        SELECT id FROM input_history WHERE param_key = ${key}
        ORDER BY touch_seq DESC LIMIT ${limit})`)
    }
  })
}

export function listInputHistory(db: Db, key: string, limit: number): string[] {
  return db
    .select({ value: inputHistory.value })
    .from(inputHistory)
    .where(eq(inputHistory.paramKey, key))
    .orderBy(desc(inputHistory.touchSeq))
    .limit(limit)
    .all()
    .map((r) => r.value)
}

export function deleteInputHistory(db: Db, key: string, value: string): void {
  db.delete(inputHistory)
    .where(and(eq(inputHistory.paramKey, key), eq(inputHistory.value, value)))
    .run()
}
