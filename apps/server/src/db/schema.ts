import { sql } from 'drizzle-orm'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { OutputFile, ParamDef, ParamValues } from '@cwe/shared'

export const templates = sqliteTable('templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  comfyJson: text('comfy_json', { mode: 'json' }).$type<Record<string, any>>().notNull(),
  params: text('params', { mode: 'json' }).$type<ParamDef[]>().notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  templateId: integer('template_id').notNull(),
  name: text('name').notNull(),
  status: text('status').$type<'pending' | 'running' | 'completed' | 'canceled'>().notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /** 非空时该批次只在此主机执行:引用了 GPU 侧已有文件,换主机必失败 */
  pinnedHostId: integer('pinned_host_id'),
})

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull(),
  sortOrder: integer('sort_order').notNull(),
  params: text('params', { mode: 'json' }).$type<ParamValues>().notNull(),
  status: text('status')
    .$type<'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'>()
    .notNull()
    .default('pending'),
  comfyPromptId: text('comfy_prompt_id'),
  error: text('error'),
  outputs: text('outputs', { mode: 'json' }).$type<OutputFile[]>(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  /** 实际执行主机;认领时盖章。无 FK:主机删除后悬挂,展示层兜底 */
  hostId: integer('host_id'),
})

export const inputHistory = sqliteTable('input_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paramKey: text('param_key').notNull(),
  value: text('value').notNull(),
  useCount: integer('use_count').notNull().default(1),
  lastUsedAt: text('last_used_at').notNull(),
  // 排序不用时间戳(毫秒内多批次会撞车),用全局递增触碰序号
  touchSeq: integer('touch_seq').notNull().default(0),
})

export const prompts = sqliteTable('prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  content: text('content').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const hosts = sqliteTable('hosts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  note: text('note'),
  /** 参考主机:只服务节点/模型/GPU 文件列表查询,不再决定谁干活 */
  active: integer('active').notNull().default(0),
  /** 参与调度:为 1 才会起 worker */
  enabled: integer('enabled').notNull().default(1),
  kind: text('kind').$type<'resident' | 'rental'>().notNull().default('resident'),
  rentedAt: text('rented_at'),
  hourlyRate: real('hourly_rate'),
  /** 自动停用原因(熔断写入);手动启用时清空 */
  disabledReason: text('disabled_reason'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export type Template = typeof templates.$inferSelect
export type Batch = typeof batches.$inferSelect
export type Job = typeof jobs.$inferSelect
export type Prompt = typeof prompts.$inferSelect
export type Host = typeof hosts.$inferSelect
