import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cwe-mig-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个「旧版」库:hosts/batches 用升级前的列定义 */
function seedLegacyDb(path: string): void {
  const raw = new Database(path)
  raw.exec(`
    CREATE TABLE hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      note TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      comfy_json TEXT NOT NULL, params TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES templates(id),
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO hosts (name, url, active) VALUES ('老主机', 'http://a:8188', 1);
  `)
  raw.close()
}

describe('多主机字段迁移', () => {
  it('旧库补齐 hosts 新列,存量主机默认参与调度且为常驻', () => {
    const path = join(dir, 'db.sqlite')
    seedLegacyDb(path)
    const db = createDb(path)
    const host = repo.listHosts(db)[0]!
    expect(host.enabled).toBe(1)
    expect(host.kind).toBe('resident')
    expect(host.rentedAt).toBeNull()
    expect(host.hourlyRate).toBeNull()
    expect(host.disabledReason).toBeNull()
  })

  it('旧库补齐 batches.pinned_host_id 且为空', () => {
    const path = join(dir, 'db.sqlite')
    seedLegacyDb(path)
    const db = createDb(path)
    const cols = db.$client.prepare(`PRAGMA table_info(batches)`).all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'pinned_host_id')).toBe(true)
  })

  it('迁移幂等:同一个库连开两次不报错', () => {
    const path = join(dir, 'db.sqlite')
    seedLegacyDb(path)
    createDb(path)
    expect(() => createDb(path)).not.toThrow()
  })

  it('新库直接带全部列', () => {
    const db = createDb(join(dir, 'fresh.sqlite'))
    const host = repo.createHost(db, { name: 'r', url: 'http://b:8188', kind: 'rental', hourlyRate: 1.5 })
    expect(host.enabled).toBe(1)
    expect(host.kind).toBe('rental')
    expect(host.hourlyRate).toBe(1.5)
  })
})
