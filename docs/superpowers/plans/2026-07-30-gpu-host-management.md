# GPU 主机管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多 GPU 主机注册表 + 手动热切换 + 在线状态监测推送到 UI（spec: `docs/superpowers/specs/2026-07-30-gpu-host-management-design.md`）。

**Architecture:** `hosts` 表（单活不变量）驱动 `deps.comfy` 可替换引用；executor 复用导入热切换的 pause/resume 骨架并新增 abandon（中断）机制；`host-monitor` 周期探测经现有 SSE 推 `comfy-status`；前端用 react-query 缓存 `['comfy-status']` 做全局状态（HostStatus 常驻组件独占 SSE 订阅写入，其他页面只读缓存）。

**Tech Stack:** Hono + better-sqlite3 + drizzle（server）；React 19 + react-query + shadcn/ui（web）；vitest。

## Global Constraints

- 分支 `feat/gpu-hosts`；提交尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- server 源码 import 一律带 `.js` 后缀（ESM）
- 测试命令：`pnpm --filter @cwe/server test`（全仓 `pnpm test`）；typecheck：`pnpm typecheck`
- web 包**不写渲染测试**，手动验收清单进 PR 描述
- 不改 `pnpm-workspace.yaml`；不新增依赖
- UI 文案中文；host URL 存储前 trim 并去尾部斜杠（与 `config.ts` 的 `comfyUrl` 处理一致）
- `COMFYUI_URL` 语义变更：仅作 hosts 表为空时的首次种子，运行期以表为准
- 事件负载 `{ type: 'comfy-status', online: boolean, hostId: number | null, hostName: string | null }`——server 发送与 web 消费两侧必须一致

---

### Task 1: 数据层 — hosts 表、jobs.host_id、repo 函数

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/index.ts`
- Modify: `apps/server/src/db/repo.ts`
- Test: `apps/server/test/hosts-repo.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `Db`、drizzle 模式
- Produces（后续任务依赖的精确签名）:
  - `hosts` 表 + `export type Host`（字段 `id, name, url, note, active, createdAt`）
  - `jobs.hostId: number | null`（列 `host_id`）
  - `repo.listHosts(db): Host[]`、`repo.getHost(db, id): Host | undefined`、`repo.getActiveHost(db): Host | undefined`
  - `repo.createHost(db, { name, url, note? }): Host`
  - `repo.updateHost(db, id, { name?, url?, note? }): Host | undefined`
  - `repo.deleteHost(db, id): 'ok' | 'active'`（不存在也返回 'ok'，幂等）
  - `repo.activateHost(db, id): Host | undefined`（事务内全表清零再置 1）
  - `repo.ensureActiveHost(db, seedUrl): Host`（空表种子 / 无 active 自愈 / 正常返回）
  - `repo.claimNextJob` 认领时盖章 `host_id`
  - `repo.getBatchDetail` 返回值新增 `hostNames: Record<number, string>`（路由 `GET /api/batches/:id` 现为 `c.json({ ...detail, nav })` 直接透传，无需改路由）

- [ ] **Step 1: 写失败测试**

`apps/server/test/hosts-repo.test.ts`：

```ts
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

  it('claimNextJob 盖章当前 active host id', () => {
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
    repo.createBatch(db, t.id, { name: 'B', jobs: [{}] })
    const claimed = repo.claimNextJob(db)
    expect(claimed?.job.hostId).toBe(host.id)
  })

  it('getBatchDetail 返回 hostNames 映射', () => {
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    const t = repo.createTemplate(db, { name: 'T', comfyJson: {}, params: [] })
    const b = repo.createBatch(db, t.id, { name: 'B', jobs: [{}] })
    repo.claimNextJob(db)
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
```

注意：`createDb` 的返回值上 `$client` 是否可用取决于当前实现（数据导入功能已依赖 `deps.db.$client`，drizzle 自带），直接用。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test hosts-repo`
Expected: FAIL（`ensureActiveHost` 等函数不存在；schema 无 hosts）

- [ ] **Step 3: 实现 schema 与迁移**

`schema.ts` 追加（并在 `jobs` 表定义里加 `hostId` 一行）：

```ts
export const hosts = sqliteTable('hosts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  note: text('note'),
  active: integer('active').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})
export type Host = typeof hosts.$inferSelect
```

`jobs` 表内（`finishedAt` 之后）：

```ts
  /** 实际执行主机;认领时盖章。无 FK:主机删除后悬挂,展示层兜底 */
  hostId: integer('host_id'),
```

`db/index.ts`：DDL 里 `CREATE TABLE IF NOT EXISTS jobs` 加 `host_id INTEGER` 列；末尾追加：

```sql
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`createDb` 内、templates 迁移之后（同模式）：

```ts
  const jobCols = sqlite.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>
  if (!jobCols.some((c) => c.name === 'host_id')) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN host_id INTEGER`)
  }
```

- [ ] **Step 4: 实现 repo 函数**

`repo.ts` 新增 `// -- hosts --` 段（import 处补 `hosts, type Host`）：

```ts
// -- hosts --

export function listHosts(db: Db): Host[] {
  return db.select().from(hosts).orderBy(asc(hosts.id)).all()
}

export function getHost(db: Db, id: number): Host | undefined {
  return db.select().from(hosts).where(eq(hosts.id, id)).get()
}

export function getActiveHost(db: Db): Host | undefined {
  return db.select().from(hosts).where(eq(hosts.active, 1)).get()
}

export function createHost(
  db: Db,
  input: { name: string; url: string; note?: string | null },
): Host {
  return db.insert(hosts).values(input).returning().get()
}

export function updateHost(
  db: Db,
  id: number,
  patch: { name?: string; url?: string; note?: string | null },
): Host | undefined {
  return db.update(hosts).set(patch).where(eq(hosts.id, id)).returning().get()
}

export function deleteHost(db: Db, id: number): 'ok' | 'active' {
  return db.transaction((tx) => {
    const row = tx.select().from(hosts).where(eq(hosts.id, id)).get()
    if (!row) return 'ok'
    if (row.active === 1) return 'active'
    tx.delete(hosts).where(eq(hosts.id, id)).run()
    return 'ok'
  })
}

/** 单活不变量:事务内全表清零再置目标为 1 */
export function activateHost(db: Db, id: number): Host | undefined {
  return db.transaction((tx) => {
    const row = tx.select().from(hosts).where(eq(hosts.id, id)).get()
    if (!row) return undefined
    tx.update(hosts).set({ active: 0 }).run()
    return tx.update(hosts).set({ active: 1 }).where(eq(hosts.id, id)).returning().get()
  })
}

/** 种子与自愈:空表种默认主机;非空无 active 激活 id 最小;COMFYUI_URL 仅在此作首次种子 */
export function ensureActiveHost(db: Db, seedUrl: string): Host {
  return db.transaction((tx) => {
    const active = tx.select().from(hosts).where(eq(hosts.active, 1)).get()
    if (active) return active
    const first = tx.select().from(hosts).orderBy(asc(hosts.id)).limit(1).get()
    if (first) {
      return tx.update(hosts).set({ active: 1 }).where(eq(hosts.id, first.id)).returning().get()!
    }
    return tx.insert(hosts).values({ name: '默认主机', url: seedUrl, active: 1 }).returning().get()
  })
}
```

