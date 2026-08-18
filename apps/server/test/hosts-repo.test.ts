import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

let db: Db
beforeEach(() => {
  db = createDb(':memory:')
})

describe('hosts repo', () => {
  it('ensureActiveHost:空表用 seedUrl 种默认主机并激活', () => {
    const host = repo.ensureActiveHost(db, 'http://127.0.0.1:8188')
    expect(host.name).toBe('默认主机')
    expect(host.url).toBe('http://127.0.0.1:8188')
    expect(host.active).toBe(1)
    // 幂等:再调不重复插入
    repo.ensureActiveHost(db, 'http://other:8188')
    expect(repo.listHosts(db)).toHaveLength(1)
  })

  it('ensureActiveHost:表非空但无 active 时激活 id 最小的一条', () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const host = repo.ensureActiveHost(db, 'http://seed:8188')
    expect(host.id).toBe(a.id)
    expect(repo.getActiveHost(db)?.id).toBe(a.id)
  })

  it('activateHost:单活不变量', () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.activateHost(db, b.id)
    const hosts = repo.listHosts(db)
    expect(hosts.filter((h) => h.active === 1)).toHaveLength(1)
    expect(repo.getActiveHost(db)?.id).toBe(b.id)
    expect(repo.getHost(db, a.id)?.active).toBe(0)
  })

  it('deleteHost:active 主机拒删,其余幂等删除', () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    expect(repo.deleteHost(db, a.id)).toBe('active')
    expect(repo.deleteHost(db, b.id)).toBe('ok')
    expect(repo.deleteHost(db, b.id)).toBe('ok')
    expect(repo.listHosts(db)).toHaveLength(1)
  })

  it('claimNextJob 盖章传入的 host id', () => {
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
    repo.createBatch(db, t.id, { name: 'B', jobs: [{}] })
    const claimed = repo.claimNextJob(db, host.id)
    expect(claimed?.job.hostId).toBe(host.id)
  })

  it('getBatchDetail 返回 hostNames 映射', () => {
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{}] })
    repo.claimNextJob(db, host.id)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.hostNames[host.id]).toBe(host.name)
  })

  it('旧库迁移:无 host_id 列的 jobs 表被补列', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwe-hosts-'))
    const path = join(dir, 'old.sqlite')
    const raw = new Database(path)
    raw.exec(`CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, sort_order INTEGER NOT NULL,
      params TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      comfy_prompt_id TEXT, error TEXT, outputs TEXT, started_at TEXT, finished_at TEXT)`)
    raw.close()
    const migrated = createDb(path)
    const cols = migrated.$client.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'host_id')).toBe(true)
    createDb(path) // 再跑一遍幂等不炸
  })
})
