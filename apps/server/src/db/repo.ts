import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import type { CreateBatchInput, CreateTemplateInput, OutputFile, ParamValues } from '@cwe/shared'
import type { Db } from './index.js'
import { batches, hosts, inputHistory, jobs, prompts, templates, type Batch, type Host, type Job, type Prompt, type Template } from './schema.js'

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

export function createBatch(
  db: Db,
  templateId: number,
  input: CreateBatchInput,
  pinnedHostId?: number | null,
): Batch {
  return db.transaction((tx) => {
    const batch = tx
      .insert(batches)
      .values({ templateId, name: input.name, pinnedHostId: pinnedHostId ?? null })
      .returning()
      .get()
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
      pinnedHostId: batches.pinnedHostId,
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
): { batch: Batch; template: Template; jobs: Job[]; hostNames: Record<number, string> } | undefined {
  const batch = db.select().from(batches).where(eq(batches.id, id)).get()
  if (!batch) return undefined
  const template = getTemplate(db, batch.templateId)
  if (!template) return undefined
  const rows = db.select().from(jobs).where(eq(jobs.batchId, id)).orderBy(asc(jobs.sortOrder)).all()
  const hostRows = db.select({ id: hosts.id, name: hosts.name }).from(hosts).all()
  const hostNames = Object.fromEntries(hostRows.map((h) => [h.id, h.name])) as Record<
    number,
    string
  >
  return { batch, template, jobs: rows, hostNames }
}

/** 相邻 batch 导航:prev=更早(小于当前的最大 id),next=更新(大于当前的最小 id) */
export function getBatchNav(db: Db, id: number): { prevId: number | null; nextId: number | null } {
  const prev = db.select({ id: batches.id }).from(batches).where(lt(batches.id, id)).orderBy(desc(batches.id)).limit(1).get()
  const next = db.select({ id: batches.id }).from(batches).where(gt(batches.id, id)).orderBy(asc(batches.id)).limit(1).get()
  return { prevId: prev?.id ?? null, nextId: next?.id ?? null }
}

// -- hosts --

export function listHosts(db: Db): Host[] {
  return db.select().from(hosts).orderBy(asc(hosts.id)).all()
}

export function getHost(db: Db, id: number): Host | undefined {
  return db.select().from(hosts).where(eq(hosts.id, id)).get()
}

export function getActiveHost(db: Db): Host | undefined {
  return db.select().from(hosts).where(eq(hosts.active, 1)).get()
}

export interface HostWritable {
  name: string
  url: string
  note?: string | null
  kind?: 'resident' | 'rental'
  rentedAt?: string | null
  hourlyRate?: number | null
}

export function createHost(db: Db, input: HostWritable): Host {
  return db.insert(hosts).values(input).returning().get()
}

export function updateHost(
  db: Db,
  id: number,
  patch: Partial<HostWritable>,
): Host | undefined {
  return db.update(hosts).set(patch).where(eq(hosts.id, id)).returning().get()
}

export function deleteHost(db: Db, id: number): 'ok' | 'active' {
  return db.transaction((tx) => {
    const row = tx.select().from(hosts).where(eq(hosts.id, id)).get()
    if (!row) return 'ok'
    if (row.active === 1) return 'active'
    tx.delete(hosts).where(eq(hosts.id, id)).run()
    return 'ok'
  })
}

/** 单活不变量:事务内全表清零再置目标为 1 */
export function activateHost(db: Db, id: number): Host | undefined {
  return db.transaction((tx) => {
    const row = tx.select().from(hosts).where(eq(hosts.id, id)).get()
    if (!row) return undefined
    tx.update(hosts).set({ active: 0 }).run()
    return tx.update(hosts).set({ active: 1 }).where(eq(hosts.id, id)).returning().get()
  })
}

/** 种子与自愈:空表种默认主机;非空无 active 激活 id 最小;COMFYUI_URL 仅在此作首次种子 */
export function ensureActiveHost(db: Db, seedUrl: string): Host {
  return db.transaction((tx) => {
    const active = tx.select().from(hosts).where(eq(hosts.active, 1)).get()
    if (active) return active
    const first = tx.select().from(hosts).orderBy(asc(hosts.id)).limit(1).get()
    if (first) {
      return tx.update(hosts).set({ active: 1 }).where(eq(hosts.id, first.id)).returning().get()!
    }
    return tx.insert(hosts).values({ name: '默认主机', url: seedUrl, active: 1 }).returning().get()
  })
}

// -- executor queue --

/**
 * 认领下一个待执行任务并盖上主机章。
 *
 * **本函数必须保持同步、不得引入 await。** 并行认领的互斥完全依赖
 * 「better-sqlite3 同步事务 + Node 单线程 = 事务即临界区」:整段查-改-返回
 * 跑完,下一个 worker 才能开始。一旦函数体内出现 await,两个 worker 的
 * 认领事务就会交错,同一个 job 会被重复派发。
 */
export function claimNextJob(db: Db, hostId: number): { job: Job; template: Template } | undefined {
  return db.transaction((tx) => {
    const row = tx
      .select({ job: jobs, batch: batches })
      .from(jobs)
      .innerJoin(batches, eq(jobs.batchId, batches.id))
      .where(
        and(
          eq(jobs.status, 'pending'),
          inArray(batches.status, ['pending', 'running']),
          // 锁定批次只能被指定主机认领;其余主机跳过它继续取后面的活
          or(isNull(batches.pinnedHostId), eq(batches.pinnedHostId, hostId)),
        ),
      )
      .orderBy(asc(batches.id), asc(jobs.sortOrder))
      .limit(1)
      .get()
    if (!row) return undefined
    const template = tx.select().from(templates).where(eq(templates.id, row.batch.templateId)).get()
    if (!template) return undefined
    const job = tx
      .update(jobs)
      .set({ status: 'running', startedAt: now(), error: null, hostId })
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
  // hostId 一并清空:pending 任务不属于任何主机,否则 UI「主机」列会显示上一台
  db.update(jobs)
    .set({ status: 'pending', comfyPromptId: null, startedAt: null, hostId: null })
    .where(eq(jobs.id, jobId))
    .run()
}

export function listRunningJobsByHost(db: Db, hostId: number): Job[] {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), eq(jobs.hostId, hostId)))
    .all()
}

/** 启动时回收无主的 running job:主机已删除/已停用/历史数据没盖章 */
export function reclaimOrphanJobs(db: Db, liveHostIds: number[]): number {
  return db.transaction((tx) => {
    const orphans = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'running'),
          liveHostIds.length > 0
            ? or(isNull(jobs.hostId), notInArray(jobs.hostId, liveHostIds))
            : sql`1 = 1`,
        ),
      )
      .all()
    for (const o of orphans) {
      tx.update(jobs)
        .set({ status: 'pending', comfyPromptId: null, startedAt: null, hostId: null })
        .where(eq(jobs.id, o.id))
        .run()
    }
    return orphans.length
  })
}

