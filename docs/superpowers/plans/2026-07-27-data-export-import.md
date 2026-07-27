# 数据导出导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一键备份（zip 全量导出）与恢复（上传 zip 整体替换 + 进程内热切换，无需重启）。

**Architecture:** 新路由 `GET /api/export`（checkpoint 后 archiver 流式打包）与 `POST /api/import`（raw body 落盘 → yauzl 解压校验 → 暂停 executor → 关库换目录重开 → 替换 `deps.db` 引用）。路由每请求读 `deps.db`，热切换只需换引用；executor 增加 pause/resume。

**Tech Stack:** Hono + better-sqlite3（`db.$client` 取原生句柄，已验证 drizzle 0.44 暴露）+ archiver（已有依赖）+ yauzl（新增）。

**Spec:** `docs/superpowers/specs/2026-07-27-data-export-import-design.md`

## Global Constraints

- 分支 `feat/data-export-import`（主仓目录）；不改 `pnpm-workspace.yaml`（yauzl 纯 JS 无编译）
- 服务端相对导入必须带 `.js` 后缀（ESM）
- web 包惯例：**不写渲染测试**，手动验收清单进 PR 描述
- 精确值：导出文件名 `cwe-backup-<YYYY-MM-DD>.zip`；排除 `thumbs/`、`db.sqlite-wal`、`db.sqlite-shm`；400 文案 `zip 内缺少有效的 db.sqlite`；并发导入 409
- 导入上传是 **raw body**（`Content-Type: application/zip`），不用 multipart（parseBody 会整包进内存）
- commit 尾行：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## File Structure

- `apps/server/src/zip.ts` — 新：`safeEntryPath` + `extractZip`（解压与 zip-slip 防护，独立可测）
- `apps/server/src/routes/backup.ts` — 新：export + import 路由
- `apps/server/src/executor.ts` — pause/resume 支持
- `apps/server/src/app.ts` — `AppDeps.executor` + 挂载 `/api`
- `apps/server/src/index.ts` — deps 对象化，executor 注入
- `apps/server/test/zip.test.ts`、`apps/server/test/backup.test.ts`、`apps/server/test/executor.test.ts`（追加）
- `apps/web/src/lib/api.ts` — `backupExportUrl` + `importBackup`
- `apps/web/src/pages/backup.tsx` — 新：数据备份页
- `apps/web/src/App.tsx` — 导航 + 路由

---

### Task 1: zip 解压工具（yauzl + zip-slip 防护）

**Files:**
- Modify: `apps/server/package.json`（`pnpm --filter @cwe/server add yauzl && pnpm --filter @cwe/server add -D @types/yauzl`）
- Create: `apps/server/src/zip.ts`
- Test: `apps/server/test/zip.test.ts`

**Interfaces:**
- Produces: `safeEntryPath(name: string): string | null`（非法条目名 → null）；`extractZip(zipPath: string, destDir: string): Promise<void>`（含非法条目时 reject，Task 2/4 消费）

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @cwe/server add yauzl && pnpm --filter @cwe/server add -D @types/yauzl
```

- [ ] **Step 2: 写失败测试**

`apps/server/test/zip.test.ts` 全文：

```ts
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import { describe, expect, it } from 'vitest'
import { extractZip, safeEntryPath } from '../src/zip.js'

/** 打一个内存构造的 zip 到临时文件,返回路径 */
async function buildZip(entries: Array<{ name: string; content: string }>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cwe-zip-'))
  const zipPath = join(dir, 'test.zip')
  const archive = archiver('zip')
  const done = pipeline(archive, createWriteStream(zipPath))
  for (const e of entries) archive.append(e.content, { name: e.name })
  await archive.finalize()
  await done
  return zipPath
}

describe('safeEntryPath', () => {
  it('合法相对路径原样(规范化)通过', () => {
    expect(safeEntryPath('a.txt')).toBe('a.txt')
    expect(safeEntryPath('sub/b.txt')).toBe(join('sub', 'b.txt'))
  })

  it('绝对路径与越界路径拒绝', () => {
    expect(safeEntryPath('/abs.txt')).toBeNull()
    expect(safeEntryPath('C:/win.txt')).toBeNull()
    expect(safeEntryPath('../up.txt')).toBeNull()
    expect(safeEntryPath('a/../../up.txt')).toBeNull()
    expect(safeEntryPath('..')).toBeNull()
    expect(safeEntryPath('a\\..\\..\\up.txt')).toBeNull()
  })
})

