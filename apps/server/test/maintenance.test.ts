import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
let dataDir: string
let deps: AppDeps
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-maint-'))
  db = createDb(':memory:')
  deps = {
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db,
    comfy: new FakeComfy(),
    events: new EventEmitter(),
  }
  app = createApp(deps)
})

/** 布置:1 个 bak 目录(1 文件)、1 个新鲜 .import、1 个过期 .import、thumbs 2 文件、
 * 1 个合法 batch 输出目录、1 个孤儿数字目录、1 个非数字目录 */
function seedDisk() {
  mkdirSync(join(dataDir, '.bak-100'))
  writeFileSync(join(dataDir, '.bak-100', 'db.sqlite'), 'x'.repeat(10))
  writeFileSync(join(dataDir, '.import-fresh.zip'), 'y'.repeat(5))
  writeFileSync(join(dataDir, '.import-stale.zip'), 'z'.repeat(5))
  const old = (Date.now() - 2 * 3600_000) / 1000
  utimesSync(join(dataDir, '.import-stale.zip'), old, old)
  mkdirSync(join(dataDir, 'thumbs', 'uploads'), { recursive: true })
  writeFileSync(join(dataDir, 'thumbs', 'uploads', 'a.webp'), 'a'.repeat(3))
  writeFileSync(join(dataDir, 'thumbs', 'uploads', 'b.webp'), 'b'.repeat(3))
  const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
  const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{}] })
  mkdirSync(join(dataDir, 'outputs', String(b.id)), { recursive: true })
  writeFileSync(join(dataDir, 'outputs', String(b.id), 'keep.png'), 'k')
  mkdirSync(join(dataDir, 'outputs', '9999'))
  writeFileSync(join(dataDir, 'outputs', '9999', 'orphan.png'), 'o'.repeat(7))
  mkdirSync(join(dataDir, 'outputs', 'not-a-batch'))
  writeFileSync(join(dataDir, 'outputs', 'not-a-batch', 'x.png'), 'q')
  return b
}

describe('GET /api/maintenance/summary', () => {
  it('统计三类条目数与字节', async () => {
    seedDisk()
    const res = await app.request('/api/maintenance/summary', { headers: H })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.bak.count).toBe(3) // .bak-100 + 两个 .import
    expect(body.bak.bytes).toBe(20)
    expect(body.thumbs.count).toBe(2)
    expect(body.thumbs.bytes).toBe(6)
    expect(body.orphanOutputs.count).toBe(2) // 9999 + not-a-batch
    expect(body.orphanOutputs.bytes).toBe(8)
  })

  it('空 dataDir 全零', async () => {
    const res = await app.request('/api/maintenance/summary', { headers: H })
    const body = (await res.json()) as any
    expect(body).toEqual({
      bak: { count: 0, bytes: 0 },
      thumbs: { count: 0, bytes: 0 },
      orphanOutputs: { count: 0, bytes: 0 },
    })
  })
})

describe('POST /api/maintenance/clean', () => {
  it('bak:过期条目删除,新鲜 .import 保留', async () => {
    seedDisk()
    const res = await app.request('/api/maintenance/clean', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ targets: ['bak'] }),
    })
    const body = (await res.json()) as any
    expect(body.results.bak.freedBytes).toBe(15) // bak-100(10) + stale(5)
    expect(body.results.bak.failed).toEqual([])
    expect(existsSync(join(dataDir, '.import-fresh.zip'))).toBe(true)
    expect(existsSync(join(dataDir, '.bak-100'))).toBe(false)
    expect(existsSync(join(dataDir, '.import-stale.zip'))).toBe(false)
  })

  it('thumbs 全清;orphan-outputs 只删孤儿目录', async () => {
    const b = seedDisk()
    const res = await app.request('/api/maintenance/clean', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ targets: ['thumbs', 'orphan-outputs'] }),
    })
    const body = (await res.json()) as any
    expect(body.results.thumbs.freedBytes).toBe(6)
    expect(body.results['orphan-outputs'].freedBytes).toBe(8)
    expect(existsSync(join(dataDir, 'thumbs'))).toBe(false)
    expect(existsSync(join(dataDir, 'outputs', '9999'))).toBe(false)
    expect(existsSync(join(dataDir, 'outputs', 'not-a-batch'))).toBe(false)
    expect(existsSync(join(dataDir, 'outputs', String(b.id), 'keep.png'))).toBe(true)
  })

  it('targets 非法 400', async () => {
    const res = await app.request('/api/maintenance/clean', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ targets: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('清理与热切换锁串行(锁被占用时等待完成)', async () => {
    seedDisk()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const order: string[] = []
    // createApp 已惰性初始化 switchLock;先占住锁
    const holding = deps.switchLock!.run(async () => {
      order.push('lock-start')
      await gate
      order.push('lock-end')
    })
    const cleanP = (async () => {
      const r = await app.request('/api/maintenance/clean', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ targets: ['bak'] }),
      })
      order.push('clean-done')
      return r
    })()
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(['lock-start']) // 清理在锁后排队
    release()
    await holding
    const res = await cleanP
    expect(res.status).toBe(200)
    expect(order).toEqual(['lock-start', 'lock-end', 'clean-done'])
  })
})