`claimNextJob` 的 UPDATE set 加盖章（executor 无需感知主机）：

```ts
      .set({
        status: 'running',
        startedAt: now(),
        error: null,
        hostId: sql<number | null>`(SELECT id FROM hosts WHERE active = 1)`,
      })
```

`getBatchDetail` 返回前构建映射（返回类型加 `hostNames: Record<number, string>`）：

```ts
  const hostRows = db.select({ id: hosts.id, name: hosts.name }).from(hosts).all()
  const hostNames = Object.fromEntries(hostRows.map((h) => [h.id, h.name])) as Record<
    number,
    string
  >
  return { batch, template, jobs: rows, hostNames }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test hosts-repo` → PASS；再跑 `pnpm --filter @cwe/server test` 全量不回归（`repo.test.ts` 等涉及 claimNextJob 的断言若因新字段失败，按新行为修正断言）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db apps/server/test/hosts-repo.test.ts
git commit -m "feat(server): hosts 表+单活 repo+jobs.host_id 盖章"
```

---

### Task 2: ComfyClient 扩展 + ObjectInfoCache getter 化

**Files:**
- Modify: `apps/server/src/comfy/client.ts`
- Modify: `apps/server/src/comfy/object-info-cache.ts`
- Modify: `apps/server/src/routes/comfy.ts:15`（cache 来源改 `deps.objectInfo`）
- Modify: `apps/server/src/app.ts`（AppDeps 加 `objectInfo?`，createApp 内兜底构造）
- Modify: `apps/server/test/fake-comfy.ts`
- Test: `apps/server/test/object-info-cache.test.ts`（改造现有）

**Interfaces:**
- Produces:
  - `ComfyClient.getSystemStats(): Promise<SystemStats>`，`export interface SystemStats { system?: { os?: string; comfyui_version?: string; python_version?: string }; devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }> }`
  - `ComfyClient.getQueueCounts(): Promise<{ running: number; pending: number }>`
  - `ObjectInfoCache` 构造签名 `new ObjectInfoCache(getComfy: () => ComfyClient | null, ttlMs?)`，新增 `invalidate(): void`
  - `AppDeps.objectInfo?: ObjectInfoCache`（createApp 内 `deps.objectInfo ??= new ObjectInfoCache(() => deps.comfy)`，deps 为共享对象，index.ts/backup.ts 均可经 deps 访问）
  - `FakeComfy` 新增字段：`systemStats: SystemStats`（默认 `{ system: { os: 'linux', comfyui_version: '0.3.0', python_version: '3.12' }, devices: [{ name: 'FakeGPU', vram_total: 8 * 1024 ** 3, vram_free: 4 * 1024 ** 3 }] }`）、`queueCounts = { running: 0, pending: 0 }`、`interrupts = 0`（`interrupt()` 自增）

- [ ] **Step 1: 写失败测试** — 改造 `object-info-cache.test.ts`：构造处全部改为 `new ObjectInfoCache(() => fake)`；新增用例：

```ts
  it('invalidate 后重新拉取;切换 getter 目标后拉到新主机数据', async () => {
    const a = new FakeComfy()
    a.objectInfo = { NodeA: {} }
    const b = new FakeComfy()
    b.objectInfo = { NodeB: {} }
    let current: FakeComfy = a
    const cache = new ObjectInfoCache(() => current)
    expect(await cache.get()).toHaveProperty('NodeA')
    current = b
    cache.invalidate()
    expect(await cache.get()).toHaveProperty('NodeB')
    expect(a.objectInfoCalls).toBe(1)
  })

  it('invalidate 作废进行中的拉取结果(旧主机数据不落缓存)', async () => {
    const a = new FakeComfy()
    a.objectInfo = { NodeA: {} }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = { ...a, getObjectInfo: async () => { await gate; return a.objectInfo } } as FakeComfy
    let current: FakeComfy = slow
    const cache = new ObjectInfoCache(() => current)
    const p = cache.get()
    const b = new FakeComfy()
    b.objectInfo = { NodeB: {} }
    current = b
    cache.invalidate()
    release()
    await p
    expect(await cache.get()).toHaveProperty('NodeB')
  })
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @cwe/server test object-info-cache` → FAIL（构造签名不符/无 invalidate）

- [ ] **Step 3: 实现**

`object-info-cache.ts` 整体替换为：

```ts
import type { ComfyClient, ObjectInfoMap } from './client.js'

/** /object_info 内存缓存:convert / validate / input-options 共用,默认 5 分钟 TTL。
 * 经 getter 取 client:主机热切换后自动指向新 client;世代计数防止切换瞬间
 * 进行中的旧主机拉取结果污染缓存。 */
export class ObjectInfoCache {
  private data: ObjectInfoMap | null = null
  private fetchedAt = 0
  private inflight: Promise<ObjectInfoMap> | null = null
  private gen = 0

  constructor(
    private getComfy: () => ComfyClient | null,
    private ttlMs = 5 * 60_000,
  ) {}

  invalidate(): void {
    this.data = null
    this.fetchedAt = 0
    this.inflight = null
    this.gen++
  }

  async get(refresh = false): Promise<ObjectInfoMap> {
    const comfy = this.getComfy()
    if (!comfy) throw new Error('ComfyUI 未配置')
    if (!refresh && this.data && Date.now() - this.fetchedAt < this.ttlMs) return this.data
    if (!this.inflight) {
      const g = this.gen
      this.inflight = comfy
        .getObjectInfo()
        .then((fresh) => {
          if (g === this.gen) {
            this.data = fresh
            this.fetchedAt = Date.now()
          }
          return fresh
        })
        .finally(() => {
          if (g === this.gen) this.inflight = null
        })
    }
    return this.inflight
  }
}
```

`client.ts`：接口加两个方法声明 + `SystemStats` 导出；实现：

```ts
    async getSystemStats() {
      const res = await fetch(`${http}/system_stats`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`system_stats failed: ${res.status}`)
      return (await res.json()) as SystemStats
    },

    async getQueueCounts() {
      const res = await fetch(`${http}/queue`)
      if (!res.ok) throw new Error(`queue failed: ${res.status}`)
      const body = (await res.json()) as {
        queue_running: unknown[]
        queue_pending: unknown[]
      }
      return { running: body.queue_running?.length ?? 0, pending: body.queue_pending?.length ?? 0 }
    },
