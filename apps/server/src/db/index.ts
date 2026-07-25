import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

const DDL = `
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  comfy_json TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  sort_order INTEGER NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  comfy_prompt_id TEXT,
  error TEXT,
  outputs TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`

export function createDb(path: string) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  // 旧库迁移:补 sort_order 列并按 id 初始化(保持既有展示顺序)
  const cols = sqlite.prepare(`PRAGMA table_info(templates)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'sort_order')) {
    sqlite.exec(`ALTER TABLE templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
    sqlite.exec(`UPDATE templates SET sort_order = id`)
  }
  return drizzle(sqlite, { schema })
}

export type Db = ReturnType<typeof createDb>