describe('extractZip', () => {
  it('往返解压:目录结构与内容一致', async () => {
    const zipPath = await buildZip([
      { name: 'db.sqlite', content: 'not-really-a-db' },
      { name: 'uploads/u.png', content: 'img-bytes' },
      { name: 'outputs/1/o.png', content: 'out-bytes' },
    ])
    const dest = mkdtempSync(join(tmpdir(), 'cwe-extract-'))
    await extractZip(zipPath, dest)
    expect(readFileSync(join(dest, 'db.sqlite'), 'utf8')).toBe('not-really-a-db')
    expect(readFileSync(join(dest, 'uploads', 'u.png'), 'utf8')).toBe('img-bytes')
    expect(readFileSync(join(dest, 'outputs', '1', 'o.png'), 'utf8')).toBe('out-bytes')
  })

  it('zip-slip 条目名 reject', async () => {
    // archiver 会规范化条目名,无法直接造毒 zip;
    // 构造合法 zip 后把 4 字节文件名 'evil' 二进制替换为等长的 '../e'
    // (文件名在 local header 与 central directory 各出现一次,长度字段不变)
    const zipPath = await buildZip([{ name: 'evil', content: 'x' }])
    const patched = Buffer.from(readFileSync(zipPath))
    let idx: number
    while ((idx = patched.indexOf('evil')) !== -1) patched.write('../e', idx)
    const evilPath = join(mkdtempSync(join(tmpdir(), 'cwe-evil-')), 'evil.zip')
    writeFileSync(evilPath, patched)
    const dest = mkdtempSync(join(tmpdir(), 'cwe-extract2-'))
    await expect(extractZip(evilPath, dest)).rejects.toThrow('非法 zip 条目')
  })

  it('非 zip 文件 reject', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwe-notzip-'))
    const notZip = join(dir, 'x.zip')
    writeFileSync(notZip, 'this is not a zip')
    await expect(extractZip(notZip, join(dir, 'out'))).rejects.toThrow()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- zip`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

`apps/server/src/zip.ts` 全文：

```ts
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

/** zip entry 名 → 目标目录内安全相对路径;绝对路径/盘符/越界(..)返回 null */
export function safeEntryPath(name: string): string | null {
  const unified = name.replaceAll('\\', '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null
  const norm = normalize(unified)
  if (norm === '..' || norm.split(sep).includes('..')) return null
  return norm
}

/** 流式解压 zip 到 destDir;含非法条目名时 reject 且不再继续写 */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip 打开失败'))
      const fail = (e: Error) => {
        zip.close()
        reject(e)
      }
      zip.on('error', fail)
      zip.on('end', () => resolve())
      zip.on('entry', (entry: yauzl.Entry) => {
        const rel = safeEntryPath(entry.fileName)
        if (rel === null) return fail(new Error(`非法 zip 条目: ${entry.fileName}`))
        const dest = join(destDir, rel)
        if (entry.fileName.endsWith('/')) {
          mkdir(dest, { recursive: true }).then(() => zip.readEntry(), fail)
          return
        }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return fail(err2 ?? new Error('zip 条目读取失败'))
          mkdir(dirname(dest), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(dest)))
            .then(() => zip.readEntry(), fail)
        })
      })
      zip.readEntry()
    })
  })
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- zip`
Expected: PASS（zip-slip 二进制补丁测试若因 archiver 版本行为变化无法构造，调整补丁方式而非删测试）

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/zip.ts apps/server/test/zip.test.ts
git commit -m "feat(server): zip 解压工具(yauzl+zip-slip 防护)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 导出路由 GET /api/export

**Files:**
- Create: `apps/server/src/routes/backup.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/backup.test.ts`

**Interfaces:**
- Consumes: Task 1 `extractZip`（测试解包用）；既有 `archiver`、`deps.db.$client`（better-sqlite3 原生句柄，drizzle `$client` 已验证可用）
- Produces: `backupRoutes(deps: AppDeps)` 挂 `/api`（Task 4 在同文件加 import 路由）

- [ ] **Step 1: 写失败测试**

`apps/server/test/backup.test.ts` 全文（Task 4 会追加导入部分）：

```ts
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
```

注意：`AppDeps` 尚无 `executor` 字段——先在本 task 给 `app.ts` 的 `AppDeps` 加可选字段（见 Step 3），Task 4 才真正使用。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- backup`
Expected: FAIL（/api/export 404）

- [ ] **Step 3: 实现**

`apps/server/src/routes/backup.ts` 全文（import 路由 Task 4 追加）：

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'