export function listEnabledHosts(db: Db): Host[] {
  return db.select().from(hosts).where(eq(hosts.enabled, 1)).orderBy(asc(hosts.id)).all()
}

export function setHostEnabled(
  db: Db,
  id: number,
  enabled: boolean,
  reason?: string | null,
): Host | undefined {
  return db
    .update(hosts)
    // 启用即清空停用原因;停用可带原因(熔断)或不带(手动)
    .set({ enabled: enabled ? 1 : 0, disabledReason: enabled ? null : (reason ?? null) })
    .where(eq(hosts.id, id))
    .returning()
    .get()
}

/** 锁定到该主机、且尚未结束的批次数(删除主机时给用户的警告) */
export function countPinnedUnfinishedBatches(db: Db, hostId: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(and(eq(batches.pinnedHostId, hostId), inArray(batches.status, ['pending', 'running'])))
      .get()?.n ?? 0
  )
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

/** 取消整批,返回被取消掉的**全部** running job。
 * 并行调度下同一批的任务可能同时跑在多台主机上,只返回一个的话另外几台收不到
 * interrupt,会继续把已取消的任务出完图(finishJob 再被 status='running' 守卫挡掉,
 * 产物白下载),所以这里返回数组由调用方逐台中断。 */
export function cancelBatch(db: Db, id: number): Job[] {
  return db.transaction((tx) => {
    const running = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, id), eq(jobs.status, 'running')))
      .all()
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

// -- prompts --

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export function listPrompts(db: Db): Prompt[] {
  return db.select().from(prompts).orderBy(asc(prompts.key)).all()
}

export function createPrompt(db: Db, key: string, content: string): Prompt | 'conflict' {
  try {
    return db
      .insert(prompts)
      .values({ key, content, updatedAt: new Date().toISOString() })
      .returning()
      .get()
  } catch (err) {
    if (isUniqueViolation(err)) return 'conflict'
    throw err
  }
}

export function updatePrompt(
  db: Db,
  id: number,
  patch: { key?: string; content?: string },
): Prompt | 'not-found' | 'conflict' {
  const existing = db.select().from(prompts).where(eq(prompts.id, id)).get()
  if (!existing) return 'not-found'
  try {
    return db
      .update(prompts)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(prompts.id, id))
      .returning()
      .get()
  } catch (err) {
    if (isUniqueViolation(err)) return 'conflict'
    throw err
  }
}

export function deletePrompt(db: Db, id: number): void {
  db.delete(prompts).where(eq(prompts.id, id)).run()
}

export function importPrompts(
  db: Db,
  items: Array<{ key: string; content: string }>,
): { created: number; updated: number } {
  return db.transaction((tx) => {
    let created = 0
    let updated = 0
    const now = new Date().toISOString()
    for (const item of items) {
      const existing = tx.select().from(prompts).where(eq(prompts.key, item.key)).get()
      if (existing) {
        tx.update(prompts)
          .set({ content: item.content, updatedAt: now })
          .where(eq(prompts.id, existing.id))
          .run()
        updated++
      } else {
        tx.insert(prompts).values({ key: item.key, content: item.content, updatedAt: now }).run()
        created++
      }
    }
    return { created, updated }
  })
}

/** 全库所有 job 的 GPU 输出引用键(subfolder/filename);GPU 孤儿判定用 */
export function listAllGpuRefKeys(db: Db): Set<string> {
  const rows = db.select({ outputs: jobs.outputs }).from(jobs).where(isNotNull(jobs.outputs)).all()
  const keys = new Set<string>()
  for (const row of rows) {
    for (const out of row.outputs ?? []) {
      if (out.gpu) keys.add(`${out.gpu.subfolder}/${out.gpu.filename}`)
    }
  }
  return keys
}