describe('repo.listAllGpuRefKeys', () => {
  it('收集全库 gpu 引用键,无 gpu 字段的输出跳过', () => {
    const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{}, {}] })
    const c1 = repo.claimNextJob(db)!
    repo.finishJob(db, c1.job.id, [
      { path: `${b.id}/0-0-a.png`, filename: '0-0-a.png', gpu: { filename: 'a.png', subfolder: 'sub' } },
    ])
    const c2 = repo.claimNextJob(db)!
    repo.finishJob(db, c2.job.id, [{ path: `${b.id}/1-0-b.png`, filename: '1-0-b.png' }])
    expect(repo.listAllGpuRefKeys(db)).toEqual(new Set(['sub/a.png']))
  })
})

describe('GPU 孤儿扫描与清理', () => {
  function fake() {
    return deps.comfy as FakeComfy
  }
  function seedRefs() {
    const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{}] })
    const c1 = repo.claimNextJob(db)!
    repo.finishJob(db, c1.job.id, [
      { path: `${b.id}/0-0-a.png`, filename: '0-0-a.png', gpu: { filename: 'a.png', subfolder: '' } },
    ])
  }

  it('孤儿 = 列举 − 全库引用并集;默认扫当前主机', async () => {
    repo.ensureActiveHost(db, 'http://h1:8188')
    seedRefs()
    fake().outputFiles = [
      { filename: 'a.png', subfolder: '', size: 10, mtime: 1 }, // 有引用
      { filename: 'stray.png', subfolder: '', size: 7, mtime: 2 },
      { filename: 'x.png', subfolder: 'manual', size: 3, mtime: 3 },
    ]
    const res = await app.request('/api/maintenance/gpu-orphans', { headers: H })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.host.name).toBe('默认主机')
    expect(body.orphans.map((o: any) => o.filename).sort()).toEqual(['stray.png', 'x.png'])
    expect(body.totalBytes).toBe(10)
  })

  it('v1 扩展 409;离线 503;主机不存在 404', async () => {
    repo.ensureActiveHost(db, 'http://h1:8188')
    fake().cwePingVersion = 1
    expect((await app.request('/api/maintenance/gpu-orphans', { headers: H })).status).toBe(409)
    fake().cwePingVersion = 0
    expect((await app.request('/api/maintenance/gpu-orphans', { headers: H })).status).toBe(503)
    expect(
      (await app.request('/api/maintenance/gpu-orphans?hostId=999', { headers: H })).status,
    ).toBe(404)
  })

  it('非 active 主机经 comfyFactory 扫描', async () => {
    repo.ensureActiveHost(db, 'http://h1:8188')
    const h2 = repo.createHost(db, { name: 'H2', url: 'http://h2:8188' })
    const remote = new FakeComfy()
    remote.outputFiles = [{ filename: 'r.png', subfolder: '', size: 4, mtime: 1 }]
    deps.comfyFactory = () => remote
    const res = await app.request(`/api/maintenance/gpu-orphans?hostId=${h2.id}`, { headers: H })
    const body = (await res.json()) as any
    expect(body.host.id).toBe(h2.id)
    expect(body.orphans).toHaveLength(1)
  })

  it('gpu-clean 转发删除并透传结果;files 超限 400', async () => {
    const h1 = repo.ensureActiveHost(db, 'http://h1:8188')
    fake().cweDeleteResult = { deleted: 1, missing: 1, failed: [] }
    const res = await app.request('/api/maintenance/gpu-clean', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ hostId: h1.id, files: [{ filename: 's.png', subfolder: '' }] }),
    })
    expect(await res.json()).toEqual({ deleted: 1, missing: 1, failed: [] })
    expect(fake().cweDeleted).toEqual([[{ filename: 's.png', subfolder: '' }]])
    const big = Array.from({ length: 1001 }, (_, i) => ({ filename: `${i}.png`, subfolder: '' }))
    expect(
      (
        await app.request('/api/maintenance/gpu-clean', {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ hostId: h1.id, files: big }),
        })
      ).status,
    ).toBe(400)
  })
})