export function backupRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/export', (c) => {
    // WAL 合回主库,zip 里的 db.sqlite 才含最近写入
    deps.db.$client.pragma('wal_checkpoint(TRUNCATE)')
    const archive = archiver('zip')
    archive.on('error', (err) => console.error('export zip error', err))
    archive.on('warning', (err) => console.error('export zip warning', err))
    archive.file(join(deps.config.dataDir, 'db.sqlite'), { name: 'db.sqlite' })
    for (const sub of ['uploads', 'outputs'] as const) {
      const dir = join(deps.config.dataDir, sub)
      if (existsSync(dir)) archive.directory(dir, sub)
    }
    void archive.finalize()
    const date = new Date().toISOString().slice(0, 10)
    c.header('Content-Type', 'application/zip')
    c.header('Content-Disposition', `attachment; filename="cwe-backup-${date}.zip"`)
    return c.body(Readable.toWeb(archive) as ReadableStream)
  })

  return app
}
```

`apps/server/src/app.ts`：

- `AppDeps` 追加字段（结构化类型，避免依赖 Executor 类）：

```ts
  executor?: { pause(): Promise<void>; resume(db: Db): void } | null
```

- import 区加 `import { backupRoutes } from './routes/backup.js'`
- 挂载区（`comfyRoutes` 行前）加：

```ts
app.route('/api', backupRoutes(deps))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test`
Expected: 全绿（既有测试不回归——`executor` 是可选字段，老 harness 不用改）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/backup.ts apps/server/src/app.ts apps/server/test/backup.test.ts
git commit -m "feat(server): GET /api/export 全量 zip 导出(checkpoint+流式)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Executor pause/resume（热切换支撑）

**Files:**
- Modify: `apps/server/src/executor.ts`
- Test: `apps/server/test/executor.test.ts`（追加）

**Interfaces:**
- Produces: `Executor.pause(): Promise<void>`（停轮询并等当前任务/循环收尾）；`Executor.resume(db: Db): void`（换库、清 GPU 上传映射、重启循环）。与 `AppDeps.executor` 的结构化类型一致（Task 2 已定义）

- [ ] **Step 1: 写失败测试**

`apps/server/test/executor.test.ts` describe 内追加（该文件已有 `makeExecutor`/`seed` helper 与 `db` 变量）：

```ts
  it('pause 等循环退出;resume 换库后跑新库任务', async () => {
    const ex = makeExecutor()
    ex.start()
    await ex.pause()

    const db2 = createDb(':memory:')
    const t = repo.createTemplate(db2, { name: 'T2', comfyJson, params })
    const b = repo.createBatch(db2, t.id, { name: 'B2', jobs: [{ prompt: 'z' }] })
    ex.resume(db2)
    await vi.waitFor(() => {
      expect(repo.getBatchDetail(db2, b.id)!.jobs[0]!.status).toBe('succeeded')
    })
    ex.stop()
    // 旧库无任何任务被创建/执行
    expect(repo.listBatches(db)).toHaveLength(0)
  })
```

文件顶部 vitest import 补 `vi`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- executor`
Expected: FAIL（pause 不存在）

- [ ] **Step 3: 实现**

`apps/server/src/executor.ts`：

- `private readonly db: Db` → `private db: Db`
- 字段区加 `private loopPromise: Promise<void> | null = null`
- `start()` 中 `void this.loop()` → `this.loopPromise = this.loop()`
- `stop()` 之后追加：

```ts
  /** 停下并等当前任务/轮询收尾(数据导入热切换用) */
  async pause(): Promise<void> {
    this.stop()
    await this.loopPromise
    this.loopPromise = null
  }

  /** 换库后重启(数据导入热切换用);GPU 上传映射清空,靠 overwrite 幂等重传 */
  resume(db: Db): void {
    this.db = db
    this.gpuUploads.clear()
    this.start()
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- executor`
Expected: 全绿（pause 最多等一个 pollMs 睡眠周期，测试 pollMs=5 很快）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/executor.ts apps/server/test/executor.test.ts
git commit -m "feat(server): executor pause/resume 支持换库热切换

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 导入路由 POST /api/import（热切换）

