import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import archiver from 'archiver'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { ExecutorPool } from '../src/executor-pool.js'
import { extractZip } from '../src/zip.js'
import { FakeComfy } from './fake-comfy.js'

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

/** 造一个「不真的跑 worker」的 ExecutorPool:pauseAll/resumeAll 替换成调用方传入的记录逻辑,
 * 保持与原先手写 { pause, resume } 桩等价的断言能力 */
function fakePool(
  db: Db,
  events: EventEmitter,
  dataDir: string,
  impls: {
    pauseAll?: (opts?: { abandon?: boolean }) => Promise<void>
    resumeAll?: (db: Db) => void
  },
): ExecutorPool {
  const pool = new ExecutorPool({ db, events, dataDir, comfyFactory: () => new FakeComfy() })
  if (impls.pauseAll) vi.spyOn(pool, 'pauseAll').mockImplementation(impls.pauseAll)
  if (impls.resumeAll) vi.spyOn(pool, 'resumeAll').mockImplementation(impls.resumeAll)
  return pool
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

  it('导入没有 hosts 表的旧版备份后,ensureActiveHost 补种的默认主机会被 syncFromDb 起出 worker', async () => {
    // 用真实 ExecutorPool(不 mock pauseAll/resumeAll),才能验证 resumeAll 内部
    // 真的按新库 hosts 表(含 ensureActiveHost 刚种下的默认主机)重建出 worker——
    // 上面那条按序调用的测试和其他既有导入测试全都 mock 掉了 resumeAll,盖不住这条路径
    deps.executor = new ExecutorPool({
      db: deps.db,
      events: deps.events,
      dataDir,
      comfyFactory: () => new FakeComfy(),
    })
    // buildBackupZip 造的备份只含一条 template,不含 hosts 表数据——正是「旧版备份」
    // 或者说 ensureActiveHost 存在的理由:import 完必须由它补种默认主机
    const zip = await buildBackupZip('NO-HOSTS-TABLE')
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    expect(res.status).toBe(200)
    const active = repo.getActiveHost(deps.db)
    expect(active).toBeDefined()
    // 回归点:若 resumeAll 在 ensureActiveHost 播种之前跑,这里会是 false——
    // resumeAll 那一刻 hosts 表还是空的,起不出任何 worker,种完也没人再补 sync
    expect(deps.executor.hasWorker(active!.id)).toBe(true)
  })

  it('导入时按序调用 executor pause→resume,resume 收到重开后的新 db', async () => {
    const calls: string[] = []
    let resumedDb: unknown = null
    const oldDb = deps.db
    deps.executor = fakePool(deps.db, deps.events, dataDir, {
      pauseAll: async () => {
        calls.push('pause')
      },
      resumeAll: (db) => {
        calls.push('resume')
        resumedDb = db
      },
    })
    const zip = await buildBackupZip('X')
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['pause', 'resume'])
    expect(resumedDb).toBe(deps.db)
    expect(resumedDb).not.toBe(oldDb)
  })

  it('导入与主机路由共用切换锁,不会交错', async () => {
    // activate 自 Task 6 起已不再碰 executor(不再 pauseAll),没法再借它验证锁——
    // 换成同样仍走 deps.switchLock 临界区、且仍会碰 executor 的 POST /:id/disable。
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    deps.executor = fakePool(deps.db, deps.events, dataDir, {
      pauseAll: async () => {
        calls.push('pause-start')
        await gate
        calls.push('pause-end')
      },
      resumeAll: () => calls.push('resume'),
    })
    const other = repo.createHost(deps.db, { name: 'B', url: 'http://b:8188' })
    const zip = await buildBackupZip('LOCKED')

    // 导入先拿到锁,卡在 pauseAll 里(gate 未释放)
    const pImp = app.request('/api/import', { method: 'POST', headers: HZ, body: new Uint8Array(zip) })
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual(['pause-start'])

    // disable 排在导入后面:若两处临界区不共享同一把锁(或任一处的 lock.run 被拿掉),
    // 这里会在 release() 之前就把 other 停用,下面这条断言会先失败
    const pDis = app.request(`/api/hosts/${other.id}/disable`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'wait' }),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(repo.getHost(deps.db, other.id)!.enabled).toBe(1)

    release()
    expect((await pImp).status).toBe(200)
    // 导入把整库换掉;disable 排到执行时 deps.db 已指向新库,other 的旧 id 是否仍对应
    // 一台主机取决于新库自增序列是否巧合重叠,不是本用例要证明的东西——真正的证据
    // 是上面那条 release() 之前的断言(disable 没有抢在导入前面执行)。这里只确认
    // disable 干净地跑完了临界区(不是因为锁失效而崩在中途)
    expect([200, 404]).toContain((await pDis).status)
    expect(calls).toEqual(['pause-start', 'pause-end', 'resume'])
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