```

`app.ts`：`AppDeps` 加 `objectInfo?: ObjectInfoCache`（import type 该类）与 executor 签名预改（Task 3 用到）：`executor?: { pause(opts?: { abandon?: boolean }): Promise<void>; resume(db: Db, comfy?: ComfyClient): void } | null`。`createApp` 首行后加：

```ts
  deps.objectInfo ??= new ObjectInfoCache(() => deps.comfy)
```

`routes/comfy.ts:15` 改为 `const cache = deps.objectInfo ?? null`，`objectInfo()` 辅助函数首行改 `if (!cache || !deps.comfy) return null`。

`fake-comfy.ts`：按 Interfaces 节补 `systemStats`/`queueCounts`/`interrupts` 字段与 `getSystemStats()`/`getQueueCounts()` 实现，`interrupt()` 改为 `async interrupt() { this.interrupts++ }`。

- [ ] **Step 4: 跑测试确认通过** — `pnpm --filter @cwe/server test` 全量 + `pnpm typecheck`（接口新增方法会让 FakeComfy 缺实现直接暴露）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/comfy apps/server/src/app.ts apps/server/src/routes/comfy.ts apps/server/test/fake-comfy.ts apps/server/test/object-info-cache.test.ts
git commit -m "feat(server): ComfyClient system_stats/queue 计数+ObjectInfoCache getter 化可失效"
```

---

### Task 3: Executor 热切换（abandon + resume 换 client）

**Files:**
- Modify: `apps/server/src/executor.ts`
- Test: `apps/server/test/executor.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 FakeComfy.interrupts
- Produces:
  - `Executor.pause(opts?: { abandon?: boolean }): Promise<void>`——abandon 时对旧主机 interrupt（失败吞掉）、当前 job 重置回 pending
  - `Executor.resume(db: Db, comfy?: ComfyClient): void`——传 comfy 时替换连接（gpuUploads 照旧清空）
  - 内部 `AbandonError`；`waitForHistory` 每轮检查 abandon 标志

- [ ] **Step 1: 写失败测试** — `executor.test.ts` 追加（复用现有 `seed`/`makeExecutor` 辅助；`FakeComfy.historyDelayPolls = 1e9` 可把 job 钉在轮询中）：

```ts
  it('pause({abandon}) 中断当前 job 重置回 pending,batch 保持 running', async () => {
    const b = seed()
    comfy.historyDelayPolls = 1e9
    const ex = makeExecutor()
    ex.start()
    await vi.waitFor(() => {
      expect(repo.listRunningJobs(db)).toHaveLength(1)
    })
    await ex.pause({ abandon: true })
    expect(comfy.interrupts).toBe(1)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]!.status).toBe('pending')
    expect(detail.batch.status).toBe('running')
  })

  it('resume 换 client 后任务在新 comfy 上执行,gpuUploads 清空', async () => {
    seed()
    comfy.historyDelayPolls = 1e9
    const ex = makeExecutor()
    ex.start()
    await vi.waitFor(() => expect(repo.listRunningJobs(db)).toHaveLength(1))
    await ex.pause({ abandon: true })
    const next = new FakeComfy()
    ex.resume(db, next)
    await vi.waitFor(() => expect(next.submitted).toHaveLength(1))
    ex.stop()
    await ex.pause()
    expect(comfy.submitted).toHaveLength(1) // 旧 client 没有二次提交
  })

  it('abandon 时旧主机 interrupt 抛错不阻断切换', async () => {
    seed()
    comfy.historyDelayPolls = 1e9
    comfy.interrupt = async () => {
      throw new Error('host dead')
    }
    const ex = makeExecutor()
    ex.start()
    await vi.waitFor(() => expect(repo.listRunningJobs(db)).toHaveLength(1))
    await ex.pause({ abandon: true })
    expect(repo.listRunningJobs(db)).toHaveLength(0)
  })
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @cwe/server test executor` → FAIL（pause 不收参/类型错）

- [ ] **Step 3: 实现**

`executor.ts`：

1. `private readonly comfy` → `private comfy`；新增 `private abandonRequested = false`
2. 文件顶部（class 外）：

```ts
/** 主机切换的中断模式:放弃当前 job(重置回 pending 而非 failed) */
class AbandonError extends Error {}
```

3. `pause`/`resume` 替换为：

```ts
  /** 停下并等当前任务/轮询收尾(导入热切换与主机切换共用)。
   * abandon:放弃当前 job——对旧主机发 interrupt(失败吞掉,主机可能已死),
   * waitForHistory 察觉标志后抛 AbandonError,job 重置回 pending 由新主机重跑 */
  async pause(opts?: { abandon?: boolean }): Promise<void> {
    if (opts?.abandon) {
      this.abandonRequested = true
      await this.comfy.interrupt().catch(() => {})
    }
    this.stop()
    await this.loopPromise
    this.loopPromise = null
    this.abandonRequested = false
  }

  /** 换库/换主机后重启;GPU 上传映射清空,靠 overwrite 幂等重传 */
  resume(db: Db, comfy?: ComfyClient): void {
    this.db = db
    if (comfy) this.comfy = comfy
    this.gpuUploads.clear()
    this.start()
  }
