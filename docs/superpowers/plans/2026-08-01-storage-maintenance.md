# 存储维护中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四类孤儿文件（GPU 侧无引用 / 导入 bak 残留 / thumbs 缓存 / 本地孤儿 outputs 目录）的统计与清理（spec: `docs/superpowers/specs/2026-08-01-storage-maintenance-design.md`）。

**Architecture:** cwe 扩展升 v2 加 list 端点；服务端 `/api/maintenance` 提供本地统计/清理（清理进 switchLock 与导入互斥）与 GPU 孤儿扫描（全库引用并集比对，按主机、经 comfyFactory）；前端 `/maintenance` 页（GPU 清单确认式，默认全不勾，thumbs 新 `comfy-output` 源做预览）。

**Tech Stack:** Hono + better-sqlite3 + drizzle + vitest（server）；aiohttp 路由（cwe 扩展，纯 Python 无测试基建）；React 19 + react-query + shadcn/ui（web）。

## Global Constraints

- **分支 `feat/storage-maintenance` 基于 `chore/tech-debt-batch`**（依赖其 `errorMessage` 助手与 spec 提交；PR #22 验收中，将先于本分支合并）；worktree `.worktrees/storage-maintenance`
- 提交尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；server import 带 `.js`（ESM）；不新增依赖；UI 文案中文；web 不写渲染测试
- 测试命令：`pnpm --filter @cwe/server test <pattern>`；全量 `pnpm test` + `pnpm typecheck`（worktree 根执行）
- 响应形状（server 与 web 必须一致）：summary `{ bak: {count,bytes}, thumbs: {count,bytes}, orphanOutputs: {count,bytes} }`；clean `{ results: { [target]: { freedBytes, failed: string[] } } }`；gpu-orphans `{ host: {id,name}, orphans: [{filename,subfolder,size,mtime}], totalBytes }`；gpu-clean `{ deleted, missing, failed: string[] }`
- 安全不变量：`.import-*` 仅删 mtime 距今 > 1 小时的条目；清理动作整体进 `deps.switchLock`；GPU 孤儿 = 列举 −（全库引用并集）；`/gpu-clean` files 上限 1000；uploads 永不清理

---

### Task 1: cwe 扩展 v2（Python，list 端点）

**Files:**
- Modify: `comfyui-cwe/__init__.py`
- Modify: `comfyui-cwe/README.md`

**Interfaces:**
- Produces: `GET /cwe/ping` → `{"ok": true, "version": 2}`；`GET /cwe/list-output-files` → `{"files": [{"filename", "subfolder", "size", "mtime"}]}`（subfolder 根为 `""`，mtime 整秒 epoch）

无 Python 测试基建，验证 = 语法检查 + 部署后手动（与 v1 惯例一致）。

- [ ] **Step 1: 改 VERSION 与新端点**

`__init__.py`：`VERSION = 1` → `VERSION = 2`；文件末尾（`NODE_CLASS_MAPPINGS` 之前）追加：

```python
@routes.get("/cwe/list-output-files")
async def cwe_list_output_files(request):
    """递归列举 output 目录普通文件(孤儿扫描用);符号链接逃逸出根的条目跳过。"""
    out_root = os.path.realpath(folder_paths.get_output_directory())
    files = []
    for dirpath, _dirnames, filenames in os.walk(out_root):
        for name in filenames:
            real = os.path.realpath(os.path.join(dirpath, name))
            if not real.startswith(out_root + os.sep):
                continue
            if not os.path.isfile(real):
                continue
            st = os.stat(real)
            sub = os.path.relpath(dirpath, out_root)
            files.append({
                "filename": name,
                "subfolder": "" if sub == "." else sub,
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            })
    return web.json_response({"files": files})
```

- [ ] **Step 2: 语法验证** — Run: `python3 -c "import ast; ast.parse(open('comfyui-cwe/__init__.py').read())"` → 无输出即通过
- [ ] **Step 3: README 更新** — 端点清单加 `GET /cwe/list-output-files`（一行说明+响应形状）；「安装」节加升级提示：已装 v1 的直接覆盖目录后重启 ComfyUI，`curl .../cwe/ping` 应返回 `"version": 2`
- [ ] **Step 4: Commit**

```bash
git add comfyui-cwe
git commit -m "feat(cwe): v2 — output 文件列举端点(孤儿扫描用)"
```

---

### Task 2: ComfyClient 版本化 ping + list/getOutputImage + 消费方适配

