import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

const DDL = `
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  comfy_json TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  sqlite.exec(DDL)
  return drizzle(sqlite, { schema })
}

export type Db = ReturnType<typeof createDb>