```

4. `waitForHistory` 的 `for (;;) {` 后第一行加：

```ts
      if (this.abandonRequested) throw new AbandonError('主机切换,放弃当前任务')
```

5. `runPendingOnce` 的 catch 分支改为：

```ts
    } catch (err) {
      if (err instanceof AbandonError) {
        repo.resetJobToPending(this.db, job.id)
        this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'pending' })
      } else {
        repo.failJob(this.db, job.id, err instanceof Error ? err.message : String(err))
        const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'failed'
        this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: finalStatus })
      }
    } finally {
```

已知边界（不处理，行为可接受）：abandon 标志只在 `waitForHistory` 检查——若切换瞬间 job 正在上传/下载文件，则该 job 正常走完或在下一轮询点被放弃；离线退避睡眠中最长约 30s 后才察觉标志（与现有 pause 行为一致）。

- [ ] **Step 4: 跑测试确认通过** — `pnpm --filter @cwe/server test executor`；全量 + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/executor.ts apps/server/test/executor.test.ts
git commit -m "feat(server): executor 支持 abandon 中断与 resume 换 comfy client"
```

---

### Task 4: host-monitor + /api/health 扩展

**Files:**
- Create: `apps/server/src/host-monitor.ts`
- Modify: `apps/server/src/app.ts:38-40`（health 响应加 host）
- Test: `apps/server/test/host-monitor.test.ts`（新建；health 断言并入其中）

**Interfaces:**
- Consumes: `repo.getActiveHost`（Task 1）
- Produces:
  - `startHostMonitor(deps: Pick<AppDeps, 'db' | 'comfy' | 'events'>, intervalMs = 5000): () => void`（返回停止函数）
  - 事件 `{ type: 'comfy-status', online, hostId, hostName }`（仅状态翻转时发；经现有 `deps.events` → SSE 广播，events 路由无需改动）
  - `GET /api/health` → `{ ok: true, comfy: boolean, host: { id, name } | null }`

- [ ] **Step 1: 写失败测试**

```ts
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { startHostMonitor } from '../src/host-monitor.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
beforeEach(() => {
  db = createDb(':memory:')
})

describe('host monitor', () => {
  it('状态翻转才发 comfy-status,稳定态不发', async () => {
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    const comfy = new FakeComfy()
    const events = new EventEmitter()
    const seen: any[] = []
    events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const stop = startHostMonitor({ db, comfy, events }, 5)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ online: true, hostId: host.id, hostName: host.name })
    await new Promise((r) => setTimeout(r, 30)) // 多个周期稳定在线,不重复发
    expect(seen).toHaveLength(1)
    comfy.up = false
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toMatchObject({ online: false })
    stop()
  })

  it('comfy 为 null 视为离线', async () => {
    const events = new EventEmitter()
    const seen: any[] = []
    events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const stop = startHostMonitor({ db, comfy: null, events }, 5)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].online).toBe(false)
    stop()
  })
})

describe('health host 字段', () => {
  it('返回 active host 摘要;无 hosts 时为 null', async () => {
    const app = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db,
      comfy: null,
      events: new EventEmitter(),
    })
    const H = { Authorization: 'Bearer secret' }
    let body = await (await app.request('/api/health', { headers: H })).json() as any
    expect(body.host).toBeNull()
    const host = repo.ensureActiveHost(db, 'http://a:8188')
    body = await (await app.request('/api/health', { headers: H })).json() as any
    expect(body.host).toEqual({ id: host.id, name: host.name })
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @cwe/server test host-monitor` → FAIL

- [ ] **Step 3: 实现**

`host-monitor.ts`：

```ts
import type { AppDeps } from './app.js'
import { getActiveHost } from './db/repo.js'

/** 周期探测当前主机在线状态,翻转时经 deps.events 广播 comfy-status(SSE 透传)。
 * 与 executor 的离线退避探测并存:双份轻量 isUp 可接受。 */
export function startHostMonitor(
  deps: Pick<AppDeps, 'db' | 'comfy' | 'events'>,
  intervalMs = 5000,
): () => void {
  let last: boolean | null = null
  let probing = false
  const tick = async () => {
    if (probing) return
    probing = true
    try {
      const online = deps.comfy ? await deps.comfy.isUp() : false
      if (online !== last) {
        last = online
        const host = getActiveHost(deps.db)
        deps.events.emit('event', {
          type: 'comfy-status',
          online,
          hostId: host?.id ?? null,
          hostName: host?.name ?? null,
        })
      }
    } finally {
      probing = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return () => clearInterval(timer)
}
```

（注意 `deps.db`/`deps.comfy` 在 monitor 内每次 tick 现取——导入/切换替换引用后自动生效，所以参数必须传共享 deps 对象而非解构值。）

`app.ts` health 路由改为：

```ts
  app.get('/api/health', async (c) => {
    const host = getActiveHost(deps.db)
    return c.json({
      ok: true,
      comfy: deps.comfy ? await deps.comfy.isUp() : false,
      host: host ? { id: host.id, name: host.name } : null,
    })
  })
```

（`import { getActiveHost } from './db/repo.js'`）

- [ ] **Step 4: 跑测试确认通过**；全量 + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/host-monitor.ts apps/server/src/app.ts apps/server/test/host-monitor.test.ts
git commit -m "feat(server): host-monitor 状态翻转推送+health 带当前主机"
```

---

### Task 5: hosts 路由 + bootstrap/导入联动

**Files:**
- Create: `apps/server/src/routes/hosts.ts`
- Modify: `apps/server/src/app.ts`（挂载 `app.route('/api/hosts', hostRoutes(deps))`，放在 comfy 路由挂载之前）
- Modify: `apps/server/src/index.ts`（bootstrap 用 active host；启动 monitor）
- Modify: `apps/server/src/routes/backup.ts:87-98`（reopen 段联动）
- Test: `apps/server/test/hosts.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1-4 全部产出
- Produces（web 依赖的 API 形状）:
  - `GET /api/hosts` → `{ hosts: Host[] }`
  - `POST /api/hosts` body `{ name, url, note? }` → 201 `{ host }`；url 必须 `^https?://`，trim+去尾斜杠
  - `PATCH /api/hosts/:id` → `{ host }`；改 active 主机 URL 触发重连（pause → 换 client → invalidate → resume → 发 comfy-status）
  - `DELETE /api/hosts/:id` → `{ ok: true }`；active → 409 `{ error: '当前主机不可删除' }`
  - `POST /api/hosts/:id/activate` body `{ mode: 'wait' | 'interrupt' }` → `{ host }`；已 active 幂等
  - `POST /api/hosts/:id/test` → `{ reachable, latencyMs?, cwe?, gpuName?, vramTotalMB? }`
  - `GET /api/hosts/current/stats` → `{ online: false }` 或 `{ online: true, gpuName, vramTotalMB, vramFreeMB, comfyuiVersion, pythonVersion, os, queueRunning, queuePending, cwe }`

- [ ] **Step 1: 写失败测试** — `apps/server/test/hosts.test.ts`（沿用 prompts.test.ts 的 app.request 模式；executor 用记录调用序的 fake）：

```ts
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
let deps: AppDeps
let app: ReturnType<typeof createApp>
let calls: string[]
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  db = createDb(':memory:')
  calls = []
  deps = {
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db,
    comfy: new FakeComfy(),
    events: new EventEmitter(),
    executor: {
      pause: async (opts?: { abandon?: boolean }) => {
        calls.push(opts?.abandon ? 'pause-abandon' : 'pause')
      },
      resume: () => calls.push('resume'),
    },
  }
  app = createApp(deps)
})

const j = (method: string, path: string, body?: unknown) =>
  app.request(`/api/hosts${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('hosts CRUD', () => {
  it('创建:url 去尾斜杠;非 http 前缀 400', async () => {
    const res = await j('POST', '', { name: 'A', url: 'http://a:8188//' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).host.url).toBe('http://a:8188')
    expect((await j('POST', '', { name: 'B', url: 'a:8188' })).status).toBe(400)
  })

  it('删 active 409;删普通 ok', async () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    expect((await j('DELETE', `/${a.id}`)).status).toBe(409)
    expect((await j('DELETE', `/${b.id}`)).status).toBe(200)
  })
})

describe('activate', () => {
  it('wait 模式:pause→表切换→resume 顺序;发 comfy-status 事件', async () => {
    repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await j('POST', `/${b.id}/activate`, { mode: 'wait' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['pause', 'resume'])
    expect(repo.getActiveHost(db)?.id).toBe(b.id)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ hostId: b.id, hostName: 'B' })
  })

  it('interrupt 模式走 pause({abandon});已 active 幂等不 pause', async () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    await j('POST', `/${b.id}/activate`, { mode: 'interrupt' })
    expect(calls).toEqual(['pause-abandon', 'resume'])
    calls.length = 0
    await j('POST', `/${b.id}/activate`, { mode: 'wait' })
    expect(calls).toEqual([])
    expect((await j('POST', '/9999/activate', { mode: 'wait' })).status).toBe(404)
    void a
  })
})