**Files:**
- Modify: `apps/server/src/comfy/client.ts`
- Modify: `apps/server/src/routes/comfy.ts`（cwe-status 响应）
- Modify: `apps/server/src/routes/hosts.ts`（两处 `cwePing()` 布尔用法适配）
- Modify: `apps/server/test/fake-comfy.ts`
- Modify: `apps/web/src/hooks/use-cwe-status.ts`（类型加 version）
- Test: `apps/server/test/comfy-routes.test.ts`（cwe-status 用例调整）

**Interfaces:**
- Produces（后续任务依赖）:
  - `ComfyClient.cwePing(): Promise<number>` —— `0`=未装/离线/异常，`1`=旧版（响应无 version 字段），`2+`=对应版本
  - `ComfyClient.cweListOutputFiles(): Promise<Array<{ filename: string; subfolder: string; size: number; mtime: number }>>`（10s 超时，非 200 抛错）
  - `ComfyClient.getOutputImage(name: string): Promise<ArrayBuffer | null>`（`/view?type=output`，404 → null，`sub/name.png` 相对名）
  - FakeComfy：`cwePingVersion = 2`（cwePing 返回它）；`outputFiles: Array<{filename,subfolder,size,mtime}> = []`；`outputImages: Record<string, Buffer> = {}`
  - `GET /api/comfy/cwe-status` → `{ installed: boolean, version: number }`

- [ ] **Step 1: 写失败测试** — `comfy-routes.test.ts` 中现有 cwe-status 用例改断言新形状（找到设 `cwePingResult` 的用例，迁移为 `cwePingVersion`）：

```ts
  it('cwe-status 返回安装状态与版本', async () => {
    comfy.cwePingVersion = 2
    let body = await (await app.request('/api/comfy/cwe-status', { headers: H })).json()
    expect(body).toEqual({ installed: true, version: 2 })
    comfy.cwePingVersion = 0
    body = await (await app.request('/api/comfy/cwe-status', { headers: H })).json()
    expect(body).toEqual({ installed: false, version: 0 })
  })
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @cwe/server test comfy-routes` → FAIL
- [ ] **Step 3: 实现**

`client.ts` 接口声明：

```ts
  /** cwe 扩展版本:0=未装/离线/异常,1=旧版(无 version 字段),2+=对应版本 */
  cwePing(): Promise<number>
  /** 列举 GPU output 目录全部文件(需扩展 v2);非 200 抛错 */
  cweListOutputFiles(): Promise<
    Array<{ filename: string; subfolder: string; size: number; mtime: number }>
  >
  /** 拉取 GPU output 图片字节;404 返回 null。name 支持 sub/name.png 子目录写法 */
  getOutputImage(name: string): Promise<ArrayBuffer | null>
```

实现（cwePing 整体替换；另两个新增，getOutputImage 与 getInputImage 同构仅 type 不同）：

```ts
    async cwePing() {
      try {
        const res = await fetch(`${http}/cwe/ping`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) return 0
        const body = (await res.json()) as { ok?: boolean; version?: number }
        if (body.ok !== true) return 0
        return typeof body.version === 'number' ? body.version : 1
      } catch {
        return 0
      }
    },

    async cweListOutputFiles() {
      const res = await fetch(`${http}/cwe/list-output-files`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`cwe list failed: ${res.status}`)
      const body = (await res.json()) as {
        files?: Array<{ filename: string; subfolder: string; size: number; mtime: number }>
      }
      return body.files ?? []
    },

    async getOutputImage(name) {
      const idx = name.lastIndexOf('/')
      const qs = new URLSearchParams({
        filename: idx >= 0 ? name.slice(idx + 1) : name,
        subfolder: idx >= 0 ? name.slice(0, idx) : '',
        type: 'output',
      })
      const res = await fetch(`${http}/view?${qs}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`view failed: ${res.status}`)
      return res.arrayBuffer()
    },
```

`routes/comfy.ts` cwe-status 整体替换：

```ts
  /** cwe 扩展探测:未配置/离线/未安装均 installed:false(能力探测,不用 503) */
  app.get('/cwe-status', async (c) => {
    if (!deps.comfy) return c.json({ installed: false, version: 0 })
    const version = await deps.comfy.cwePing().catch(() => 0)
    return c.json({ installed: version > 0, version })
  })
```

`routes/hosts.ts`：`/current/stats` 与 `/:id/test` 里 `cwePing()` 的结果现在是 number——两处响应字段 `cwe` 保持 boolean：`const cwe = (await ….cwePing()) > 0`（Promise.all 处对应元素同理处理）。

`fake-comfy.ts`：删 `cwePingResult`，加 `cwePingVersion = 2`、`outputFiles`、`outputImages` 字段；实现：

```ts
  async cwePing() {
    return this.cwePingVersion
  }
  async cweListOutputFiles() {
    return this.outputFiles
  }
  async getOutputImage(name: string): Promise<ArrayBuffer | null> {
    const buf = this.outputImages[name]
    return buf ? (Uint8Array.from(buf).buffer as ArrayBuffer) : null
  }