**Files:**
- Modify: `apps/server/src/routes/backup.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/backup.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `extractZip`；Task 2 `backupRoutes`/`AppDeps.executor`；Task 3 `pause`/`resume`；既有 `createDb`
- Produces: `POST /api/import`（raw zip body → 200 `{ok:true}` / 400 / 409 / 500）

- [ ] **Step 1: 写失败测试**

`apps/server/test/backup.test.ts` 追加：

```ts
async function buildBackupZip(templateName: string): Promise<Buffer> {
  // 用一套独立 dataDir + app 造出真实导出包
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
    const zip = await buildBackupZip('FROM-ZIP')
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: zip })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const list = repo.listTemplates(deps.db).map((t) => t.name)
    expect(list).toEqual(['FROM-ZIP'])
    expect(existsSync(join(dataDir, 'uploads', 'from-zip.png'))).toBe(true)
    expect(existsSync(join(dataDir, 'outputs'))).toBe(true)

    const parent = join(dataDir, '..')
    const bak = readdirSync(parent).find((n) => n.startsWith(`${basename(dataDir)}.bak-`))
    expect(bak).toBeDefined()
    const old = new Database(join(parent, bak!, 'db.sqlite'), { readonly: true })
    const row = old.prepare('SELECT name FROM templates').get() as { name: string }
    old.close()
    expect(row.name).toBe('OLD')
  })

  it('导入时按序调用 executor pause→resume,resume 收到新 db', async () => {
    const calls: string[] = []
    deps.executor = {
      pause: async () => {
        calls.push('pause')
      },
      resume: () => {
        calls.push('resume')
      },
    }
    const zip = await buildBackupZip('X')
    const res = await app.request('/api/import', { method: 'POST', headers: HZ, body: zip })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['pause', 'resume'])
  })

  it('非 zip / 缺 db.sqlite → 400,原数据不动', async () => {
    repo.createTemplate(deps.db, { name: 'KEEP', comfyJson: {}, params: [] })

    const notZip = await app.request('/api/import', {
      method: 'POST',
      headers: HZ,
      body: Buffer.from('not a zip at all'),
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
      body: Buffer.concat(chunks),
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
    const r2 = await app.request('/api/import', { method: 'POST', headers: HZ, body: zip })
    expect(r2.status).toBe(409)
    release()
    expect((await p1).status).toBe(200)
  })
})
```

test 文件顶部 import 补：`readdirSync`（node:fs）、`basename`（node:path）、`archiver`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- backup`
Expected: 新 describe FAIL（/api/import 404）

- [ ] **Step 3: 实现**

`apps/server/src/routes/backup.ts`：import 区补齐：

```ts
import Database from 'better-sqlite3'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDb } from '../db/index.js'
import { extractZip } from '../zip.js'
```

`backupRoutes` 内 export 路由后追加：

```ts
  let importing = false

  app.post('/import', async (c) => {
    if (importing) return c.json({ error: '已有导入进行中' }, 409)
    importing = true
    const stamp = Date.now()
    const dataDir = resolve(deps.config.dataDir)
    const tmpZip = `${dataDir}.import-${stamp}.zip`
    const tmpDir = `${dataDir}.import-${stamp}`
    try {
      const body = c.req.raw.body
      if (!body) return c.json({ error: '请求体为空' }, 400)
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmpZip))

      try {
        await extractZip(tmpZip, tmpDir)
      } catch (err) {
        return c.json(
          { error: `zip 解析失败: ${err instanceof Error ? err.message : String(err)}` },
          400,
        )
      }

      const dbPath = join(tmpDir, 'db.sqlite')
      let valid = existsSync(dbPath)
      if (valid) {
        try {
          const check = new Database(dbPath, { readonly: true })
          check.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
          check.close()
        } catch {
          valid = false
        }
      }
      if (!valid) return c.json({ error: 'zip 内缺少有效的 db.sqlite' }, 400)

      // 热切换:暂停执行器 → 关库 → 换目录(留 bak) → 重开 → 换引用 → 复跑
      await deps.executor?.pause()
      deps.db.$client.close()
      const bak = `${dataDir}.bak-${stamp}`
      try {
        await rename(dataDir, bak)
        try {
          await rename(tmpDir, dataDir)
        } catch (err) {
          await rename(bak, dataDir) // 回滚:旧目录归位
          throw err
        }
      } finally {
        // 无论换成新旧哪套目录,都要重开 db 恢复服务
        await mkdir(join(dataDir, 'uploads'), { recursive: true })
        await mkdir(join(dataDir, 'outputs'), { recursive: true })
        const reopened = createDb(join(dataDir, 'db.sqlite'))
        deps.db = reopened
        deps.executor?.resume(reopened)
      }
      return c.json({ ok: true })
    } finally {
      importing = false
      await rm(tmpZip, { force: true }).catch(() => {})
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })
```

`apps/server/src/index.ts`：deps 先建对象再注入 executor（executor 创建在 createApp 之后也行，关键是 app 与 executor 共享同一个 deps 对象）：

```ts
const deps = { config, db, comfy, events, executor: null as null | Executor }
const app = createApp(deps)
// ...创建 executor 后:
deps.executor = executor
```