describe('PATCH', () => {
  it('改 active 主机 URL 触发重连;改名不触发', async () => {
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    await j('PATCH', `/${a.id}`, { name: 'A2' })
    expect(calls).toEqual([])
    await j('PATCH', `/${a.id}`, { url: 'http://a2:8188' })
    expect(calls).toEqual(['pause', 'resume'])
    expect(repo.getHost(db, a.id)?.url).toBe('http://a2:8188')
  })
})

describe('current/stats', () => {
  it('在线返回摘要;fake 断网返回 online:false', async () => {
    repo.ensureActiveHost(db, 'http://a:8188')
    const res = await app.request('/api/hosts/current/stats', { headers: H })
    const body = (await res.json()) as any
    expect(body.online).toBe(true)
    expect(body.gpuName).toBe('FakeGPU')
    expect(body.vramTotalMB).toBe(8192)
    expect(body.cwe).toBe(true)
    ;(deps.comfy as FakeComfy).getSystemStats = async () => {
      throw new Error('down')
    }
    const res2 = await app.request('/api/hosts/current/stats', { headers: H })
    expect(((await res2.json()) as any).online).toBe(false)
  })
})
```

（`/:id/test` 端点对条目 URL 临建真实 client 发网络请求，单测不覆盖 reachable:true 分支，只测 404 与不可达：加一条 `expect(((await j('POST', '/9999/test')).status)).toBe(404)`；不可达分支给 host 配 `http://127.0.0.1:1` 断言 `reachable: false`，3s 超时内返回。）

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @cwe/server test hosts` → FAIL（路由不存在 404）

- [ ] **Step 3: 实现 routes/hosts.ts**

```ts
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { createComfyClient } from '../comfy/client.js'
import * as repo from '../db/repo.js'

const urlSchema = z
  .string()
  .trim()
  .regex(/^https?:\/\//, 'URL 需以 http(s):// 开头')
  .transform((u) => u.replace(/\/+$/, ''))
const createSchema = z.object({
  name: z.string().trim().min(1),
  url: urlSchema,
  note: z.string().nullish(),
})
const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  url: urlSchema.optional(),
  note: z.string().nullish(),
})
const activateSchema = z.object({ mode: z.enum(['wait', 'interrupt']) })

export function hostRoutes(deps: AppDeps) {
  const app = new Hono()

  /** 表已切换后重建连接:换 client、失效节点缓存、重启 executor、广播状态 */
  async function reconnect(host: { id: number; name: string; url: string }): Promise<void> {
    const client = createComfyClient(host.url)
    deps.comfy = client
    deps.objectInfo?.invalidate()
    deps.executor?.resume(deps.db, client)
    const online = await client.isUp()
    deps.events.emit('event', {
      type: 'comfy-status',
      online,
      hostId: host.id,
      hostName: host.name,
    })
  }

  app.get('/', (c) => c.json({ hosts: repo.listHosts(deps.db) }))

  app.post('/', async (c) => {
    const input = createSchema.parse(await c.req.json())
    return c.json({ host: repo.createHost(deps.db, input) }, 201)
  })

  app.get('/current/stats', async (c) => {
    if (!deps.comfy) return c.json({ online: false })
    try {
      const [stats, queue, cwe] = await Promise.all([
        deps.comfy.getSystemStats(),
        deps.comfy.getQueueCounts(),
        deps.comfy.cwePing(),
      ])
      const dev = stats.devices?.[0]
      const mb = (n: number | undefined) => (n != null ? Math.round(n / 1048576) : null)
      return c.json({
        online: true,
        gpuName: dev?.name ?? null,
        vramTotalMB: mb(dev?.vram_total),
        vramFreeMB: mb(dev?.vram_free),
        comfyuiVersion: stats.system?.comfyui_version ?? null,
        pythonVersion: stats.system?.python_version ?? null,
        os: stats.system?.os ?? null,
        queueRunning: queue.running,
        queuePending: queue.pending,
        cwe,
      })
    } catch {
      return c.json({ online: false })
    }
  })

  app.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const patch = patchSchema.parse(await c.req.json())
    const before = repo.getHost(deps.db, id)
    if (!before) return c.json({ error: 'host 不存在' }, 404)
    const urlChanged = patch.url !== undefined && patch.url !== before.url
    // 改 active 主机的 URL = 租用 pod 换地址:等待模式重连
    if (before.active === 1 && urlChanged) await deps.executor?.pause()
    const host = repo.updateHost(deps.db, id, patch)!
    if (before.active === 1 && urlChanged) await reconnect(host)
    return c.json({ host })
  })

  app.delete('/:id', async (c) => {
    const result = repo.deleteHost(deps.db, Number(c.req.param('id')))
    if (result === 'active') return c.json({ error: '当前主机不可删除' }, 409)
    return c.json({ ok: true })
  })

  app.post('/:id/activate', async (c) => {
    const id = Number(c.req.param('id'))
    const { mode } = activateSchema.parse(await c.req.json())
    const target = repo.getHost(deps.db, id)
    if (!target) return c.json({ error: 'host 不存在' }, 404)
    if (target.active === 1) return c.json({ host: target })
    // 先 pause 再切表:否则等待期间 executor 可能认领新 job 并盖上新主机的章
    await deps.executor?.pause(mode === 'interrupt' ? { abandon: true } : undefined)
    const host = repo.activateHost(deps.db, id)!
    await reconnect(host)
    return c.json({ host })
  })

  app.post('/:id/test', async (c) => {
    const host = repo.getHost(deps.db, Number(c.req.param('id')))
    if (!host) return c.json({ error: 'host 不存在' }, 404)
    const probe = createComfyClient(host.url)
    const t0 = Date.now()
    try {
      const stats = await probe.getSystemStats()
      const latencyMs = Date.now() - t0
      const cwe = await probe.cwePing()
      const dev = stats.devices?.[0]
      return c.json({
        reachable: true,
        latencyMs,
        cwe,
        gpuName: dev?.name ?? null,
        vramTotalMB: dev?.vram_total != null ? Math.round(dev.vram_total / 1048576) : null,
      })
    } catch {
      return c.json({ reachable: false })
    }
  })

  return app
}
```

（路由注册顺序：`GET /current/stats` 必须在 `PATCH/DELETE /:id` 之前定义以免被参数路由吞掉——按上面顺序写即可。）

`app.ts`：`import { hostRoutes } from './routes/hosts.js'`，在 `app.route('/api/comfy', ...)` 前加 `app.route('/api/hosts', hostRoutes(deps))`。

`index.ts`：

```ts
const db = createDb(join(config.dataDir, 'db.sqlite'))
const activeHost = ensureActiveHost(db, config.comfyUrl)
const events = new EventEmitter()
const comfy = createComfyClient(activeHost.url)
// deps 对象与 app/executor/monitor 共享:热切换靠替换 deps.db / deps.comfy
const deps = { config, db, comfy, events, executor: null as Executor | null }
const app = createApp(deps)
```

executor 创建后追加 `startHostMonitor(deps)`；启动日志改为 `→ ${activeHost.name} (${activeHost.url})`。import 补 `ensureActiveHost`（from `./db/repo.js`）与 `startHostMonitor`（from `./host-monitor.js`）。

`backup.ts` reopen 段（`deps.db = reopened` 与 `deps.executor?.resume(...)` 之间）改为：

```ts
          const reopened = createDb(join(dataDir, 'db.sqlite'))
          deps.db = reopened
          // 导入的库自带 hosts 表(或旧版库由 ensureActiveHost 补种),按其 active 主机重建连接
          const activeHost = ensureActiveHost(reopened, deps.config.comfyUrl)
          const client = createComfyClient(activeHost.url)
          deps.comfy = client
          deps.objectInfo?.invalidate()
          deps.executor?.resume(reopened, client)