```

全仓 grep `cwePingResult` 迁移残余用法（`= false` → `cwePingVersion = 0`）。

`use-cwe-status.ts`：`api<{ installed: boolean }>` → `api<{ installed: boolean; version: number }>`。

- [ ] **Step 4: 全量验证** — `pnpm --filter @cwe/server test` + `pnpm typecheck` 全绿
- [ ] **Step 5: Commit**

```bash
git add apps/server apps/web/src/hooks/use-cwe-status.ts
git commit -m "feat(server): cwePing 版本化+cwe 文件列举/输出图读取 client 方法"
```

---

### Task 3: maintenance 路由——本地统计与清理

**Files:**
- Create: `apps/server/src/routes/maintenance.ts`
- Modify: `apps/server/src/db/repo.ts`（`listAllGpuRefKeys`）
- Modify: `apps/server/src/app.ts`（挂载）
- Test: `apps/server/test/maintenance.test.ts`（新建）

**Interfaces:**
- Consumes: `deps.switchLock`（`hosts.ts`/`backup.ts` 同款 `deps.switchLock ??= createAsyncLock()` 惰性初始化模式）
- Produces:
  - `GET /api/maintenance/summary` → `{ bak: { count, bytes }, thumbs: { count, bytes }, orphanOutputs: { count, bytes } }`
  - `POST /api/maintenance/clean` body `{ targets: Array<'bak' | 'thumbs' | 'orphan-outputs'> }`（zod，非空）→ `{ results: { [target]: { freedBytes: number, failed: string[] } } }`
  - `repo.listAllGpuRefKeys(db): Set<string>`（键 `subfolder/filename`，Task 4 复用）

- [ ] **Step 1: 写失败测试** — `maintenance.test.ts`：

```ts
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
    const cleanP = app
      .request('/api/maintenance/clean', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ targets: ['bak'] }),
      })
      .then((r) => {
        order.push('clean-done')
        return r
      })
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
```

注意：`createApp` 现在并不初始化 switchLock（由 hosts/backup 路由工厂惰性建）——如果锁测试里 `deps.switchLock` 为 undefined，说明初始化时机不满足，实现时把 `deps.switchLock ??= createAsyncLock()` 提到 `maintenanceRoutes` 工厂顶部（与 hosts.ts 同款），测试改为先请求一次任意 API 或直接断言工厂初始化后非空——以现有 hosts.ts 的实际模式为准。

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @cwe/server test maintenance` → FAIL（路由 404）
- [ ] **Step 3: 实现**

`repo.ts` 追加（import 处补 `isNotNull`）：

```ts
/** 全库所有 job 的 GPU 输出引用键(subfolder/filename);GPU 孤儿判定用 */
export function listAllGpuRefKeys(db: Db): Set<string> {
  const rows = db.select({ outputs: jobs.outputs }).from(jobs).where(isNotNull(jobs.outputs)).all()
  const keys = new Set<string>()
  for (const row of rows) {
    for (const out of row.outputs ?? []) {
      if (out.gpu) keys.add(`${out.gpu.subfolder}/${out.gpu.filename}`)
    }
  }
  return keys
}
```

`maintenance.ts`（本任务只含本地部分；GPU 端点 Task 4 加）：