（保持现有 comfy 为 null 时不建 executor 的逻辑不变；null 时 `deps.executor` 维持 null。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test`
Expected: 全绿。若「并发导入 409」因 `app.request` 不支持流式 body 而挂，把慢流改为：先手动置 `importing`——不可行（闭包私有）——则改用大 zip（重复填充数 MB uploads 文件）自然拉长第一个请求；仍不稳定则删掉该自动化测试并在 PR 描述记为人工验收项，**不得**为测试暴露内部闸变量。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/backup.ts apps/server/src/index.ts apps/server/test/backup.test.ts
git commit -m "feat(server): POST /api/import 整体替换+热切换

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 数据备份页 + 导航

**Files:**
- Modify: `apps/web/src/lib/api.ts`（末尾追加）
- Create: `apps/web/src/pages/backup.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 2/4 的 `/api/export`、`/api/import`；既有 `getToken`、shadcn `Button`/`AlertDialog` 系列
- Produces: 页面 `/backup`；`backupExportUrl(): string`；`importBackup(file: File): Promise<void>`

- [ ] **Step 1: api helper**

`apps/web/src/lib/api.ts` 末尾追加：

```ts
export function backupExportUrl(): string {
  return `/api/export?token=${encodeURIComponent(getToken())}`
}

/** 导入备份 zip:raw body 上传(不 multipart),后端整体替换数据 */
export async function importBackup(file: File): Promise<void> {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/zip' },
    body: file,
  })
  if (!res.ok) throw new Error(await res.text())
}
```

- [ ] **Step 2: 备份页**

`apps/web/src/pages/backup.tsx` 全文：

```tsx
import { DownloadIcon, UploadIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { backupExportUrl, importBackup } from '@/lib/api'

function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return '操作失败'
  try {
    return (JSON.parse(e.message) as { error?: string }).error ?? e.message
  } catch {
    return e.message
  }
}

export default function BackupPage() {
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function doImport(file: File) {
    setBusy(true)
    setMsg('导入中……若有任务在运行，会先等它完成再切换')
    try {
      await importBackup(file)
      setMsg('导入成功，即将刷新')
      window.location.reload()
    } catch (e) {
      setMsg(`导入失败：${errMsg(e)}`)
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-lg font-semibold">数据备份</h1>

      <section className="space-y-2 rounded-md border p-4">
        <p className="text-sm font-medium">导出</p>
        <p className="text-sm text-muted-foreground">
          打包下载全部数据（数据库 + 输入图 + 产出图；不含可再生的缩略图缓存）。
        </p>
        <Button size="sm" asChild>
          <a href={backupExportUrl()} download>
            <DownloadIcon className="size-4" /> 导出 zip
          </a>
        </Button>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <p className="text-sm font-medium">导入</p>
        <p className="text-sm text-muted-foreground">
          上传之前导出的 zip，整体替换当前数据。
        </p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          <UploadIcon className="size-4" /> 选择 zip 导入
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setPendingFile(f)
            e.target.value = ''
          }}
        />
      </section>

      {msg && <p className="text-sm">{msg}</p>}

      <AlertDialog open={pendingFile !== null} onOpenChange={(o) => !o && setPendingFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>导入 {pendingFile?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              将整体替换现有全部数据，且不可撤销（旧数据保留在服务端 bak 目录）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const f = pendingFile
                setPendingFile(null)
                if (f) void doImport(f)
              }}
            >
              导入并替换
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

- [ ] **Step 3: 导航与路由**

`apps/web/src/App.tsx`：

- import 区加 `import BackupPage from '@/pages/backup'`
- nav 中 Templates Link 之后加：

```tsx
<Link to="/backup" className="text-sm hover:underline">
  数据备份
</Link>
```

- Routes 中 `/templates/new` 行后加：

```tsx
<Route path="/backup" element={<BackupPage />} />
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm --filter @cwe/web build && pnpm test`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/pages/backup.tsx apps/web/src/App.tsx
git commit -m "feat(web): 数据备份页(导出下载/导入整体替换)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（放 PR 描述）

1. 导出下载的 zip 用系统工具能打开，含 db.sqlite/uploads/outputs、无 thumbs
2. 导入刚导出的 zip → 页面刷新后数据一致；服务端出现 bak 目录
3. 导入期间 UI 忙态；完成自动刷新
4. 选非 zip 文件导入 → 报错且数据不变
5. 有任务运行中导入 → 等当前任务完成后切换，任务不丢
6. 导入后新建批次、跑图正常（executor 换库后工作正常）