```

import 补 `createComfyClient`、`ensureActiveHost`。在 `backup.test.ts` 追加一条：导入含 hosts 表且 active 指向 `http://imported:8188` 的库后，`repo.getActiveHost(deps.db)?.url === 'http://imported:8188'`（构造导入 zip 时用 `createDb` 建临时库并 `ensureActiveHost(tmpDb, 'http://imported:8188')`）。

- [ ] **Step 4: 跑测试确认通过** — `pnpm --filter @cwe/server test`（全量）+ `pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/server/test
git commit -m "feat(server): hosts CRUD/切换/测试/详情卡路由+bootstrap 与导入联动"
```

---

### Task 6: Web 基础 — api 函数、状态 hook、Header 指示灯

**Files:**
- Modify: `apps/web/src/lib/api.ts`（追加类型与函数）
- Create: `apps/web/src/hooks/use-comfy-status.ts`
- Create: `apps/web/src/components/host-status.tsx`
- Modify: `apps/web/src/App.tsx`（nav 链接 + HostStatus + `/hosts` 路由占位到 Task 7 一起挂）

**Interfaces:**
- Consumes: Task 5 API 形状
- Produces:
  - `api.ts`: `HostDto`、`HostTestResult`、`HostStatsDto`、`HealthDto` 类型 + `fetchHosts/createHost/updateHost/deleteHost/activateHost/testHost/fetchHostStats/fetchHealth`
  - `useComfyStatus(): ComfyStatus | undefined`（`{ online, hostId, hostName }`，读 react-query 缓存 `['comfy-status']`）
  - `useComfyStatusFeed(): void`（仅 HostStatus 挂载一次：SSE `comfy-status` → setQueryData）
  - `<HostStatus />`：状态点 + 主机名，点击去 `/hosts`

- [ ] **Step 1: api.ts 追加**

```ts
export interface HostDto {
  id: number
  name: string
  url: string
  note: string | null
  active: number
  createdAt: string
}
export interface HostTestResult {
  reachable: boolean
  latencyMs?: number
  cwe?: boolean
  gpuName?: string | null
  vramTotalMB?: number | null
}
export interface HostStatsDto {
  online: boolean
  gpuName?: string | null
  vramTotalMB?: number | null
  vramFreeMB?: number | null
  comfyuiVersion?: string | null
  pythonVersion?: string | null
  os?: string | null
  queueRunning?: number
  queuePending?: number
  cwe?: boolean
}
export interface HealthDto {
  ok: boolean
  comfy: boolean
  host: { id: number; name: string } | null
}

export const fetchHosts = () => api<{ hosts: HostDto[] }>('/hosts')
export const createHost = (input: { name: string; url: string; note?: string }) =>
  api<{ host: HostDto }>('/hosts', { method: 'POST', body: JSON.stringify(input) })
export const updateHost = (id: number, patch: { name?: string; url?: string; note?: string }) =>
  api<{ host: HostDto }>(`/hosts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteHost = (id: number) => api<{ ok: true }>(`/hosts/${id}`, { method: 'DELETE' })
export const activateHost = (id: number, mode: 'wait' | 'interrupt') =>
  api<{ host: HostDto }>(`/hosts/${id}/activate`, { method: 'POST', body: JSON.stringify({ mode }) })
export const testHost = (id: number) =>
  api<HostTestResult>(`/hosts/${id}/test`, { method: 'POST', body: JSON.stringify({}) })
export const fetchHostStats = () => api<HostStatsDto>('/hosts/current/stats')
export const fetchHealth = () => api<HealthDto>('/health')
```

- [ ] **Step 2: use-comfy-status.ts**

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { fetchHealth, getToken } from '@/lib/api'

export interface ComfyStatus {
  online: boolean
  hostId: number | null
  hostName: string | null
}

/** 全局在线状态:读共享查询缓存;初始来自 /health,SSE 翻转由 useComfyStatusFeed 写入 */
export function useComfyStatus(): ComfyStatus | undefined {
  const { data } = useQuery({
    queryKey: ['comfy-status'],
    queryFn: async (): Promise<ComfyStatus> => {
      const h = await fetchHealth()
      return { online: h.comfy, hostId: h.host?.id ?? null, hostName: h.host?.name ?? null }
    },
    staleTime: Infinity,
    refetchInterval: 60_000, // SSE 断线兜底
  })
  return data
}

/** 只在常驻组件(HostStatus)挂一次:独占一条 SSE,把 comfy-status 写入查询缓存供全站读 */
export function useComfyStatusFeed(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)
    es.addEventListener('comfy-status', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as {
        online: boolean
        hostId: number | null
        hostName: string | null
      }
      qc.setQueryData<ComfyStatus>(['comfy-status'], {
        online: d.online,
        hostId: d.hostId,
        hostName: d.hostName,
      })
    })
    es.onerror = () => console.warn('SSE connection error — browser will retry')
    return () => es.close()
  }, [qc])
}
```

- [ ] **Step 3: host-status.tsx**