```ts
import { readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import * as repo from '../db/repo.js'
import { createAsyncLock } from '../host-switch.js'

/** 进行中导入的 .import-* 新鲜度窗口:只删超过这个时长的残留 */
const IMPORT_FRESH_MS = 60 * 60 * 1000

const cleanSchema = z.object({
  targets: z.array(z.enum(['bak', 'thumbs', 'orphan-outputs'])).nonempty(),
})

/** 递归统计文件数与字节;路径不存在返回全零 */
function duSync(path: string): { files: number; bytes: number } {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return { files: 0, bytes: 0 }
  if (st.isFile()) return { files: 1, bytes: st.size }
  if (!st.isDirectory()) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const name of readdirSync(path)) {
    const sub = duSync(join(path, name))
    files += sub.files
    bytes += sub.bytes
  }
  return { files, bytes }
}

export function maintenanceRoutes(deps: AppDeps) {
  const app = new Hono()
  deps.switchLock ??= createAsyncLock()

  const bakEntries = () => {
    try {
      return readdirSync(deps.config.dataDir).filter(
        (n) => n.startsWith('.bak-') || n.startsWith('.import-'),
      )
    } catch {
      return []
    }
  }

  /** outputs/ 下不是现存 batch id 的目录(含非数字命名) */
  const orphanOutputDirs = () => {
    const root = join(deps.config.dataDir, 'outputs')
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      return []
    }
    return entries.filter((name) => {
      if (!statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory()) return false
      const id = Number(name)
      if (!Number.isInteger(id) || id <= 0) return true
      return repo.getBatchStatus(deps.db, id) === undefined
    })
  }

  app.get('/summary', (c) => {
    const dataDir = deps.config.dataDir
    const sum = (paths: string[]) =>
      paths.reduce(
        (acc, p) => {
          const d = duSync(p)
          return { files: acc.files + d.files, bytes: acc.bytes + d.bytes }
        },
        { files: 0, bytes: 0 },
      )
    const bak = sum(bakEntries().map((n) => join(dataDir, n)))
    const thumbs = duSync(join(dataDir, 'thumbs'))
    const orphans = sum(orphanOutputDirs().map((n) => join(dataDir, 'outputs', n)))
    return c.json({
      bak: { count: bakEntries().length, bytes: bak.bytes },
      thumbs: { count: thumbs.files, bytes: thumbs.bytes },
      orphanOutputs: { count: orphanOutputDirs().length, bytes: orphans.bytes },
    })
  })

  app.post('/clean', async (c) => {
    const { targets } = cleanSchema.parse(await c.req.json())
    const dataDir = deps.config.dataDir
    // 整体进热切换锁:绝不与导入的临时目录/热切换窗口并发
    const results = await deps.switchLock!.run(async () => {
      const out: Record<string, { freedBytes: number; failed: string[] }> = {}
      for (const target of new Set(targets)) {
        const r = { freedBytes: 0, failed: [] as string[] }
        out[target] = r
        const removeAll = async (paths: Array<{ label: string; full: string }>) => {
          for (const { label, full } of paths) {
            const size = duSync(full).bytes
            try {
              await rm(full, { recursive: true, force: true })
              r.freedBytes += size
            } catch {
              r.failed.push(label)
            }
          }
        }
        if (target === 'bak') {
          const now = Date.now()
          const entries = bakEntries().filter((n) => {
            if (!n.startsWith('.import-')) return true
            const st = statSync(join(dataDir, n), { throwIfNoEntry: false })
            // 新鲜 .import-* 可能属于进行中的导入(上传/解压段不持锁),跳过
            return st != null && now - st.mtimeMs > IMPORT_FRESH_MS
          })
          await removeAll(entries.map((n) => ({ label: n, full: join(dataDir, n) })))
        } else if (target === 'thumbs') {
          await removeAll([{ label: 'thumbs', full: join(dataDir, 'thumbs') }])
        } else {
          await removeAll(
            orphanOutputDirs().map((n) => ({ label: n, full: join(dataDir, 'outputs', n) })),
          )
        }
      }
      return out
    })
    return c.json({ results })
  })

  return app
}
```

`app.ts`：`import { maintenanceRoutes } from './routes/maintenance.js'`；在 hosts 挂载后加 `app.route('/api/maintenance', maintenanceRoutes(deps))`。

- [ ] **Step 4: 跑测试确认通过** — `pnpm --filter @cwe/server test maintenance`；全量 + typecheck
- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/server/test/maintenance.test.ts
git commit -m "feat(server): maintenance 本地统计与清理(bak/thumbs/孤儿 outputs,进切换锁)"
```

---

### Task 4: maintenance 路由——GPU 孤儿扫描与清理

**Files:**
- Modify: `apps/server/src/routes/maintenance.ts`
- Test: `apps/server/test/maintenance.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `cwePing(): number`、`cweListOutputFiles`、FakeComfy.outputFiles/cwePingVersion；Task 3 的 `repo.listAllGpuRefKeys`；`deps.comfyFactory`（PR #21 引入，AppDeps 已有）
- Produces:
  - `GET /api/maintenance/gpu-orphans?hostId=` → `{ host: { id, name }, orphans: [{ filename, subfolder, size, mtime }], totalBytes }`；404 主机不存在；503 `{ error: 'GPU 主机不可达或未安装 cwe 扩展' }`；409 `{ error: '需将 cwe 扩展升级到 v2 并重启 ComfyUI' }`
  - `POST /api/maintenance/gpu-clean` body `{ hostId, files: [{filename, subfolder}] }`（files 1..1000）→ `{ deleted, missing, failed }`

- [ ] **Step 1: 写失败测试** — `maintenance.test.ts` 追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败** — FAIL（端点 404）
- [ ] **Step 3: 实现** — `maintenance.ts` 追加（`import type { ComfyClient } from '../comfy/client.js'`、zod schema）：

