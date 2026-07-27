import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { extractZip } from '../src/zip.js'

const H = { Authorization: 'Bearer secret' }

/** 文件型 dataDir + app;deps 引用暴露给热切换断言用 */
function makeApp(dataDir: string) {
  mkdirSync(join(dataDir, 'uploads'), { recursive: true })
  mkdirSync(join(dataDir, 'outputs'), { recursive: true })
  const deps: AppDeps = {
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db: createDb(join(dataDir, 'db.sqlite')),
    comfy: null,
    events: new EventEmitter(),
    executor: null,
  }
  return { app: createApp(deps), deps }
}

let dataDir: string
let app: ReturnType<typeof createApp>
let deps: AppDeps

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-backup-'))
  ;({ app, deps } = makeApp(dataDir))
})

async function exportZipTo(destDir: string): Promise<void> {
  const res = await app.request('/api/export', { headers: H })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/zip')
  expect(res.headers.get('content-disposition')).toContain('cwe-backup-')
  const zipPath = join(mkdtempSync(join(tmpdir(), 'cwe-dl-')), 'dl.zip')
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()))
  await extractZip(zipPath, destDir)
}

describe('GET /api/export', () => {
  it('zip 含 db/uploads/outputs,不含 thumbs 与 wal', async () => {
    writeFileSync(join(dataDir, 'uploads', 'u.png'), 'img')
    mkdirSync(join(dataDir, 'outputs', '1'), { recursive: true })
    writeFileSync(join(dataDir, 'outputs', '1', 'o.png'), 'out')
    mkdirSync(join(dataDir, 'thumbs'), { recursive: true })
    writeFileSync(join(dataDir, 'thumbs', 't.webp'), 'thumb')

    const dest = mkdtempSync(join(tmpdir(), 'cwe-x-'))
    await exportZipTo(dest)
    expect(existsSync(join(dest, 'db.sqlite'))).toBe(true)
    expect(existsSync(join(dest, 'uploads', 'u.png'))).toBe(true)
    expect(existsSync(join(dest, 'outputs', '1', 'o.png'))).toBe(true)
    expect(existsSync(join(dest, 'thumbs'))).toBe(false)
    expect(existsSync(join(dest, 'db.sqlite-wal'))).toBe(false)
    expect(existsSync(join(dest, 'db.sqlite-shm'))).toBe(false)
  })

  it('导出前 checkpoint:zip 内库含最近写入', async () => {
    repo.createTemplate(deps.db, { name: 'RECENT', comfyJson: {}, params: [] })
    const dest = mkdtempSync(join(tmpdir(), 'cwe-x2-'))
    await exportZipTo(dest)
    const check = new Database(join(dest, 'db.sqlite'), { readonly: true })
    const row = check.prepare('SELECT name FROM templates').get() as { name: string }
    check.close()
    expect(row.name).toBe('RECENT')
  })
})