```tsx
import { Link } from 'react-router-dom'
import { useComfyStatus, useComfyStatusFeed } from '@/hooks/use-comfy-status'
import { cn } from '@/lib/utils'

/** Header 常驻:在线状态点+当前主机名,点击进主机管理页 */
export function HostStatus() {
  useComfyStatusFeed()
  const status = useComfyStatus()
  const color =
    status == null ? 'bg-muted-foreground' : status.online ? 'bg-green-500' : 'bg-red-500'
  const title = status == null ? '探测中' : status.online ? '在线' : '离线'
  return (
    <Link
      to="/hosts"
      className="ml-auto flex items-center gap-2 text-sm hover:underline"
      title={`GPU 主机:${title}`}
    >
      <span className={cn('inline-block size-2.5 rounded-full', color)} />
      <span className="text-muted-foreground">{status?.hostName ?? 'GPU 主机'}</span>
    </Link>
  )
}
```

- [ ] **Step 4: App.tsx 接入** — nav 内「数据备份」链接后加 `<HostStatus />`（import from `@/components/host-status`）。（`/hosts` 路由与导航文字链接在 Task 7 页面就绪时一起挂，避免 404 中间态。）

- [ ] **Step 5: 验证与提交** — `pnpm --filter @cwe/web test`（现有 18 个不回归）+ `pnpm typecheck`；`pnpm --filter @cwe/web build` 过。

```bash
git add apps/web/src
git commit -m "feat(web): comfy-status 全局状态 hook+Header 主机指示灯"
```

---

### Task 7: Web /hosts 管理页

**Files:**
- Create: `apps/web/src/pages/hosts.tsx`
- Modify: `apps/web/src/App.tsx`（路由 `/hosts` + nav 链接「GPU 主机」）

**Interfaces:**
- Consumes: Task 6 的 api 函数与 `useComfyStatus`；`@/pages/batches` 导出的 `BatchSummaryDto`
- Produces: 页面 `/hosts`

- [ ] **Step 1: 实现页面** — `pages/hosts.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Loader2Icon } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useComfyStatus } from '@/hooks/use-comfy-status'
import {
  activateHost,
  api,
  createHost,
  deleteHost,
  fetchHostStats,
  fetchHosts,
  testHost,
  updateHost,
  type HostDto,
  type HostTestResult,
} from '@/lib/api'
import type { BatchSummaryDto } from '@/pages/batches'

function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return '操作失败'
  try {
    return (JSON.parse(e.message) as { error?: string }).error ?? e.message
  } catch {
    return e.message
  }
}

export default function HostsPage() {
  const qc = useQueryClient()
  const status = useComfyStatus()
  const { data } = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts })
  const { data: stats } = useQuery({
    queryKey: ['host-stats'],
    queryFn: fetchHostStats,
    refetchInterval: 10_000,
  })
  const { data: batches = [] } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })
  const hasRunning = batches.some((b) => b.status === 'running')

  const [msg, setMsg] = useState('')
  const [editing, setEditing] = useState<HostDto | null>(null)
  const [creating, setCreating] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<HostDto | null>(null)
  const [testResults, setTestResults] = useState<Record<number, HostTestResult | 'testing'>>({})

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['hosts'] })
    void qc.invalidateQueries({ queryKey: ['host-stats'] })
    void qc.invalidateQueries({ queryKey: ['comfy-status'] })
  }
  const onError = (e: unknown) => setMsg(errMsg(e))

  const create = useMutation({
    mutationFn: (input: { name: string; url: string; note?: string }) => createHost(input),
    onSuccess: () => {
      setCreating(false)
      invalidate()
    },
    onError,
  })
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: number; name?: string; url?: string; note?: string }) =>
      updateHost(id, patch),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
    onError,
  })
  const remove = useMutation({ mutationFn: deleteHost, onSuccess: invalidate, onError })
  const activate = useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: 'wait' | 'interrupt' }) => activateHost(id, mode),
    onSuccess: () => {
      setMsg('已切换')
      invalidate()
    },
    onError,
  })

  async function runTest(id: number) {
    setTestResults((prev) => ({ ...prev, [id]: 'testing' }))
    try {
      const r = await testHost(id)
      setTestResults((prev) => ({ ...prev, [id]: r }))
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: { reachable: false } }))
    }
  }

  function requestSwitch(host: HostDto) {
    if (hasRunning) setSwitchTarget(host)
    else activate.mutate({ id: host.id, mode: 'wait' })
  }

  const hosts = data?.hosts ?? []
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold">GPU 主机</h1>

      <section className="space-y-2 rounded-md border p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          当前主机
          <Badge variant={status?.online ? 'default' : 'destructive'}>
            {status == null ? '探测中' : status.online ? '在线' : '离线'}
          </Badge>
        </p>
        {stats?.online ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">GPU</dt><dd>{stats.gpuName ?? '—'}</dd></div>
            <div>
              <dt className="text-muted-foreground">显存</dt>
              <dd>{stats.vramFreeMB != null ? `${stats.vramFreeMB} MB 空闲 / ` : ''}{stats.vramTotalMB ?? '—'} MB</dd>
            </div>
            <div><dt className="text-muted-foreground">ComfyUI</dt><dd>{stats.comfyuiVersion ?? '—'}</dd></div>
            <div><dt className="text-muted-foreground">Python</dt><dd>{stats.pythonVersion ?? '—'}</dd></div>
            <div><dt className="text-muted-foreground">队列</dt><dd>{stats.queueRunning} 运行 / {stats.queuePending} 排队</dd></div>
            <div><dt className="text-muted-foreground">cwe 扩展</dt><dd>{stats.cwe ? '已安装' : '未安装'}</dd></div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">主机离线或不可达，无法获取详情。</p>
        )}
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">主机列表</p>
          <Button size="sm" onClick={() => setCreating(true)}>新增主机</Button>
        </div>
        <div className="space-y-2">
          {hosts.map((h) => {
            const t = testResults[h.id]
            return (
              <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span className="font-medium">{h.name}</span>
                {h.active === 1 && <Badge>当前</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{h.url}</span>
                {h.note && <span className="text-xs text-muted-foreground">{h.note}</span>}
                <span className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="outline" disabled={t === 'testing'} onClick={() => void runTest(h.id)}>
                    {t === 'testing' ? <Loader2Icon className="size-4 animate-spin" /> : '测试'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(h)}>编辑</Button>
                  <Button size="sm" variant="outline" disabled={h.active === 1} onClick={() => remove.mutate(h.id)}>删除</Button>
                  <Button size="sm" disabled={h.active === 1 || activate.isPending} onClick={() => requestSwitch(h)}>切换</Button>
                </span>
                {t && t !== 'testing' && (
                  <p className="w-full text-xs text-muted-foreground">
                    {t.reachable
                      ? `可达 ${t.latencyMs}ms · ${t.gpuName ?? '未知 GPU'} · ${t.vramTotalMB ?? '?'} MB · cwe ${t.cwe ? '已装' : '未装'}`
                      : '不可达'}
                  </p>
                )}
              </div>
            )
          })}
          {hosts.length === 0 && <p className="text-sm text-muted-foreground">暂无主机</p>}
        </div>
      </section>

      {msg && <p className="text-sm">{msg}</p>}

      {activate.isPending && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
          <Loader2Icon className="size-8 animate-spin" />
          <p className="text-sm font-medium">正在切换主机……</p>
          <p className="text-sm text-muted-foreground">等待模式下会先等当前任务收尾，可能需要几分钟</p>
        </div>
      )}

      <HostForm
        open={creating}
        title="新增主机"
        pending={create.isPending}
        onSubmit={(v) => create.mutate(v)}
        onClose={() => setCreating(false)}
      />
      <HostForm
        open={editing !== null}
        title={`编辑 ${editing?.name ?? ''}`}
        initial={editing ?? undefined}
        pending={update.isPending}
        onSubmit={(v) => editing && update.mutate({ id: editing.id, ...v })}
        onClose={() => setEditing(null)}
      />

      <AlertDialog open={switchTarget !== null} onOpenChange={(o) => !o && setSwitchTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>切换到 {switchTarget?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              有任务正在运行。「等它跑完」会先等当前任务收尾（可能几分钟）；「立即中断」会打断当前任务并将其重新排队到新主机。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                const h = switchTarget
                setSwitchTarget(null)
                if (h) activate.mutate({ id: h.id, mode: 'wait' })
              }}
            >
              等它跑完
            </Button>
            <AlertDialogAction
              onClick={() => {
                const h = switchTarget
                setSwitchTarget(null)
                if (h) activate.mutate({ id: h.id, mode: 'interrupt' })
              }}
            >
              立即中断
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function HostForm({
  open,
  title,
  initial,
  pending,
  onSubmit,
  onClose,
}: {
  open: boolean
  title: string
  initial?: { name: string; url: string; note: string | null }
  pending: boolean
  onSubmit: (v: { name: string; url: string; note?: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  // Dialog 每次打开时同步初始值
  const [seeded, setSeeded] = useState(false)
  if (open && !seeded) {
    setName(initial?.name ?? '')
    setUrl(initial?.url ?? '')
    setNote(initial?.note ?? '')
    setSeeded(true)
  }
  if (!open && seeded) setSeeded(false)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="host-name">名称</Label>
            <Input id="host-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如:本机 4090" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="host-url">URL</Label>
            <Input id="host-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:8188" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="host-note">备注（可选）</Label>
            <Input id="host-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如:RunPod 按小时" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={pending || !name.trim() || !url.trim()}
            onClick={() => onSubmit({ name: name.trim(), url: url.trim(), note: note.trim() || undefined })}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: App.tsx 挂路由** — import `HostsPage`；nav 「数据备份」后加 `<Link to="/hosts" className="text-sm hover:underline">GPU 主机</Link>`；Routes 内加 `<Route path="/hosts" element={<HostsPage />} />`。

- [ ] **Step 3: 验证与提交** — `pnpm typecheck` + `pnpm --filter @cwe/web build`。

```bash
git add apps/web/src
git commit -m "feat(web): GPU 主机管理页(列表/CRUD/连通测试/切换弹窗/详情卡)"
```

---

### Task 8: Web 离线横幅 + batch 详情主机名

**Files:**
- Create: `apps/web/src/components/offline-banner.tsx`
- Modify: `apps/web/src/pages/batches.tsx`（列表页顶部挂横幅）
- Modify: `apps/web/src/pages/batch-detail.tsx`（横幅 + jobs 表「主机」列 + DTO 扩展）

**Interfaces:**
- Consumes: `useComfyStatus`（Task 6）；服务端 detail 响应的 `hostNames`（Task 1 透传）
- Produces: `<OfflineBanner hasActiveWork={boolean} />`；`JobDto.hostId: number | null`；`BatchDetailDto.hostNames: Record<number, string>`

- [ ] **Step 1: offline-banner.tsx**

```tsx
import { useComfyStatus } from '@/hooks/use-comfy-status'