```ts
const gpuCleanSchema = z.object({
  hostId: z.number().int(),
  files: z.array(z.object({ filename: z.string(), subfolder: z.string() })).min(1).max(1000),
})

type HostClient =
  | { ok: true; host: { id: number; name: string }; client: ComfyClient }
  | { ok: false; status: 404 | 503; error: string }

/** hostId 缺省=active;非 active 主机按表里 URL 经 comfyFactory 临建 client */
function resolveHostClient(deps: AppDeps, hostIdRaw: string | undefined): HostClient {
  const active = repo.getActiveHost(deps.db)
  const hostId = hostIdRaw !== undefined ? Number(hostIdRaw) : active?.id
  const host = hostId !== undefined ? repo.getHost(deps.db, hostId) : undefined
  if (!host) return { ok: false, status: 404, error: 'host 不存在' }
  const client = host.id === active?.id ? deps.comfy : (deps.comfyFactory?.(host.url) ?? null)
  if (!client) return { ok: false, status: 503, error: 'GPU 主机不可达或未安装 cwe 扩展' }
  return { ok: true, host: { id: host.id, name: host.name }, client }
}

/** cwe v2 门禁:0 → 503,1 → 409 */
async function requireCweV2(client: ComfyClient): Promise<{ status: 503 | 409; error: string } | null> {
  const version = await client.cwePing()
  if (version === 0) return { status: 503, error: 'GPU 主机不可达或未安装 cwe 扩展' }
  if (version < 2) return { status: 409, error: '需将 cwe 扩展升级到 v2 并重启 ComfyUI' }
  return null
}
```

路由（在 `return app` 前）：

```ts
  app.get('/gpu-orphans', async (c) => {
    const resolved = resolveHostClient(deps, c.req.query('hostId'))
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status)
    const gate = await requireCweV2(resolved.client)
    if (gate) return c.json({ error: gate.error }, gate.status)
    const files = await resolved.client.cweListOutputFiles()
    const refs = repo.listAllGpuRefKeys(deps.db)
    const orphans = files.filter((f) => !refs.has(`${f.subfolder}/${f.filename}`))
    return c.json({
      host: resolved.host,
      orphans,
      totalBytes: orphans.reduce((acc, f) => acc + f.size, 0),
    })
  })

  app.post('/gpu-clean', async (c) => {
    const { hostId, files } = gpuCleanSchema.parse(await c.req.json())
    const resolved = resolveHostClient(deps, String(hostId))
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status)
    const gate = await requireCweV2(resolved.client)
    if (gate) return c.json({ error: gate.error }, gate.status)
    return c.json(await resolved.client.cweDeleteOutputFiles(files))
  })
```

（`cweListOutputFiles` 抛错会走 app.onError → 500，列举失败语义可接受；v2 门禁已把常见离线场景转成 503。）

- [ ] **Step 4: 跑测试确认通过**；全量 + typecheck
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/maintenance.ts apps/server/test/maintenance.test.ts
git commit -m "feat(server): GPU 孤儿扫描(引用并集比对)与勾选清理端点"
```

---

### Task 5: thumbs 新增 comfy-output 源（GPU 孤儿预览）

**Files:**
- Modify: `apps/server/src/routes/thumbs.ts`
- Test: `apps/server/test/thumbs.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `getOutputImage`、FakeComfy.outputImages；`deps.comfyFactory`
- Produces: `GET /api/thumbs?source=comfy-output&name=<sub/file.png>&hostId=<可选,缺省 active>` —— 缓存目录 `thumbs/comfy-output/<hostId>/`；主机离线 503、文件不存在 404、越界 name 400

- [ ] **Step 1: 写失败测试** — `thumbs.test.ts` 追加：

```ts
describe('GET /api/thumbs (comfy-output 源)', () => {
  it('按主机取 output 图,缓存按主机隔离,支持子目录名', async () => {
    const repo = await import('../src/db/repo.js')
    const h1 = repo.ensureActiveHost(db, 'http://h1:8188')
    fake.outputImages['manual/x.png'] = await pngBuffer(400, 200)
    const r1 = await app.request(
      '/api/thumbs?source=comfy-output&name=' + encodeURIComponent('manual/x.png'),
      { headers: H },
    )
    expect(r1.status).toBe(200)
    expect((await meta(r1)).width).toBe(192)

    // 指定另一主机:经 comfyFactory,独立缓存
    const h2 = repo.createHost(db, { name: 'H2', url: 'http://h2:8188' })
    const remote = new FakeComfy()
    remote.outputImages['manual/x.png'] = await pngBuffer(100, 100)
    deps.comfyFactory = () => remote
    const r2 = await app.request(
      `/api/thumbs?source=comfy-output&hostId=${h2.id}&name=${encodeURIComponent('manual/x.png')}`,
      { headers: H },
    )
    expect(r2.status).toBe(200)
    expect((await meta(r2)).width).toBe(100)
    void h1
  })

  it('不存在 404;越界 name 400', async () => {
    const repo = await import('../src/db/repo.js')
    repo.ensureActiveHost(db, 'http://h1:8188')
    expect(
      (await app.request('/api/thumbs?source=comfy-output&name=nope.png', { headers: H })).status,
    ).toBe(404)
    expect(
      (
        await app.request(
          '/api/thumbs?source=comfy-output&name=' + encodeURIComponent('../escape.png'),
          { headers: H },
        )
      ).status,
    ).toBe(400)
  })
})
```

