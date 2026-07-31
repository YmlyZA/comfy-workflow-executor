import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import archiver from 'archiver'
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

/** 用一套独立 dataDir + app 造出真实导出包 */
async function buildBackupZip(templateName: string): Promise<Buffer> {
  const srcDir = mkdtempSync(join(tmpdir(), 'cwe-src-'))
  const { app: srcApp, deps: srcDeps } = makeApp(srcDir)
  repo.createTemplate(srcDeps.db, { name: templateName, comfyJson: {}, params: [] })
  writeFileSync(join(srcDir, 'uploads', 'from-zip.png'), 'img')
  const res = await srcApp.request('/api/export', { headers: H })
  return Buffer.from(await res.arrayBuffer())
}

const HZ = { Authorization: 'Bearer secret', 'Content-Type': 'application/zip' }

describe('POST /api/import', () => {
  it('整体替换:新库数据生效,uploads 落位,bak 目录保留旧库', async () => {
    repo.createTemplate(deps.db, { name: 'OLD', comfyJson: {}, params: [] })
    const inoBefore = statSync(dataDir).ino
    const zip = await buildBackupZip('FROM-ZIP')
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const list = repo.listTemplates(deps.db).map((t) => t.name)
    expect(list).toEqual(['FROM-ZIP'])
    expect(existsSync(join(dataDir, 'uploads', 'from-zip.png'))).toBe(true)
    expect(existsSync(join(dataDir, 'outputs'))).toBe(true)
    // dataDir 自身从未被 rename(挂载点场景 rename 会 EBUSY),换的是目录内容
    expect(statSync(dataDir).ino).toBe(inoBefore)

    // bak 在 dataDir 内部(dataDir 可能是 Docker volume 挂载点,不能整体 rename)
    const bak = readdirSync(dataDir).find((n) => n.startsWith('.bak-'))
    expect(bak).toBeDefined()
    const old = new Database(join(dataDir, bak!, 'db.sqlite'), { readonly: true })
    const row = old.prepare('SELECT name FROM templates').get() as { name: string }
    old.close()
    expect(row.name).toBe('OLD')
  })

  it('导入时按序调用 executor pause→resume,resume 收到重开后的新 db', async () => {
    const calls: string[] = []
    let resumedDb: unknown = null
    const oldDb = deps.db
    deps.executor = {
      pause: async () => {
        calls.push('pause')
      },
      resume: (db) => {
        calls.push('resume')
        resumedDb = db
      },
    }
    const zip = await buildBackupZip('X')
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['pause', 'resume'])
    expect(resumedDb).toBe(deps.db)
    expect(resumedDb).not.toBe(oldDb)
  })

  it('导入与主机切换共用切换锁,不会交错', async () => {
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    deps.executor = {
      pause: async () => {
        calls.push('pause-start')
        if (first) {
          first = false
          await gate
        }
        calls.push('pause-end')
      },
      resume: () => calls.push('resume'),
    }
    repo.ensureActiveHost(deps.db, 'http://a:8188')
    const other = repo.createHost(deps.db, { name: 'B', url: 'http://b:8188' })
    const zip = await buildBackupZip('LOCKED')

    const pAct = app.request(`/api/hosts/${other.id}/activate`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'wait' }),
    })
    await new Promise((r) => setTimeout(r, 20))
    const pImp = app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    await new Promise((r) => setTimeout(r, 20))
    // 导入已解包完毕,但热切换段被锁挡住,还没 pause
    expect(calls).toEqual(['pause-start'])

    release()
    expect((await pAct).status).toBe(200)
    expect((await pImp).status).toBe(200)
    expect(calls).toEqual(['pause-start', 'pause-end', 'resume', 'pause-start', 'pause-end', 'resume'])
  }, 20000)

  it('导入含 hosts 表的库后,按其 active 主机重建连接', async () => {
    const tmpDbDir = mkdtempSync(join(tmpdir(), 'cwe-hosts-db-'))
    const tmpDb = createDb(join(tmpDbDir, 'db.sqlite'))
    repo.ensureActiveHost(tmpDb, 'http://imported:8188')
    tmpDb.$client.pragma('wal_checkpoint(TRUNCATE)')
    tmpDb.$client.close()

    const archive = archiver('zip')
    const chunks: Buffer[] = []
    archive.on('data', (d: Buffer) => chunks.push(d))
    archive.file(join(tmpDbDir, 'db.sqlite'), { name: 'db.sqlite' })
    await archive.finalize()
    const zip = Buffer.concat(chunks)

    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    expect(res.status).toBe(200)
    const host = repo.getActiveHost(deps.db)!
    expect(host.url).toBe('http://imported:8188')
    // 重开后与主机切换一样广播一次在线状态(前端角标不会停留在旧主机上)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ online: false, hostId: host.id, hostName: host.name })
  }, 20000)

  it('合法 sqlite 但 createDb 会炸的库(templates 是视图) → 400,服务照常', async () => {
    repo.createTemplate(deps.db, { name: 'KEEP', comfyJson: {}, params: [] })
    // 构造一个 sqlite 文件:templates 名字被视图占用,CREATE TABLE IF NOT EXISTS 仍会报错
    const evilDbPath = join(mkdtempSync(join(tmpdir(), 'cwe-evil-db-')), 'db.sqlite')
    const evil = new Database(evilDbPath)
    evil.exec('CREATE VIEW templates AS SELECT 1 AS x')
    evil.close()
    const archive = archiver('zip')
    const chunks: Buffer[] = []
    archive.on('data', (d: Buffer) => chunks.push(d))
    archive.file(evilDbPath, { name: 'db.sqlite' })
    await archive.finalize()
    const res = await app.request('/api/import', {
      method: 'POST',
      headers: HZ,
      body: new Uint8Array(Buffer.concat(chunks)),
    })
    expect(res.status).toBe(400)
    // 旧数据在线且可用(没有进入热切换)
    expect(repo.listTemplates(deps.db).map((t) => t.name)).toEqual(['KEEP'])
    const list = await app.request('/api/templates', { headers: H })
    expect(list.status).toBe(200)
  })

  it('400 路径不留 .import-* 临时残留', async () => {
    await app.request('/api/import', {
      method: 'POST',
      headers: HZ,
      body: new Uint8Array(Buffer.from('not a zip at all')),
    })
    const leftovers = readdirSync(dataDir).filter((n) => n.startsWith('.import-'))
    expect(leftovers).toEqual([])
  })

  it('非 zip / 缺 db.sqlite → 400,原数据不动', async () => {
    repo.createTemplate(deps.db, { name: 'KEEP', comfyJson: {}, params: [] })

    const notZip = await app.request('/api/import', {
      method: 'POST',
      headers: HZ,
      body: new Uint8Array(Buffer.from('not a zip at all')),
    })
    expect(notZip.status).toBe(400)

    // 合法 zip 但没有 db.sqlite
    const archive = archiver('zip')
    const chunks: Buffer[] = []
    archive.on('data', (d: Buffer) => chunks.push(d))
    archive.append('x', { name: 'random.txt' })
    await archive.finalize()
    const noDb = await app.request('/api/import', {
      method: 'POST',
      headers: HZ,
      body: new Uint8Array(Buffer.concat(chunks)),
    })
    expect(noDb.status).toBe(400)
    expect(((await noDb.json()) as { error: string }).error).toBe('zip 内缺少有效的 db.sqlite')

    expect(repo.listTemplates(deps.db).map((t) => t.name)).toEqual(['KEEP'])
  })

  it('并发导入 409', async () => {
    const zip = await buildBackupZip('Y')
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(zip.subarray(0, 10))
        await gate
        controller.enqueue(zip.subarray(10))
        controller.close()
      },
    })
    const p1 = app.request('/api/import', {
      method: 'POST',
      headers: HZ,
      body: slow,
      duplex: 'half',
    } as RequestInit)
    await new Promise((r) => setTimeout(r, 30))
    const r2 = await app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    expect(r2.status).toBe(409)
    release()
    expect((await p1).status).toBe(200)
  })
})