/** 主机离线且页面存在未完成任务时的提示横幅(executor 本就离线等待,这里只是可视化) */
export function OfflineBanner({ hasActiveWork }: { hasActiveWork: boolean }) {
  const status = useComfyStatus()
  if (!status || status.online || !hasActiveWork) return null
  return (
    <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 px-4 py-2 text-sm">
      GPU 主机离线，任务将在主机恢复后自动继续。
    </div>
  )
}
```

- [ ] **Step 2: batches.tsx 接入** — 页面根 div（列表渲染区上方）加：

```tsx
      <OfflineBanner hasActiveWork={batches.some((b) => b.status === 'running' || b.status === 'pending')} />
```

（`batches` 即现有 `useQuery` 的列表数据变量。）

- [ ] **Step 3: batch-detail.tsx 接入**

1. `JobDto` 加 `hostId: number | null`；`BatchDetailDto` 加 `hostNames: Record<number, string>`
2. 头部区块（`<div className="flex items-center justify-between">`）之后加 `<OfflineBanner hasActiveWork={['pending', 'running'].includes(batch.status)} />`
3. jobs 表：`<TableHead>状态</TableHead>` 后加 `<TableHead>主机</TableHead>`；对应行内状态单元格后加：

```tsx
              <TableCell className="text-xs text-muted-foreground">
                {j.hostId != null ? (data.hostNames[j.hostId] ?? '已删除主机') : '—'}
              </TableCell>
```

- [ ] **Step 4: 验证与提交** — `pnpm typecheck` + `pnpm --filter @cwe/web build` + `pnpm test` 全量（237+ 全绿）。

```bash
git add apps/web/src
git commit -m "feat(web): 离线横幅+batch 详情执行主机列"
```

---

## PR 手动验收清单（放 PR 描述）

1. Header 指示灯：正常绿；停掉 ComfyUI ≤5s 变红；恢复变绿
2. 离线时 batches/详情页出现横幅（有 running/pending 任务时），恢复后消失
3. `/hosts` 详情卡显示 GPU 型号/显存/版本/队列/cwe 状态
4. 新增主机 → 测试按钮显示延迟与 GPU 信息；错 URL 显示不可达
5. 空闲时切换主机：无弹窗直接切，Header 主机名更新
6. 运行中切换（等待模式）：当前 job 跑完产出落地后切换，剩余 job 在新主机继续
7. 运行中切换（中断模式）：当前 job 回到排队，立即切到新主机重跑
8. 改 active 主机 URL（模拟租用换地址）：连接迁移，任务继续
9. 删除非 active 主机成功；删 active 被拒
10. 导出 → 导入后主机列表与当前主机保持
11. batch 详情能看到各 job 的执行主机