（`deps` 需要在该测试文件的 beforeEach 里保留引用——现有文件如果只保留 `app`，把 `createApp` 的入参提成模块级 `deps` 变量，与 maintenance.test.ts 同款。）

- [ ] **Step 2: 跑测试确认失败** — FAIL（source 非法 400）
- [ ] **Step 3: 实现** — `thumbs.ts`：

1. source 校验放行三值：`if (source !== 'uploads' && source !== 'comfy' && source !== 'comfy-output')`
2. 缓存目录分支（替换现有三元）：

```ts
    // comfy* 源按名缓存,而"同名"只在同一台主机内有意义——目录按主机 id 隔离;
    // uploads 内容寻址与主机无关
    let cacheDir: string
    let outputClient: ComfyClient | null = null
    let hostLabel = ''
    if (source === 'uploads') {
      cacheDir = resolve(deps.config.dataDir, 'thumbs', 'uploads')
    } else if (source === 'comfy') {
      cacheDir = resolve(deps.config.dataDir, 'thumbs', 'comfy', String(getActiveHost(deps.db)?.id ?? 0))
    } else {
      const active = getActiveHost(deps.db)
      const hostIdRaw = c.req.query('hostId')
      const hostId = hostIdRaw !== undefined ? Number(hostIdRaw) : active?.id
      const host = hostId !== undefined ? getHost(deps.db, hostId) : undefined
      if (!host) return c.json({ error: 'host 不存在' }, 404)
      outputClient = host.id === active?.id ? deps.comfy : (deps.comfyFactory?.(host.url) ?? null)
      hostLabel = String(host.id)
      cacheDir = resolve(deps.config.dataDir, 'thumbs', 'comfy-output', hostLabel)
    }
```

3. 取源分支加：

```ts
    } else if (source === 'comfy-output') {
      if (!outputClient) return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      let buf: ArrayBuffer | null
      try {
        buf = await outputClient.getOutputImage(name)
      } catch {
        return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      }
      if (!buf) return c.json({ error: '图片不存在' }, 404)
      src = Buffer.from(buf)
    } else {
```

（`import { getActiveHost, getHost } from '../db/repo.js'`、`import type { ComfyClient } from '../comfy/client.js'`；现有 `..`/绝对路径守卫对 comfy-output 同样生效，无需改。）

- [ ] **Step 4: 跑测试确认通过**；全量 + typecheck
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/thumbs.ts apps/server/test/thumbs.test.ts
git commit -m "feat(server): thumbs comfy-output 源(按主机隔离,GPU 孤儿预览用)"
```

---

### Task 6: Web 维护页

**Files:**
- Modify: `apps/web/src/lib/api.ts`（maintenance api + comfyOutputThumbUrl）
- Modify: `apps/web/src/lib/utils.ts`（formatBytes）
- Create: `apps/web/src/pages/maintenance.tsx`
- Modify: `apps/web/src/App.tsx`（nav「维护」+ 路由 `/maintenance`）

**Interfaces:**
- Consumes: Task 3/4/5 的 API 形状；`fetchHosts`/`HostDto`、`errorMessage`（已有）

- [ ] **Step 1: api.ts 追加**

```ts
export interface MaintenanceSummary {
  bak: { count: number; bytes: number }
  thumbs: { count: number; bytes: number }
  orphanOutputs: { count: number; bytes: number }
}
export interface GpuOrphan {
  filename: string
  subfolder: string
  size: number
  mtime: number
}
export type MaintenanceTarget = 'bak' | 'thumbs' | 'orphan-outputs'

export const fetchMaintenanceSummary = () => api<MaintenanceSummary>('/maintenance/summary')
export const cleanMaintenance = (targets: MaintenanceTarget[]) =>
  api<{ results: Record<string, { freedBytes: number; failed: string[] }> }>('/maintenance/clean', {
    method: 'POST',
    body: JSON.stringify({ targets }),
  })
export const fetchGpuOrphans = (hostId?: number) =>
  api<{ host: { id: number; name: string }; orphans: GpuOrphan[]; totalBytes: number }>(
    `/maintenance/gpu-orphans${hostId !== undefined ? `?hostId=${hostId}` : ''}`,
  )
