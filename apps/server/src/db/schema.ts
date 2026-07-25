import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
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
})

export type Template = typeof templates.$inferSelect
export type Batch = typeof batches.$inferSelect
export type Job = typeof jobs.$inferSelect