export const cleanGpuOrphans = (
  hostId: number,
  files: Array<{ filename: string; subfolder: string }>,
) =>
  api<{ deleted: number; missing: number; failed: string[] }>('/maintenance/gpu-clean', {
    method: 'POST',
    body: JSON.stringify({ hostId, files }),
  })

export function comfyOutputThumbUrl(hostId: number, name: string): string {
  return `/api/thumbs?source=comfy-output&hostId=${hostId}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken())}`
}
```

- [ ] **Step 2: utils.ts 追加**

```ts
/** 字节数自适应 KB/MB/GB 展示 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
```

- [ ] **Step 3: maintenance.tsx**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  cleanGpuOrphans,
  cleanMaintenance,
  comfyOutputThumbUrl,
  errorMessage,
  fetchGpuOrphans,
  fetchHosts,
  fetchMaintenanceSummary,
  type GpuOrphan,
  type MaintenanceTarget,
} from '@/lib/api'
import { formatBytes } from '@/lib/utils'

const LOCAL_ROWS: Array<{ key: MaintenanceTarget; title: string; desc: string }> = [
  { key: 'bak', title: '导入备份残留', desc: '数据导入留下的 .bak-* 旧数据与 .import-* 临时文件' },
  { key: 'thumbs', title: '缩略图缓存', desc: '清理后浏览时按需重新生成' },
  { key: 'orphan-outputs', title: '孤儿输出目录', desc: '删除 batch 时未勾选清理而留下的输出目录' },
]

export default function MaintenancePage() {
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const [confirmTarget, setConfirmTarget] = useState<MaintenanceTarget | null>(null)
  const { data: summary } = useQuery({
    queryKey: ['maintenance-summary'],
    queryFn: fetchMaintenanceSummary,
  })
  const clean = useMutation({
    mutationFn: (t: MaintenanceTarget) => cleanMaintenance([t]),
    onSuccess: (r, t) => {
      const res = r.results[t]
      setMsg(
        `已释放 ${formatBytes(res?.freedBytes ?? 0)}${(res?.failed.length ?? 0) > 0 ? `；${res!.failed.length} 项失败` : ''}`,
      )
      void qc.invalidateQueries({ queryKey: ['maintenance-summary'] })
    },
    onError: (e) => setMsg(errorMessage(e)),
  })

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold">存储维护</h1>

      <section className="space-y-3 rounded-md border p-4">
        <p className="text-sm font-medium">本地数据目录</p>
        {LOCAL_ROWS.map((row) => {
          const s = summary?.[row.key === 'orphan-outputs' ? 'orphanOutputs' : row.key]
          return (
            <div key={row.key} className="flex items-center gap-3 text-sm">
              <div className="flex-1">
                <p>{row.title}</p>
                <p className="text-xs text-muted-foreground">{row.desc}</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {s ? `${s.count} 项 · ${formatBytes(s.bytes)}` : '…'}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={clean.isPending || !s || s.count === 0}
                onClick={() => setConfirmTarget(row.key)}
              >
                清理
              </Button>
            </div>
          )
        })}
        {msg && <p className="text-sm">{msg}</p>}
      </section>

      <GpuSection />

      <AlertDialog open={confirmTarget !== null} onOpenChange={(o) => !o && setConfirmTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              清理{LOCAL_ROWS.find((r) => r.key === confirmTarget)?.title}？
            </AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmTarget
                setConfirmTarget(null)
                if (t) clean.mutate(t)
              }}
            >
              清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function GpuSection() {
  const [hostId, setHostId] = useState<number | undefined>(undefined)
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<Awaited<ReturnType<typeof fetchGpuOrphans>> | null>(null)
  const [scanErr, setScanErr] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState('')
  const { data: hostsData } = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts })
  const hosts = hostsData?.hosts ?? []
  const effectiveHostId = hostId ?? hosts.find((h) => h.active === 1)?.id

  const key = (o: GpuOrphan) => `${o.subfolder}/${o.filename}`

  async function runScan() {
    setScanning(true)
    setScanErr('')
    setResult('')
    setPicked(new Set())
    try {
      setScan(await fetchGpuOrphans(effectiveHostId))
    } catch (e) {
      setScan(null)
      setScanErr(errorMessage(e))
    } finally {
      setScanning(false)
    }
  }

  const remove = useMutation({
    mutationFn: () =>
      cleanGpuOrphans(
        scan!.host.id,
        scan!.orphans.filter((o) => picked.has(key(o))).map((o) => ({
          filename: o.filename,
          subfolder: o.subfolder,
        })),
      ),
    onSuccess: (r) => {
      setResult(
        `已删除 ${r.deleted} 个${r.missing > 0 ? `，${r.missing} 个已不存在` : ''}${r.failed.length > 0 ? `，${r.failed.length} 个失败` : ''}`,
      )
      void runScan()
    },
    onError: (e) => setResult(errorMessage(e)),
  })

  const pickedBytes = scan?.orphans.filter((o) => picked.has(key(o))).reduce((a, o) => a + o.size, 0) ?? 0

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium">GPU 主机孤儿文件</p>
        <Select
          value={effectiveHostId !== undefined ? String(effectiveHostId) : undefined}
          onValueChange={(v) => setHostId(Number(v))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="选择主机" />
          </SelectTrigger>
          <SelectContent>
            {hosts.map((h) => (
              <SelectItem key={h.id} value={String(h.id)}>
                {h.name}
                {h.active === 1 ? '（当前）' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={scanning || effectiveHostId === undefined} onClick={() => void runScan()}>
          {scanning ? <Loader2Icon className="size-4 animate-spin" /> : '扫描'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        列出 output 目录中不被任何 batch 引用的文件。你直接在 ComfyUI 跑的图也会被列出——默认不勾选，删除前请逐项确认。
      </p>
      {scanErr && <p className="text-sm text-destructive">{scanErr}</p>}
      {result && <p className="text-sm">{result}</p>}
      {scan && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span>
              {scan.orphans.length} 个孤儿 · {formatBytes(scan.totalBytes)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={scan.orphans.length === 0}
              onClick={() =>
                setPicked(
                  picked.size === scan.orphans.length
                    ? new Set()
                    : new Set(scan.orphans.map(key)),
                )
              }
            >
              {picked.size === scan.orphans.length && scan.orphans.length > 0 ? '全不选' : '全选'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={picked.size === 0 || remove.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              删除所选（{picked.size} 项 · {formatBytes(pickedBytes)}）
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
            {scan.orphans.map((o) => {
              const k = key(o)
              const checked = picked.has(k)
              return (
                <label key={k} className="cursor-pointer space-y-1 text-xs">
                  <div className="relative">
                    <img
                      src={comfyOutputThumbUrl(scan.host.id, o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename)}
                      alt={o.filename}
                      loading="lazy"
                      className={`aspect-square w-full rounded-md border object-cover ${checked ? 'ring-2 ring-destructive' : ''}`}
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.visibility = 'hidden'
                      }}
                    />
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        const next = new Set(picked)
                        if (v) next.add(k)
                        else next.delete(k)
                        setPicked(next)
                      }}
                      className="absolute top-1 left-1 bg-background"
                    />
                  </div>
                  <p className="truncate font-mono" title={k}>
                    {o.filename}
                  </p>
                  <p className="text-muted-foreground">
                    {formatBytes(o.size)} · {new Date(o.mtime * 1000).toLocaleDateString('zh-CN')}
                  </p>
                </label>
              )
            })}
          </div>
          {scan.orphans.length === 0 && (
            <p className="text-sm text-muted-foreground">没有孤儿文件。</p>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {picked.size} 个 GPU 侧文件？</AlertDialogTitle>
            <AlertDialogDescription>
              手动跑图的产物也会被判为孤儿，请确认勾选项都是可删除的。删除后不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                remove.mutate()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
```

- [ ] **Step 4: App.tsx** — import `MaintenancePage`；nav「GPU 主机」链接后加 `<Link to="/maintenance" className="text-sm hover:underline">维护</Link>`；Routes 加 `<Route path="/maintenance" element={<MaintenancePage />} />`
- [ ] **Step 5: 验证与提交** — `pnpm typecheck` + `pnpm --filter @cwe/web build` + `pnpm test` 全量

```bash
git add apps/web/src
git commit -m "feat(web): 存储维护页(本地清理+GPU 孤儿扫描勾选删除)"
```

---

## PR 手动验收清单（放 PR 描述）

1. GPU 主机重新同步 `comfyui-cwe/` 并重启 ComfyUI 后，`curl .../cwe/ping` 返回 `"version": 2`
2. `/maintenance` 扫描列出孤儿（含缩略图预览）；勾选删除后 GPU 侧文件消失，自动重扫为空
3. 未升级扩展（v1）时 GPU 区块提示升级；主机离线提示不可达
4. 手动在 ComfyUI 跑一张图 → 扫描能看到它且默认未勾选（不误删）
5. 本地三类清理：统计数字合理，清理后归零，显示释放字节
6. 清理 thumbs 后浏览列表缩略图自动重新生成
7. 删除 batch（不勾本地清理）→ 维护页出现对应孤儿输出目录
8. 多主机：下拉切到另一台主机扫描其孤儿
