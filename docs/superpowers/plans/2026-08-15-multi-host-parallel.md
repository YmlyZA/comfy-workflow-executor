# 多主机并行调度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有「参与调度」的 GPU 主机同时执行任务，把执行器从单循环单任务改造成每主机一个 worker。

**Architecture:** 保留现有 `Executor` 类，从单例改为「每台启用主机一个实例」，各自持有自己的 comfy client、clientId、gpuUploads 与循环；新增 `ExecutorPool` 只负责生命周期（按 hosts 表增删 worker、熔断停机、数据导入时全停全起）。`hosts.active` 从「唯一干活的主机」退位为「参考主机」（只服务节点/模型/文件列表查询）。

**Tech Stack:** TypeScript、Hono、better-sqlite3 + drizzle、vitest（node 环境）、React 19 + TanStack Query。

**Spec:** `docs/superpowers/specs/2026-08-15-multi-host-parallel-scheduling-design.md`

## Global Constraints

- **`claimNextJob` 必须保持同步、不得引入 `await`**。并行认领的原子性依赖「better-sqlite3 同步事务 + Node 单线程 = 事务即临界区」；一旦函数体内出现 await，两个 worker 的认领就会交错，重复派发立刻出现。此约束必须写进代码注释。
- **不新增任何依赖**（`package.json` 不得改动依赖项）。
- **不修改 `pnpm-workspace.yaml`**。
- **web 包不写渲染测试**：需要覆盖的逻辑抽成 `apps/web/src/lib/` 下的纯函数，配 node 环境 vitest 单测。
- **Tailwind 任意值里的空格必须写成下划线**：`calc(5rem_+_env(...))`。缺下划线会生成静默失效的非法 CSS。
- 注释与提交信息用中文，与现有代码风格一致。
- 提交信息结尾附 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- 常量取值：连续失败熔断阈值 `FAILURE_STREAK_LIMIT = 3`；主机不可达放弃阈值 `UNREACHABLE_ABANDON_MS = 120_000`（2 分钟）；租用主机空闲提醒阈值 `IDLE_NOTIFY_MS = 300_000`（5 分钟）。
- 时间相关逻辑一律经注入的 `now: () => number`（默认 `Date.now`），测试用假时钟推进，**不得真等**。

## File Structure

**服务端**

| 文件 | 责任 |
|---|---|
| `apps/server/src/db/schema.ts` | 加 hosts 5 列、batches 的 `pinned_host_id` |
| `apps/server/src/db/index.ts` | DDL 与幂等迁移（`PRAGMA table_info` 探测 + `ALTER TABLE`） |
| `apps/server/src/db/repo.ts` | `claimNextJob(db, hostId)`、孤儿回收、主机启停、锁定批次计数 |
| `apps/server/src/executor.ts` | 单主机 worker：认领、执行、熔断计数上报、空闲上报、不可达超时放弃 |
| `apps/server/src/executor-pool.ts` | **新建**：worker 生命周期、熔断落库、全停全起 |
| `apps/server/src/host-monitor.ts` | 探测全部主机、维护在线缓存、逐台广播 |
| `apps/server/src/host-switch.ts` | `reconnectComfy` 收窄为只换参考主机 client |
| `apps/server/src/routes/hosts.ts` | 启停端点、activate 简化、按 id 取 stats、列表附带 online |
| `apps/server/src/routes/templates.ts` | 建批时检测 GPU 文件引用并锁定主机 |
| `apps/server/src/app.ts` / `index.ts` | `AppDeps.executor` 换成 pool；接线 |

**前端**

| 文件 | 责任 |
|---|---|
| `apps/web/src/lib/hosts.ts` | **新建**：在线状态派生量、租用时长/费用（纯函数，可单测） |
| `apps/web/src/hooks/use-comfy-status.ts` | 单对象 → 按 hostId 映射 |
| `apps/web/src/components/host-status.tsx` | 头部指示灯改聚合显示 |
| `apps/web/src/components/offline-banner.tsx` | 「主机离线」→「无可用主机」 |
| `apps/web/src/pages/hosts.tsx` | 形态表单、参与调度、停用双模式、每主机 stats |
| `apps/web/src/pages/batch-detail.tsx` | 锁定主机不可用 / 无启用主机提示 |
| `apps/web/src/pages/batch-new.tsx` | 锁定提示 |

---

### Task 1: 数据模型与迁移

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/index.ts`
- Modify: `apps/server/src/db/repo.ts`（`createHost` / `updateHost`）
- Test: `apps/server/test/db-migration.test.ts`（新建）

**Interfaces:**
- Produces:
  - `hosts` 表新增列 `enabled: number`（0/1，默认 1）、`kind: 'resident' | 'rental'`（默认 `'resident'`）、`rentedAt: string | null`、`hourlyRate: number | null`、`disabledReason: string | null`
  - `batches` 表新增列 `pinnedHostId: number | null`
  - `createHost(db, input: { name: string; url: string; note?: string | null; kind?: 'resident' | 'rental'; rentedAt?: string | null; hourlyRate?: number | null }): Host`
  - `updateHost(db, id: number, patch: { name?: string; url?: string; note?: string | null; kind?: 'resident' | 'rental'; rentedAt?: string | null; hourlyRate?: number | null }): Host | undefined`

- [ ] **Step 1: 写失败测试**

新建 `apps/server/test/db-migration.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- db-migration`
Expected: FAIL —— `host.enabled` 为 `undefined`（列不存在）。

- [ ] **Step 3: 加 schema 列**

`apps/server/src/db/schema.ts`，`batches` 表加一列：

```ts
export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  templateId: integer('template_id').notNull(),
  name: text('name').notNull(),
  status: text('status').$type<'pending' | 'running' | 'completed' | 'canceled'>().notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /** 非空时该批次只在此主机执行:引用了 GPU 侧已有文件,换主机必失败 */
  pinnedHostId: integer('pinned_host_id'),
})
```

`hosts` 表整体替换为：

```ts
export const hosts = sqliteTable('hosts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  note: text('note'),
  /** 参考主机:只服务节点/模型/GPU 文件列表查询,不再决定谁干活 */
  active: integer('active').notNull().default(0),
  /** 参与调度:为 1 才会起 worker */
  enabled: integer('enabled').notNull().default(1),
  kind: text('kind').$type<'resident' | 'rental'>().notNull().default('resident'),
  rentedAt: text('rented_at'),
  hourlyRate: real('hourly_rate'),
  /** 自动停用原因(熔断写入);手动启用时清空 */
  disabledReason: text('disabled_reason'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})
```

同文件顶部导入加 `real`：

```ts
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
```

- [ ] **Step 4: 加 DDL 与迁移**

`apps/server/src/db/index.ts`，DDL 里 `hosts` 与 `batches` 两段替换为：

```sql
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  pinned_host_id INTEGER
);
```

```sql
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'resident',
  rented_at TEXT,
  hourly_rate REAL,
  disabled_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`createDb` 里现有两段迁移之后追加（沿用既有「探测列名 → ALTER」风格）：

```ts
  // 旧库迁移:多主机并行调度新增列
  const hostCols = sqlite.prepare(`PRAGMA table_info(hosts)`).all() as Array<{ name: string }>
  const hasHostCol = (n: string) => hostCols.some((c) => c.name === n)
  if (!hasHostCol('enabled')) {
    sqlite.exec(`ALTER TABLE hosts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`)
  }
  if (!hasHostCol('kind')) {
    sqlite.exec(`ALTER TABLE hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'resident'`)
  }
  if (!hasHostCol('rented_at')) sqlite.exec(`ALTER TABLE hosts ADD COLUMN rented_at TEXT`)
  if (!hasHostCol('hourly_rate')) sqlite.exec(`ALTER TABLE hosts ADD COLUMN hourly_rate REAL`)
  if (!hasHostCol('disabled_reason')) {
    sqlite.exec(`ALTER TABLE hosts ADD COLUMN disabled_reason TEXT`)
  }
  const batchCols = sqlite.prepare(`PRAGMA table_info(batches)`).all() as Array<{ name: string }>
  if (!batchCols.some((c) => c.name === 'pinned_host_id')) {
    sqlite.exec(`ALTER TABLE batches ADD COLUMN pinned_host_id INTEGER`)
  }
```

- [ ] **Step 5: 扩展 createHost / updateHost**

`apps/server/src/db/repo.ts`，两个函数替换为：

```ts
export interface HostWritable {
  name: string
  url: string
  note?: string | null
  kind?: 'resident' | 'rental'
  rentedAt?: string | null
  hourlyRate?: number | null
}

export function createHost(db: Db, input: HostWritable): Host {
  return db.insert(hosts).values(input).returning().get()
}

export function updateHost(
  db: Db,
  id: number,
  patch: Partial<HostWritable>,
): Host | undefined {
  return db.update(hosts).set(patch).where(eq(hosts.id, id)).returning().get()
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- db-migration`
Expected: PASS（4 个测试）

Run: `pnpm -r test && pnpm -r typecheck`
Expected: 全部通过（既有 249 个服务端测试不受影响）

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/db apps/server/test/db-migration.test.ts
git commit -m "$(cat <<'EOF'
feat(server): hosts/batches 加多主机调度所需列与幂等迁移

hosts +enabled/kind/rented_at/hourly_rate/disabled_reason,batches
+pinned_host_id。存量主机默认 enabled=1、kind=resident,升级后行为不变。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 按主机认领与孤儿回收

**Files:**
- Modify: `apps/server/src/db/repo.ts`
- Test: `apps/server/test/claim-parallel.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `hosts.enabled`、`batches.pinnedHostId`
- Produces:
  - `claimNextJob(db: Db, hostId: number): { job: Job; template: Template } | undefined`（**签名变更**，原先无 hostId）
  - `resetJobToPending(db: Db, jobId: number): void`（行为变更：同时清空 `hostId`）
  - `listRunningJobsByHost(db: Db, hostId: number): Job[]`
  - `reclaimOrphanJobs(db: Db, liveHostIds: number[]): number`（返回被重置的条数）
  - `listEnabledHosts(db: Db): Host[]`
  - `setHostEnabled(db: Db, id: number, enabled: boolean, reason?: string | null): Host | undefined`
  - `countPinnedUnfinishedBatches(db: Db, hostId: number): number`

- [ ] **Step 1: 写失败测试**

新建 `apps/server/test/claim-parallel.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

const TEMPLATE = {
  name: 't',
  comfyJson: { '1': { class_type: 'X', inputs: {} } },
  params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
}

function setup() {
  const db = createDb(':memory:')
  const tpl = repo.createTemplate(db, TEMPLATE)
  const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
  const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
  return { db, tpl, a, b }
}

describe('claimNextJob 按主机认领', () => {
  it('两台主机各领一个,不重不漏', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const first = repo.claimNextJob(db, a.id)
    const second = repo.claimNextJob(db, b.id)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.job.id).not.toBe(second!.job.id)
    expect(first!.job.hostId).toBe(a.id)
    expect(second!.job.hostId).toBe(b.id)
    expect(repo.claimNextJob(db, a.id)).toBeUndefined()
  })

  it('锁定批次只被指定主机认领', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'pinned', jobs: [{ p: 1 }] }, b.id)
    expect(repo.claimNextJob(db, a.id)).toBeUndefined()
    const claimed = repo.claimNextJob(db, b.id)
    expect(claimed?.job.hostId).toBe(b.id)
  })

  it('锁定批次不挡住后面的非锁定批次', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'pinned', jobs: [{ p: 1 }] }, b.id)
    repo.createBatch(db, tpl.id, { name: 'free', jobs: [{ p: 2 }] })
    // A 跳过锁定给 B 的批次,直接取后面那个
    const claimed = repo.claimNextJob(db, a.id)
    expect(claimed?.job.params).toEqual({ p: 2 })
  })
})

describe('resetJobToPending', () => {
  it('回池时清空 host_id(pending 任务不该声称属于某台主机)', () => {
    const { db, tpl, a } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    const claimed = repo.claimNextJob(db, a.id)!
    repo.resetJobToPending(db, claimed.job.id)
    const after = repo.getJob(db, claimed.job.id)!
    expect(after.status).toBe('pending')
    expect(after.hostId).toBeNull()
    expect(after.comfyPromptId).toBeNull()
  })
})

describe('reclaimOrphanJobs', () => {
  it('重置无主的 running job,保留活跃主机的', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const onA = repo.claimNextJob(db, a.id)!
    const onB = repo.claimNextJob(db, b.id)!
    const n = repo.reclaimOrphanJobs(db, [a.id]) // 只有 A 还活着
    expect(n).toBe(1)
    expect(repo.getJob(db, onB.job.id)!.status).toBe('pending')
    expect(repo.getJob(db, onA.job.id)!.status).toBe('running')
  })

  it('host_id 为 NULL 的历史 running job 也回收', () => {
    const { db, tpl, a } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    const claimed = repo.claimNextJob(db, a.id)!
    // 模拟历史数据:running 但没盖主机章
    db.$client.prepare(`UPDATE jobs SET host_id = NULL WHERE id = ?`).run(claimed.job.id)
    expect(repo.reclaimOrphanJobs(db, [a.id])).toBe(1)
  })
})

describe('主机启停', () => {
  it('停用写入原因,启用清空原因', () => {
    const { db, a } = setup()
    repo.setHostEnabled(db, a.id, false, '连续 3 次任务失败')
    let host = repo.getHost(db, a.id)!
    expect(host.enabled).toBe(0)
    expect(host.disabledReason).toBe('连续 3 次任务失败')
    repo.setHostEnabled(db, a.id, true)
    host = repo.getHost(db, a.id)!
    expect(host.enabled).toBe(1)
    expect(host.disabledReason).toBeNull()
  })

  it('listEnabledHosts 只返回参与调度的', () => {
    const { db, a, b } = setup()
    repo.setHostEnabled(db, b.id, false, 'x')
    expect(repo.listEnabledHosts(db).map((h) => h.id)).toEqual([a.id])
  })
})

describe('countPinnedUnfinishedBatches', () => {
  it('只数未完成的锁定批次', () => {
    const { db, tpl, b } = setup()
    const open = repo.createBatch(db, tpl.id, { name: 'open', jobs: [{ p: 1 }] }, b.id)
    const done = repo.createBatch(db, tpl.id, { name: 'done', jobs: [{ p: 2 }] }, b.id)
    db.$client.prepare(`UPDATE batches SET status='completed' WHERE id = ?`).run(done.id)
    expect(repo.countPinnedUnfinishedBatches(db, b.id)).toBe(1)
    expect(open.pinnedHostId).toBe(b.id)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- claim-parallel`
Expected: FAIL —— `claimNextJob` 只接受 1 个参数、`reclaimOrphanJobs` 未定义。

- [ ] **Step 3: 改 claimNextJob**

`apps/server/src/db/repo.ts` 替换 `claimNextJob`：

```ts
/**
 * 认领下一个待执行任务并盖上主机章。
 *
 * **本函数必须保持同步、不得引入 await。** 并行认领的互斥完全依赖
 * 「better-sqlite3 同步事务 + Node 单线程 = 事务即临界区」:整段查-改-返回
 * 跑完,下一个 worker 才能开始。一旦函数体内出现 await,两个 worker 的
 * 认领事务就会交错,同一个 job 会被重复派发。
 */
export function claimNextJob(db: Db, hostId: number): { job: Job; template: Template } | undefined {
  return db.transaction((tx) => {
    const row = tx
      .select({ job: jobs, batch: batches })
      .from(jobs)
      .innerJoin(batches, eq(jobs.batchId, batches.id))
      .where(
        and(
          eq(jobs.status, 'pending'),
          inArray(batches.status, ['pending', 'running']),
          // 锁定批次只能被指定主机认领;其余主机跳过它继续取后面的活
          or(isNull(batches.pinnedHostId), eq(batches.pinnedHostId, hostId)),
        ),
      )
      .orderBy(asc(batches.id), asc(jobs.sortOrder))
      .limit(1)
      .get()
    if (!row) return undefined
    const template = tx.select().from(templates).where(eq(templates.id, row.batch.templateId)).get()
    if (!template) return undefined
    const job = tx
      .update(jobs)
      .set({ status: 'running', startedAt: now(), error: null, hostId })
      .where(and(eq(jobs.id, row.job.id), eq(jobs.status, 'pending')))
      .returning()
      .get()
    if (!job) return undefined
    if (row.batch.status === 'pending') {
      tx.update(batches).set({ status: 'running' }).where(eq(batches.id, row.batch.id)).run()
    }
    return { job, template }
  })
}
```

文件顶部的 drizzle 导入补 `isNull` 与 `or`：

```ts
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
```

（保留该行原有的其他导入符号，只增补 `isNull` 与 `or`。）

- [ ] **Step 4: 改 resetJobToPending，加新函数**

替换 `resetJobToPending`，并在其后追加新函数：

```ts
export function resetJobToPending(db: Db, jobId: number): void {
  // hostId 一并清空:pending 任务不属于任何主机,否则 UI「主机」列会显示上一台
  db.update(jobs)
    .set({ status: 'pending', comfyPromptId: null, startedAt: null, hostId: null })
    .where(eq(jobs.id, jobId))
    .run()
}

export function listRunningJobsByHost(db: Db, hostId: number): Job[] {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), eq(jobs.hostId, hostId)))
    .all()
}

/** 启动时回收无主的 running job:主机已删除/已停用/历史数据没盖章 */
export function reclaimOrphanJobs(db: Db, liveHostIds: number[]): number {
  return db.transaction((tx) => {
    const orphans = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'running'),
          liveHostIds.length > 0
            ? or(isNull(jobs.hostId), notInArray(jobs.hostId, liveHostIds))
            : sql`1 = 1`,
        ),
      )
      .all()
    for (const o of orphans) {
      tx.update(jobs)
        .set({ status: 'pending', comfyPromptId: null, startedAt: null, hostId: null })
        .where(eq(jobs.id, o.id))
        .run()
    }
    return orphans.length
  })
}

export function listEnabledHosts(db: Db): Host[] {
  return db.select().from(hosts).where(eq(hosts.enabled, 1)).orderBy(asc(hosts.id)).all()
}

export function setHostEnabled(
  db: Db,
  id: number,
  enabled: boolean,
  reason?: string | null,
): Host | undefined {
  return db
    .update(hosts)
    // 启用即清空停用原因;停用可带原因(熔断)或不带(手动)
    .set({ enabled: enabled ? 1 : 0, disabledReason: enabled ? null : (reason ?? null) })
    .where(eq(hosts.id, id))
    .returning()
    .get()
}

/** 锁定到该主机、且尚未结束的批次数(删除主机时给用户的警告) */
export function countPinnedUnfinishedBatches(db: Db, hostId: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(and(eq(batches.pinnedHostId, hostId), inArray(batches.status, ['pending', 'running'])))
      .get()?.n ?? 0
  )
}
```

drizzle 导入再补 `notInArray`：

```ts
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
```

- [ ] **Step 5: createBatch 支持锁定主机**

替换 `createBatch`：

```ts
export function createBatch(
  db: Db,
  templateId: number,
  input: CreateBatchInput,
  pinnedHostId?: number | null,
): Batch {
  return db.transaction((tx) => {
    const batch = tx
      .insert(batches)
      .values({ templateId, name: input.name, pinnedHostId: pinnedHostId ?? null })
      .returning()
      .get()
    tx.insert(jobs)
      .values(input.jobs.map((params, i) => ({ batchId: batch.id, sortOrder: i, params })))
      .run()
    return batch
  })
}
```

- [ ] **Step 6: 修既有调用点**

`claimNextJob` 签名变了，唯一的生产调用点在 `apps/server/src/executor.ts:123`。本任务先让它编译通过（Task 3 会正式改造）：把该行改为

```ts
    const claimed = repo.claimNextJob(this.db, this.hostId)
```

并在 `Executor` 类中临时加字段与构造赋值：

```ts
  private readonly hostId: number
```

```ts
    this.hostId = deps.hostId
```

`ExecutorDeps` 接口加 `hostId: number`。既有测试构造 `Executor` 的地方补 `hostId: 1`——用 `pnpm --filter @cwe/server typecheck` 找出全部报错点逐个补齐。

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- claim-parallel`
Expected: PASS（9 个测试）

Run: `pnpm -r test && pnpm -r typecheck`
Expected: 全部通过

- [ ] **Step 8: 提交**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): claimNextJob 按主机认领,加孤儿回收与主机启停

claimNextJob(db, hostId) 显式盖主机章并过滤锁定批次(锁定批次不挡住后面的
非锁定批次);resetJobToPending 一并清空 host_id;新增 reclaimOrphanJobs /
listEnabledHosts / setHostEnabled / countPinnedUnfinishedBatches。
认领的原子性依赖同步事务,已在注释中固定为约束。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Executor 改造为单主机 worker

**Files:**
- Modify: `apps/server/src/executor.ts`
- Test: `apps/server/test/executor-worker.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `claimNextJob(db, hostId)`、`listRunningJobsByHost`、`resetJobToPending`
- Produces:
  - `ExecutorDeps` 增加 `hostId: number`、`hostName: string`、`hostKind: 'resident' | 'rental'`、`onFailureStreak?: (hostId: number) => void`、`onIdle?: (hostId: number, idleMs: number) => void`、`now?: () => number`、`unreachableAbandonMs?: number`、`idleNotifyMs?: number`
  - 导出常量 `FAILURE_STREAK_LIMIT = 3`、`UNREACHABLE_ABANDON_MS = 120_000`、`IDLE_NOTIFY_MS = 300_000`
  - `Executor.hostId: number`（只读公开，供 pool 索引）

- [ ] **Step 1: 写失败测试**

新建 `apps/server/test/executor-worker.test.ts`。测试用现有 `FakeComfy`（见 `apps/server/test/fake-comfy.ts`，若既有测试用的是别的路径/名字，沿用之）：

```ts
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { Executor, FAILURE_STREAK_LIMIT } from '../src/executor.js'
import { FakeComfy } from './fake-comfy.js'

const TEMPLATE = {
  name: 't',
  comfyJson: { '1': { class_type: 'X', inputs: {} } },
  params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cwe-worker-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(over: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  const db = createDb(':memory:')
  const tpl = repo.createTemplate(db, TEMPLATE)
  const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
  const comfy = new FakeComfy()
  const events = new EventEmitter()
  const ex = new Executor({
    db,
    comfy,
    events,
    dataDir: dir,
    pollMs: 1,
    hostId: host.id,
    hostName: host.name,
    hostKind: 'resident',
    ...over,
  })
  return { db, tpl, host, comfy, events, ex }
}

/** FakeComfy 靠 nextResult 决定下一次 submit 的结果:error 状态即任务失败 */
const ERROR_RESULT = { status: { completed: false, status_str: 'error', messages: ['boom'] } }
const OK_RESULT = {
  status: { completed: true },
  outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
}

describe('worker 盖章', () => {
  it('认领的任务盖上本 worker 的主机章', async () => {
    const { db, tpl, host, ex } = setup()
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    await ex.runPendingOnce()
    const job = repo.getBatchDetail(db, batch.id)!.jobs[0]!
    expect(job.hostId).toBe(host.id)
  })
})

describe('熔断计数', () => {
  it('连续 3 次失败上报一次', async () => {
    const onFailureStreak = vi.fn()
    const { db, tpl, comfy, ex, host } = setup({ onFailureStreak })
    comfy.nextResult = ERROR_RESULT
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }, { p: 3 }] })
    await ex.runPendingOnce()
    await ex.runPendingOnce()
    expect(onFailureStreak).not.toHaveBeenCalled()
    await ex.runPendingOnce()
    expect(onFailureStreak).toHaveBeenCalledTimes(1)
    expect(onFailureStreak).toHaveBeenCalledWith(host.id)
  })

  it('中间成功一次即清零', async () => {
    const onFailureStreak = vi.fn()
    const { db, tpl, comfy, ex } = setup({ onFailureStreak })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }] })
    comfy.nextResult = ERROR_RESULT
    await ex.runPendingOnce()
    await ex.runPendingOnce()
    comfy.nextResult = OK_RESULT
    await ex.runPendingOnce() // 成功 → 清零
    comfy.nextResult = ERROR_RESULT
    await ex.runPendingOnce()
    expect(onFailureStreak).not.toHaveBeenCalled()
    expect(FAILURE_STREAK_LIMIT).toBe(3)
  })
})

describe('recover 按主机隔离', () => {
  it('只收割自己主机的 running job', async () => {
    const { db, tpl, host, ex } = setup()
    const other = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const mine = repo.claimNextJob(db, host.id)!
    const theirs = repo.claimNextJob(db, other.id)!
    await ex.recover()
    expect(repo.getJob(db, mine.job.id)!.status).toBe('pending')
    // B 的任务不被 A 碰
    expect(repo.getJob(db, theirs.job.id)!.status).toBe('running')
  })
})

describe('主机不可达超时', () => {
  it('连续不可达达阈值 → 任务回池且 host_id 置空(不计入熔断)', async () => {
    const onFailureStreak = vi.fn()
    let clock = 0
    const { db, tpl, comfy, ex } = setup({
      onFailureStreak,
      now: () => clock,
      unreachableAbandonMs: 1000,
    })
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    // submit 成功后让 getHistory 一直抛错(主机掉线),并在轮询期间推进假时钟
    comfy.getHistory = async () => {
      clock += 400
      throw new Error('ECONNREFUSED')
    }
    await ex.runPendingOnce()
    const job = repo.getBatchDetail(db, batch.id)!.jobs[0]!
    expect(job.status).toBe('pending')
    expect(job.hostId).toBeNull()
    // 不可达不是主机「坏」,不该把健康主机熔断掉
    expect(onFailureStreak).not.toHaveBeenCalled()
  })

  it('未达阈值时继续等待,不放弃任务', async () => {
    let clock = 0
    let calls = 0
    const { db, tpl, comfy, ex } = setup({ now: () => clock, unreachableAbandonMs: 10_000 })
    const batch = repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    comfy.getHistory = async () => {
      calls++
      clock += 100
      if (calls >= 5) {
        // 主机恢复:返回完成结果,任务应正常成功而非被放弃
        return { status: { completed: true }, outputs: {} }
      }
      throw new Error('ECONNREFUSED')
    }
    await ex.runPendingOnce()
    expect(repo.getBatchDetail(db, batch.id)!.jobs[0]!.status).toBe('succeeded')
  })
})

describe('空闲上报', () => {
  it('租用主机空转达阈值上报一次,认领后清零', async () => {
    const onIdle = vi.fn()
    let clock = 0
    const { db, tpl, ex } = setup({
      hostKind: 'rental',
      onIdle,
      now: () => clock,
      idleNotifyMs: 1000,
    })
    await ex.runPendingOnce() // 无活可领 → 开始计时
    clock = 999
    await ex.runPendingOnce()
    expect(onIdle).not.toHaveBeenCalled()
    clock = 1000
    await ex.runPendingOnce()
    expect(onIdle).toHaveBeenCalledTimes(1)
    // 同一次空闲不重复提醒
    clock = 5000
    await ex.runPendingOnce()
    expect(onIdle).toHaveBeenCalledTimes(1)
    // 有活干过之后重新计时
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    await ex.runPendingOnce()
    clock = 10_000
    await ex.runPendingOnce()
    clock = 11_000
    await ex.runPendingOnce()
    expect(onIdle).toHaveBeenCalledTimes(2)
  })

  it('常驻主机不上报空闲', async () => {
    const onIdle = vi.fn()
    let clock = 0
    const { ex } = setup({ hostKind: 'resident', onIdle, now: () => clock, idleNotifyMs: 1000 })
    await ex.runPendingOnce()
    clock = 99_999
    await ex.runPendingOnce()
    expect(onIdle).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- executor-worker`
Expected: FAIL —— `FAILURE_STREAK_LIMIT` 未导出、`onFailureStreak` 不是合法参数。

- [ ] **Step 3: 扩展 ExecutorDeps 与常量**

`apps/server/src/executor.ts` 顶部常量区替换：

```ts
/** 已停机(pause 等待中)时,getHistory 连续失败多少轮就判定主机已死并放弃当前 job */
const UNREACHABLE_ABANDON_POLLS = 3
/** 运行中的 worker:主机连续不可达超过此时长即放弃当前 job,让它回池由别的主机接手 */
export const UNREACHABLE_ABANDON_MS = 120_000
/** 连续多少个任务失败判定主机坏掉 */
export const FAILURE_STREAK_LIMIT = 3
/** 租用主机空转多久提醒一次 */
export const IDLE_NOTIFY_MS = 300_000

export interface ExecutorDeps {
  db: Db
  comfy: ComfyClient
  events: EventEmitter
  dataDir: string
  pollMs?: number
  hostId: number
  hostName: string
  hostKind: 'resident' | 'rental'
  /** 连续失败达 FAILURE_STREAK_LIMIT 时回调一次。worker 只上报,停机由 pool 决定 */
  onFailureStreak?: (hostId: number) => void
  /** 租用主机空转达阈值时回调一次 */
  onIdle?: (hostId: number, idleMs: number) => void
  now?: () => number
  unreachableAbandonMs?: number
  idleNotifyMs?: number
}
```

- [ ] **Step 4: 加字段与构造赋值**

`Executor` 类字段区补充（`hostId` 若在 Task 2 已临时加入，替换为下面这版）：

```ts
  readonly hostId: number
  private readonly hostName: string
  private readonly hostKind: 'resident' | 'rental'
  private readonly onFailureStreak?: (hostId: number) => void
  private readonly onIdle?: (hostId: number, idleMs: number) => void
  private readonly now: () => number
  private readonly unreachableAbandonMs: number
  private readonly idleNotifyMs: number
  /** 连续失败计数;成功一次清零。内存态,worker 重启即归零 */
  private failureStreak = 0
  /** 本轮空闲的起点(毫秒);null = 当前不处于空闲 */
  private idleSince: number | null = null
  /** 本轮空闲是否已提醒过,防止每轮重复 toast */
  private idleNotified = false
```

构造函数末尾补：

```ts
    this.hostId = deps.hostId
    this.hostName = deps.hostName
    this.hostKind = deps.hostKind
    this.onFailureStreak = deps.onFailureStreak
    this.onIdle = deps.onIdle
    this.now = deps.now ?? Date.now
    this.unreachableAbandonMs = deps.unreachableAbandonMs ?? UNREACHABLE_ABANDON_MS
    this.idleNotifyMs = deps.idleNotifyMs ?? IDLE_NOTIFY_MS
```

- [ ] **Step 5: 改 runPendingOnce（熔断计数 + 空闲计时）**

替换 `runPendingOnce` 的开头与结尾：

```ts
  /** 处理一个 pending job；无任务返回 false。测试入口。 */
  async runPendingOnce(): Promise<boolean> {
    const claimed = repo.claimNextJob(this.db, this.hostId)
    if (!claimed) {
      this.trackIdle()
      return false
    }
    this.idleSince = null
    this.idleNotified = false
    const { job, template } = claimed
    this.currentJobId = job.id
    this.emit({
      type: 'job-updated',
      jobId: job.id,
      batchId: job.batchId,
      status: 'running',
      hostId: this.hostId,
    })
    try {
      const outputs = await this.execute(job, template)
      repo.finishJob(this.db, job.id, outputs)
      this.failureStreak = 0
      const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'succeeded'
      this.emit({
        type: 'job-updated',
        jobId: job.id,
        batchId: job.batchId,
        status: finalStatus,
        hostId: this.hostId,
      })
    } catch (err) {
      if (err instanceof AbandonError) {
        // 主动放弃/主机不可达:不是主机「坏」,不计入熔断
        repo.resetJobToPending(this.db, job.id)
        this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'pending' })
      } else {
        repo.failJob(this.db, job.id, err instanceof Error ? err.message : String(err))
        const finalStatus = repo.getJob(this.db, job.id)?.status ?? 'failed'
        this.emit({
          type: 'job-updated',
          jobId: job.id,
          batchId: job.batchId,
          status: finalStatus,
          hostId: this.hostId,
        })
        this.failureStreak++
        if (this.failureStreak >= FAILURE_STREAK_LIMIT) {
          this.failureStreak = 0
          this.onFailureStreak?.(this.hostId)
        }
      }
    } finally {
      this.currentJobId = null
    }
    repo.markBatchCompletedIfDone(this.db, job.batchId)
    const batchStatus = repo.getBatchStatus(this.db, job.batchId) ?? 'running'
    this.emit({ type: 'batch-updated', batchId: job.batchId, status: batchStatus })
    return true
  }

  /** 租用主机空转计时:达阈值上报一次,直到下次真正干活才会再次计时 */
  private trackIdle(): void {
    if (this.hostKind !== 'rental' || !this.onIdle) return
    const t = this.now()
    if (this.idleSince === null) {
      this.idleSince = t
      return
    }
    const idleMs = t - this.idleSince
    if (!this.idleNotified && idleMs >= this.idleNotifyMs) {
      this.idleNotified = true
      this.onIdle(this.hostId, idleMs)
    }
  }
```

- [ ] **Step 6: 不可达超时放弃**

替换 `waitForHistory` 的 catch 分支（保留其余部分不变）：

```ts
      } catch {
        // ComfyUI 掉线 / 查询失败：等待重连，batch 保持 running 不失败
        errorCount++
        if (unreachableSince === null) unreachableSince = this.now()
        // 例外 1:已被 stop()(热切换等待模式在等收尾)且主机连续多轮不可达 —— 说明这台
        // 主机已经死了,再等下去 pause() 永远不返回、切换界面一直转圈。
        if (!this.running && errorCount >= UNREACHABLE_ABANDON_POLLS) {
          throw new AbandonError('主机连续不可达,放弃当前任务')
        }
        // 例外 2:运行中的 worker 连续不可达超过阈值 —— 并行下不能无限等,否则这台主机
        // 手上的任务成了僵尸:别的主机照常干活,它永远 running,batch 永远完不成。
        if (this.now() - unreachableSince >= this.unreachableAbandonMs) {
          throw new AbandonError('主机不可达超时,任务回池由其他主机接手')
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
        continue
      }
```

同函数内，`let errorCount = 0` 之后加：

```ts
    let unreachableSince: number | null = null
```

并在成功分支（`backoff = this.pollMs; errorCount = 0` 那两行旁）补一行清零：

```ts
      backoff = this.pollMs
      errorCount = 0
      unreachableSince = null
```

- [ ] **Step 7: recover 按主机过滤**

替换 `recover` 的首行：

```ts
  /** 启动时收割/重置**本主机**残留的 running job。
   * 并行下不能收割全表:那会把其他主机正在跑的任务判死。 */
  async recover(): Promise<void> {
    for (const job of repo.listRunningJobsByHost(this.db, this.hostId)) {
```

（函数体其余部分不变。）

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- executor-worker`
Expected: PASS（6 个测试）

Run: `pnpm -r test && pnpm -r typecheck`
Expected: 全部通过。既有 executor 测试若因构造参数缺 `hostId`/`hostName`/`hostKind` 报错，逐个补上（`hostId: 1, hostName: 'test', hostKind: 'resident'`）。

- [ ] **Step 9: 提交**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): Executor 改造为单主机 worker

带 hostId/hostName/hostKind;连续失败达 3 次上报(worker 只上报,停机由 pool
决定);租用主机空转达阈值上报一次;运行中主机不可达超 2 分钟放弃当前任务回池
(不计入熔断);recover 只收割本主机的 running job。时钟可注入,测试不真等。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ExecutorPool

**Files:**
- Create: `apps/server/src/executor-pool.ts`
- Test: `apps/server/test/executor-pool.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `Executor`（含 `hostId`、`onFailureStreak`、`onIdle`）、Task 2 的 `listEnabledHosts` / `setHostEnabled` / `reclaimOrphanJobs`
- Produces:
  - `class ExecutorPool`，构造入参 `{ db: Db; events: EventEmitter; dataDir: string; comfyFactory: (url: string) => ComfyClient; pollMs?: number; now?: () => number }`
  - 方法：`syncFromDb(): void`、`pauseAll(opts?: { abandon?: boolean }): Promise<void>`、`resumeAll(db: Db): void`、`stopWorker(hostId: number, opts?: { abandon?: boolean }): Promise<void>`、`restartWorker(hostId: number): Promise<void>`、`reclaimOrphans(): number`、`hasWorker(hostId: number): boolean`、`size(): number`

- [ ] **Step 1: 写失败测试**

新建 `apps/server/test/executor-pool.test.ts`：

```ts
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { ExecutorPool } from '../src/executor-pool.js'
import { FakeComfy } from './fake-comfy.js'

const TEMPLATE = {
  name: 't',
  comfyJson: { '1': { class_type: 'X', inputs: {} } },
  params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
}
const ERROR_RESULT = { status: { completed: false, status_str: 'error', messages: ['boom'] } }

let dir: string
let db: Db
let events: EventEmitter
let pool: ExecutorPool
let clients: Map<string, FakeComfy>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cwe-pool-'))
  db = createDb(':memory:')
  events = new EventEmitter()
  clients = new Map()
  pool = new ExecutorPool({
    db,
    events,
    dataDir: dir,
    pollMs: 1,
    comfyFactory: (url) => {
      let c = clients.get(url)
      if (!c) {
        c = new FakeComfy()
        clients.set(url, c)
      }
      return c
    },
  })
})
afterEach(async () => {
  await pool.pauseAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('syncFromDb', () => {
  it('为每台启用主机起一个 worker', () => {
    repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    pool.syncFromDb()
    expect(pool.size()).toBe(2)
  })

  it('幂等:连调两次不会重复起 worker', () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    pool.syncFromDb()
    expect(pool.size()).toBe(1)
    expect(pool.hasWorker(a.id)).toBe(true)
  })

  it('停用的主机不起 worker,已起的会被移除', async () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    expect(pool.hasWorker(a.id)).toBe(true)
    repo.setHostEnabled(db, a.id, false)
    pool.syncFromDb()
    await vi.waitFor(() => expect(pool.hasWorker(a.id)).toBe(false))
  })
})

describe('熔断', () => {
  it('worker 连续 3 次失败 → 主机落库停用 + 广播 host-disabled', async () => {
    const tpl = repo.createTemplate(db, TEMPLATE)
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }, { p: 3 }] })
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    clients.set('http://a:8188', Object.assign(new FakeComfy(), { nextResult: ERROR_RESULT }))
    pool.syncFromDb()
    await vi.waitFor(
      () => {
        const host = repo.getHost(db, a.id)!
        expect(host.enabled).toBe(0)
        expect(host.disabledReason).toContain('连续')
      },
      { timeout: 5000 },
    )
    await vi.waitFor(() => expect(pool.hasWorker(a.id)).toBe(false))
    expect(seen.some((e) => e.type === 'host-disabled' && e.hostId === a.id)).toBe(true)
  })
})

describe('reclaimOrphans', () => {
  it('把不属于任何启用主机的 running job 重置回 pending', () => {
    const tpl = repo.createTemplate(db, TEMPLATE)
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const onA = repo.claimNextJob(db, a.id)!
    const onB = repo.claimNextJob(db, b.id)!
    repo.setHostEnabled(db, b.id, false)
    expect(pool.reclaimOrphans()).toBe(1)
    expect(repo.getJob(db, onB.job.id)!.status).toBe('pending')
    expect(repo.getJob(db, onA.job.id)!.status).toBe('running')
  })
})

describe('stopWorker', () => {
  it('停用后 worker 从池中移除', async () => {
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    await pool.stopWorker(a.id)
    expect(pool.hasWorker(a.id)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- executor-pool`
Expected: FAIL —— 找不到模块 `../src/executor-pool.js`。

- [ ] **Step 3: 实现 ExecutorPool**

新建 `apps/server/src/executor-pool.ts`：

```ts
import type { EventEmitter } from 'node:events'
import type { ComfyClient } from './comfy/client.js'
import type { Db } from './db/index.js'
import type { Host } from './db/schema.js'
import * as repo from './db/repo.js'
import { Executor, FAILURE_STREAK_LIMIT } from './executor.js'

export interface ExecutorPoolDeps {
  db: Db
  events: EventEmitter
  dataDir: string
  comfyFactory: (url: string) => ComfyClient
  pollMs?: number
  now?: () => number
}

/**
 * 每台「参与调度」的主机一个 Executor 实例,本类只管生命周期。
 *
 * 边界:worker 不改自己的生死。熔断由 worker 上报、本类落库并停机——否则
 * worker 自杀式停机会与 syncFromDb 的对齐逻辑打架。
 */
export class ExecutorPool {
  private db: Db
  private readonly events: EventEmitter
  private readonly dataDir: string
  private readonly comfyFactory: (url: string) => ComfyClient
  private readonly pollMs?: number
  private readonly now?: () => number
  private readonly workers = new Map<number, Executor>()

  constructor(deps: ExecutorPoolDeps) {
    this.db = deps.db
    this.events = deps.events
    this.dataDir = deps.dataDir
    this.comfyFactory = deps.comfyFactory
    this.pollMs = deps.pollMs
    this.now = deps.now
  }

  /** 按 hosts 表对齐 worker 集合。幂等:已有 worker 的主机不会被重复起 */
  syncFromDb(): void {
    const enabled = repo.listEnabledHosts(this.db)
    const wanted = new Set(enabled.map((h) => h.id))
    for (const hostId of [...this.workers.keys()]) {
      if (!wanted.has(hostId)) void this.stopWorker(hostId)
    }
    for (const host of enabled) {
      if (this.workers.has(host.id)) continue
      const worker = this.spawn(host)
      this.workers.set(host.id, worker)
      worker.start()
    }
  }

  private spawn(host: Host): Executor {
    return new Executor({
      db: this.db,
      comfy: this.comfyFactory(host.url),
      events: this.events,
      dataDir: this.dataDir,
      pollMs: this.pollMs,
      hostId: host.id,
      hostName: host.name,
      hostKind: host.kind,
      now: this.now,
      onFailureStreak: (hostId) => this.handleFailureStreak(hostId),
      onIdle: (hostId, idleMs) => this.handleIdle(hostId, idleMs),
    })
  }

  /**
   * 熔断上报处理。**必须推到下一轮事件循环**:worker 是在自己的循环里回调进来的,
   * 此处若同步 await 它的 pause(),而 pause() 要等的正是那个调用方 loop —— 自己等
   * 自己,永久死锁。setImmediate 让当前迭代先返回。
   */
  private handleFailureStreak(hostId: number): void {
    setImmediate(() => void this.disableForFailure(hostId))
  }

  private async disableForFailure(hostId: number): Promise<void> {
    const host = repo.setHostEnabled(
      this.db,
      hostId,
      false,
      `连续 ${FAILURE_STREAK_LIMIT} 次任务失败`,
    )
    await this.stopWorker(hostId)
    this.events.emit('event', {
      type: 'host-disabled',
      hostId,
      hostName: host?.name ?? null,
      reason: host?.disabledReason ?? null,
    })
  }

  private handleIdle(hostId: number, idleMs: number): void {
    const host = repo.getHost(this.db, hostId)
    this.events.emit('event', {
      type: 'host-idle',
      hostId,
      hostName: host?.name ?? null,
      idleMinutes: Math.floor(idleMs / 60_000),
    })
  }

  /** 停一台 worker。abandon=true 时放弃在跑的任务并重置回 pending */
  async stopWorker(hostId: number, opts?: { abandon?: boolean }): Promise<void> {
    const worker = this.workers.get(hostId)
    if (!worker) return
    // 先出池:并发的 syncFromDb 不会再看到它,避免重复停机
    this.workers.delete(hostId)
    await worker.pause(opts)
  }

  /** 改主机 URL 后重建该 worker 的 client */
  async restartWorker(hostId: number): Promise<void> {
    await this.stopWorker(hostId)
    this.syncFromDb()
  }

  async pauseAll(opts?: { abandon?: boolean }): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.pause(opts)))
  }

  /** 数据导入换库后恢复。导入的库自带 hosts 表,旧主机 id 与新库无关:全部丢弃重建 */
  resumeAll(db: Db): void {
    for (const worker of this.workers.values()) worker.stop()
    this.workers.clear()
    this.db = db
    this.reclaimOrphans()
    this.syncFromDb()
  }

  /** 启动时回收无主的 running job(主机已删/已停用/历史数据没盖章) */
  reclaimOrphans(): number {
    return repo.reclaimOrphanJobs(
      this.db,
      repo.listEnabledHosts(this.db).map((h) => h.id),
    )
  }

  hasWorker(hostId: number): boolean {
    return this.workers.has(hostId)
  }

  size(): number {
    return this.workers.size
  }
}
```

- [ ] **Step 4: 改 AppDeps.executor 类型**

Task 6 起的路由会调用 `deps.executor?.stopWorker()` / `restartWorker()` / `syncFromDb()`，因此类型必须在这里就位（否则 Task 6 无法通过 typecheck）。

`apps/server/src/app.ts` 把原来的

```ts
  executor?: { pause(opts?: { abandon?: boolean }): Promise<void>; resume(db: Db, comfy?: ComfyClient): void } | null
```

替换为：

```ts
  /** 执行器池;测试/无 GPU 场景可为 null */
  executor?: ExecutorPool | null
```

顶部导入补 `import type { ExecutorPool } from './executor-pool.js'`。

此改动会让 `routes/backup.ts` 的 `pause()/resume()` 调用与 `index.ts` 的 `new Executor(...)` 报错——Task 8 正式修复；若阻碍本任务验证，可先把 `backup.ts` 两处改为 `pauseAll()` / `resumeAll(newDb)`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- executor-pool`
Expected: PASS（6 个测试）

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/executor-pool.ts apps/server/src/app.ts apps/server/test/executor-pool.test.ts
git commit -m "$(cat <<'EOF'
feat(server): 新增 ExecutorPool 管理每主机 worker 生命周期

syncFromDb 按 hosts.enabled 幂等对齐 worker 集合;熔断由 worker 上报、pool
落库停机并广播(用 setImmediate 推迟一轮,否则 pause() 会等到调用它的那个
loop 上造成死锁);resumeAll 在数据导入换库后丢弃全部 worker 按新库重建。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: host-monitor 探测全部主机

**Files:**
- Modify: `apps/server/src/host-monitor.ts`
- Modify: `apps/server/test/host-monitor.test.ts`（既有测试需跟随签名调整）
- Modify: `apps/server/src/app.ts`（`AppDeps` 加 `hostMonitor?`）

**Interfaces:**
- Produces:
  - `interface HostMonitor { stop(): void; snapshot(): Record<number, boolean> }`
  - `startHostMonitor(deps: { db: Db; events: EventEmitter; comfyFactory: (url: string) => ComfyClient }, intervalMs?: number): HostMonitor`（**返回值由 `() => void` 变为对象**）
  - `AppDeps.hostMonitor?: HostMonitor`

- [ ] **Step 1: 写失败测试**

改写 `apps/server/test/host-monitor.test.ts`（沿用文件既有风格，替换为下列用例）：

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { startHostMonitor } from '../src/host-monitor.js'
import { FakeComfy } from './fake-comfy.js'

describe('host-monitor 多主机', () => {
  it('探测全部主机并逐台广播,快照可读', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const events = new EventEmitter()
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    const clients: Record<string, FakeComfy> = {
      'http://a:8188': Object.assign(new FakeComfy(), { up: true }),
      'http://b:8188': Object.assign(new FakeComfy(), { up: false }),
    }
    const monitor = startHostMonitor({ db, events, comfyFactory: (url) => clients[url]! }, 60_000)
    await vi.waitFor(() => expect(seen.length).toBe(2))
    monitor.stop()
    expect(monitor.snapshot()).toEqual({ [a.id]: true, [b.id]: false })
    expect(seen.find((e) => e.hostId === a.id).online).toBe(true)
    expect(seen.find((e) => e.hostId === b.id).online).toBe(false)
  })

  it('停用的主机也探测(便于用户判断能否启用)', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.setHostEnabled(db, a.id, false)
    const events = new EventEmitter()
    const monitor = startHostMonitor({ db, events, comfyFactory: () => new FakeComfy() }, 60_000)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(true))
    monitor.stop()
  })

  it('主机被删除后从快照中移除', async () => {
    const db = createDb(':memory:')
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const events = new EventEmitter()
    const monitor = startHostMonitor({ db, events, comfyFactory: () => new FakeComfy() }, 5)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBe(true))
    repo.deleteHost(db, a.id)
    await vi.waitFor(() => expect(monitor.snapshot()[a.id]).toBeUndefined())
    monitor.stop()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- host-monitor`
Expected: FAIL —— `monitor.snapshot is not a function`。

- [ ] **Step 3: 重写 host-monitor.ts**

整体替换 `apps/server/src/host-monitor.ts`：

```ts
import type { EventEmitter } from 'node:events'
import type { ComfyClient } from './comfy/client.js'
import type { Db } from './db/index.js'
import { listHosts } from './db/repo.js'

export interface HostMonitor {
  stop(): void
  /** 各主机最近一次探测结果;未探测过的主机不在其中 */
  snapshot(): Record<number, boolean>
}

/**
 * 周期探测**全部**主机(含未启用的,便于用户判断能否启用),逐台翻转时经
 * deps.events 广播 comfy-status(SSE 透传)。
 *
 * 快照是前端的初始态来源:comfy-status 只在翻转时广播,新连上的客户端没有
 * 全量事件可回放,靠 GET /api/hosts 读这份缓存对齐。
 */
export function startHostMonitor(
  deps: { db: Db; events: EventEmitter; comfyFactory: (url: string) => ComfyClient },
  intervalMs = 5000,
): HostMonitor {
  const online = new Map<number, boolean>()
  // 按 URL 缓存 client,避免每轮为每台主机重建
  const clients = new Map<string, ComfyClient>()
  let probing = false

  const clientFor = (url: string): ComfyClient => {
    let c = clients.get(url)
    if (!c) {
      c = deps.comfyFactory(url)
      clients.set(url, c)
    }
    return c
  }

  const tick = async () => {
    if (probing) return
    probing = true
    try {
      const hosts = listHosts(deps.db)
      const live = new Set(hosts.map((h) => h.id))
      for (const id of [...online.keys()]) if (!live.has(id)) online.delete(id)
      await Promise.all(
        hosts.map(async (host) => {
          let up = false
          try {
            up = await clientFor(host.url).isUp()
          } catch {
            up = false
          }
          if (online.get(host.id) !== up) {
            online.set(host.id, up)
            deps.events.emit('event', {
              type: 'comfy-status',
              online: up,
              hostId: host.id,
              hostName: host.name,
            })
          }
        }),
      )
    } finally {
      probing = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return {
    stop: () => clearInterval(timer),
    snapshot: () => Object.fromEntries(online),
  }
}
```

- [ ] **Step 4: AppDeps 加 hostMonitor**

`apps/server/src/app.ts` 的 `AppDeps` 接口追加：

```ts
  /** 主机在线状态缓存;由 index.ts 在 createApp 之后赋值(deps 是共享可变对象) */
  hostMonitor?: HostMonitor
```

顶部导入补 `import type { HostMonitor } from './host-monitor.js'`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- host-monitor`
Expected: PASS（3 个测试）

Run: `pnpm --filter @cwe/server typecheck`
Expected: 仅 `index.ts` 报错（返回值不再是函数）——把该行临时改为 `startHostMonitor({ db, events, comfyFactory: createComfyClient })`，Task 8 正式接线。

- [ ] **Step 6: 提交**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): host-monitor 探测全部主机并维护在线快照

comfy-status 只在翻转时广播,新连上的前端没有全量事件可回放;monitor 现在
把各主机在线状态缓存在内存,供 GET /api/hosts 作为前端初始态返回。client
按 URL 缓存避免每轮重建。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 主机路由改造

**Files:**
- Modify: `apps/server/src/routes/hosts.ts`
- Modify: `apps/server/src/host-switch.ts`
- Test: `apps/server/test/hosts.test.ts`（既有文件追加用例；`activate` 既有用例需去掉 `mode` 请求体）

**Interfaces:**
- Consumes: Task 4 的 `ExecutorPool`、Task 5 的 `HostMonitor`、Task 2 的 `setHostEnabled` / `countPinnedUnfinishedBatches`
- Produces（HTTP 契约）：
  - `GET /api/hosts` → `{ hosts: Array<Host & { online: boolean | null; pinnedBatches: number }> }`
  - `POST /api/hosts` 请求体增加可选 `kind`、`rentedAt`、`hourlyRate`
  - `PATCH /api/hosts/:id` 同上，另接受 `enabled: true`（仅用于启用）
  - `POST /api/hosts/:id/activate` **请求体为空**
  - `POST /api/hosts/:id/disable` 请求体 `{ mode: 'wait' | 'interrupt' }`
  - `GET /api/hosts/:id/stats` → 与 `/current/stats` 相同结构

- [ ] **Step 1: 写失败测试**

在 `apps/server/test/hosts.test.ts` 追加（沿用该文件既有的 app 构造与鉴权头辅助；把 `deps.executor` 换成真实 `ExecutorPool`，`comfyFactory` 注入 `FakeComfy`，并让构造辅助一并返回 pool）：

```ts
describe('参与调度开关', () => {
  it('disable 端点停用主机并停 worker', async () => {
    const { app, db, pool } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    const res = await app.request(`/api/hosts/${host.id}/disable`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'wait' }),
    })
    expect(res.status).toBe(200)
    expect(repo.getHost(db, host.id)!.enabled).toBe(0)
    expect(pool.hasWorker(host.id)).toBe(false)
  })

  it('PATCH enabled=true 重新启用并清空停用原因', async () => {
    const { app, db, pool } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.setHostEnabled(db, host.id, false, '连续 3 次任务失败')
    const res = await app.request(`/api/hosts/${host.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const after = repo.getHost(db, host.id)!
    expect(after.enabled).toBe(1)
    expect(after.disabledReason).toBeNull()
    expect(pool.hasWorker(host.id)).toBe(true)
  })
})

describe('主机列表附带在线与锁定信息', () => {
  it('online 取自 monitor 快照,pinnedBatches 为未完成锁定批次数', async () => {
    const { app, db } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const tpl = repo.createTemplate(db, {
      name: 't',
      comfyJson: { '1': { class_type: 'X', inputs: {} } },
      params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
    })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] }, host.id)
    const res = await app.request('/api/hosts', { headers: authHeaders })
    const body = (await res.json()) as any
    expect(body.hosts[0].pinnedBatches).toBe(1)
    expect(body.hosts[0]).toHaveProperty('online')
  })
})

describe('activate 简化', () => {
  it('无请求体即可切换参考主机,且不停 worker', async () => {
    const { app, db, pool } = setupApp()
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.activateHost(db, a.id)
    pool.syncFromDb()
    const before = pool.size()
    const res = await app.request(`/api/hosts/${b.id}/activate`, {
      method: 'POST',
      headers: authHeaders,
    })
    expect(res.status).toBe(200)
    expect(repo.getActiveHost(db)!.id).toBe(b.id)
    expect(pool.size()).toBe(before)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- hosts`
Expected: FAIL —— `/disable` 返回 404；`hosts[0].pinnedBatches` 为 `undefined`。

- [ ] **Step 3: 收窄 reconnectComfy**

`apps/server/src/host-switch.ts` 替换 `reconnectComfy`：

```ts
/** 切换参考主机:只换查询用 client 并失效节点缓存。
 * 不再碰 executor —— 参考主机与「谁干活」已解耦(见 spec「active 退位」)。 */
export async function reconnectComfy(
  deps: Pick<AppDeps, 'db' | 'comfy' | 'events' | 'objectInfo'>,
  host: { id: number; name: string; url: string },
): Promise<void> {
  const client = createComfyClient(host.url)
  deps.comfy = client
  deps.objectInfo?.invalidate()
  const online = await client.isUp()
  deps.events.emit('event', {
    type: 'comfy-status',
    online,
    hostId: host.id,
    hostName: host.name,
  })
}
```

- [ ] **Step 4: 改 schema 与 GET /**

`apps/server/src/routes/hosts.ts` 的 schema 区替换（删除原 `activateSchema`）：

```ts
const kindSchema = z.enum(['resident', 'rental'])
const createSchema = z.object({
  name: z.string().trim().min(1),
  url: urlSchema,
  note: z.string().nullish(),
  kind: kindSchema.optional(),
  rentedAt: z.string().nullish(),
  hourlyRate: z.number().positive().nullish(),
})
const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  url: urlSchema.optional(),
  note: z.string().nullish(),
  kind: kindSchema.optional(),
  rentedAt: z.string().nullish(),
  hourlyRate: z.number().positive().nullish(),
  /** 只接受 true:停用需要选模式,必须走 POST /:id/disable */
  enabled: z.literal(true).optional(),
})
const disableSchema = z.object({ mode: z.enum(['wait', 'interrupt']) })
```

`GET /` 替换：

```ts
  app.get('/', (c) => {
    const snapshot = deps.hostMonitor?.snapshot() ?? {}
    const hosts = repo.listHosts(deps.db).map((h) => ({
      ...h,
      // 取自 monitor 缓存,不做实时探测;未探测过为 null
      online: snapshot[h.id] ?? null,
      pinnedBatches: repo.countPinnedUnfinishedBatches(deps.db, h.id),
    }))
    return c.json({ hosts })
  })
```

- [ ] **Step 5: 改 PATCH / activate，新增 disable 与按 id stats**

`PATCH /:id` 替换整段：

```ts
  app.patch('/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const patch = patchSchema.parse(await c.req.json())
    return await lock.run(async () => {
      const before = repo.getHost(deps.db, id)
      if (!before) return c.json({ error: 'host 不存在' }, 404)
      const { enabled, ...fields } = patch
      const urlChanged = fields.url !== undefined && fields.url !== before.url
      if (!repo.updateHost(deps.db, id, fields)) {
        return c.json({ error: 'host 不存在' }, 404)
      }
      if (enabled === true && before.enabled !== 1) repo.setHostEnabled(deps.db, id, true)
      // 改 URL 只重建该主机的 worker,不影响其他 worker
      if (urlChanged) await deps.executor?.restartWorker(id)
      deps.executor?.syncFromDb()
      // 参考主机换了地址,查询用 client 也要跟着换
      if (urlChanged && before.active === 1) {
        await reconnectComfy(deps, repo.getHost(deps.db, id)!)
      }
      return c.json({ host: repo.getHost(deps.db, id)! })
    })
  })
```

`POST /:id/activate` 替换整段：

```ts
  app.post('/:id/activate', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    // 只换参考主机:不 pause 任何 worker,并行任务不中断。
    // spec 说此入口「不再需要进锁」——但仍保留:它与 DELETE 存在竞态(排队期间
    // 目标主机可能被删除,导致把已删除的主机设为参考主机)。锁的成本是零。
    return await lock.run(async () => {
      const target = repo.getHost(deps.db, id)
      if (!target) return c.json({ error: 'host 不存在' }, 404)
      if (target.active === 1) return c.json({ host: target })
      const host = repo.activateHost(deps.db, id)!
      await reconnectComfy(deps, host)
      return c.json({ host })
    })
  })
```

在其后新增：

```ts
  app.post('/:id/disable', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const { mode } = disableSchema.parse(await c.req.json())
    return await lock.run(async () => {
      if (!repo.getHost(deps.db, id)) return c.json({ error: 'host 不存在' }, 404)
      repo.setHostEnabled(deps.db, id, false)
      // wait = 等当前任务跑完;interrupt = 放弃并重置回 pending 由其他主机接手
      await deps.executor?.stopWorker(id, mode === 'interrupt' ? { abandon: true } : undefined)
      return c.json({ host: repo.getHost(deps.db, id)! })
    })
  })

  app.get('/:id/stats', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const host = repo.getHost(deps.db, id)
    if (!host) return c.json({ error: 'host 不存在' }, 404)
    return c.json(await probeStats(deps.comfyFactory!(host.url)))
  })
```

- [ ] **Step 6: 抽出 probeStats 并改 current/stats、DELETE**

在模块顶层（`hostRoutes` 函数之外）新增：

```ts
async function probeStats(client: ComfyClient) {
  try {
    const [stats, queue, cweVersion] = await Promise.all([
      client.getSystemStats(),
      client.getQueueCounts(),
      client.cwePing(),
    ])
    const dev = stats.devices?.[0]
    const mb = (n: number | undefined) => (n != null ? Math.round(n / 1048576) : null)
    return {
      online: true,
      gpuName: dev?.name ?? null,
      vramTotalMB: mb(dev?.vram_total),
      vramFreeMB: mb(dev?.vram_free),
      comfyuiVersion: stats.system?.comfyui_version ?? null,
      pythonVersion: stats.system?.python_version ?? null,
      os: stats.system?.os ?? null,
      queueRunning: queue.running,
      queuePending: queue.pending,
      cwe: cweVersion > 0,
    }
  } catch {
    return { online: false }
  }
}
```

`GET /current/stats` 整段替换为：

```ts
  app.get('/current/stats', async (c) => {
    if (!deps.comfy) return c.json({ online: false })
    return c.json(await probeStats(deps.comfy))
  })
```

`DELETE /:id` 替换整段：

```ts
  app.delete('/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    return await lock.run(async () => {
      // 停 worker 再删,避免 worker 拿着已删除主机的 id 继续认领
      await deps.executor?.stopWorker(id)
      const result = repo.deleteHost(deps.db, id)
      if (result === 'active') return c.json({ error: '参考主机不可删除' }, 409)
      return c.json({ ok: true })
    })
  })
```

文件顶部导入补 `import type { ComfyClient } from '../comfy/client.js'`。

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- hosts`
Expected: PASS。既有 activate 用例若仍传 `{ mode }` 请求体，删掉该 body（新实现忽略请求体，保留会误导意图）。

- [ ] **Step 8: 提交**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): 主机路由支持参与调度开关与停用双模式

新增 POST /:id/disable(wait|interrupt)与 GET /:id/stats;GET / 附带 online
(monitor 快照)与 pinnedBatches;activate 简化为只换参考主机、不再 pause
executor(mode 参数移除,该选择迁移到 disable);改 URL 只重建该主机 worker。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 建批时自动锁定主机

**Files:**
- Modify: `apps/server/src/routes/templates.ts`
- Test: `apps/server/test/routes.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `createBatch(db, templateId, input, pinnedHostId?)`
- Produces: `POST /api/templates/:id/batches` 返回的 batch 带 `pinnedHostId`

- [ ] **Step 1: 写失败测试**

在 `apps/server/test/routes.test.ts` 追加（沿用该文件既有的 app / authHeaders / dataDir）：

```ts
describe('建批自动锁定主机', () => {
  it('image 值不在本地 uploads 时锁定到参考主机', async () => {
    const tpl = repo.createTemplate(db, {
      name: 't-pin',
      comfyJson: { '10': { class_type: 'LoadImage', inputs: { image: 'x.png' } } },
      params: [{ key: 'img', label: '图', nodeId: '10', inputName: 'image', type: 'image' }],
    })
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.activateHost(db, host.id)
    const res = await app.request(`/api/templates/${tpl.id}/batches`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'b', jobs: [{ img: 'only-on-gpu.png' }] }),
    })
    const batch = (await res.json()) as any
    expect(batch.pinnedHostId).toBe(host.id)
  })

  it('image 值都是本地 uploads 文件时不锁定', async () => {
    writeFileSync(join(dataDir, 'uploads', 'local.png'), 'x')
    const tpl = repo.createTemplate(db, {
      name: 't-local',
      comfyJson: { '10': { class_type: 'LoadImage', inputs: { image: 'x.png' } } },
      params: [{ key: 'img', label: '图', nodeId: '10', inputName: 'image', type: 'image' }],
    })
    repo.activateHost(db, repo.createHost(db, { name: 'A', url: 'http://a:8188' }).id)
    const res = await app.request(`/api/templates/${tpl.id}/batches`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'b', jobs: [{ img: 'local.png' }] }),
    })
    const batch = (await res.json()) as any
    expect(batch.pinnedHostId).toBeNull()
  })

  it('无 image 参数的模板不锁定', async () => {
    const tpl = repo.createTemplate(db, {
      name: 't-text',
      comfyJson: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } },
      params: [{ key: 'p', label: 'P', nodeId: '6', inputName: 'text', type: 'text' }],
    })
    repo.activateHost(db, repo.createHost(db, { name: 'A', url: 'http://a:8188' }).id)
    const res = await app.request(`/api/templates/${tpl.id}/batches`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'b', jobs: [{ p: 'hi' }] }),
    })
    const batch = (await res.json()) as any
    expect(batch.pinnedHostId).toBeNull()
  })
})
```

（文件顶部若尚未导入 `writeFileSync` / `join`，补上。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: FAIL —— `batch.pinnedHostId` 为 `undefined`。

- [ ] **Step 3: 实现检测**

`apps/server/src/routes/templates.ts` 的 `POST /:id/batches` 处理器中，`const batch = repo.createBatch(...)` 之前插入：

```ts
    // 引用 GPU 侧已有文件(本地 uploads 没有)的任务搬不到别的主机,把整批锁到参考主机。
    // 判据与 executor.execute 的取值逻辑保持一致:本地有就上传、没有才原样引用。
    const referencesGpuFile = template.params
      .filter((p) => p.type === 'image')
      .some((def) =>
        input.jobs.some((job) => {
          const v = job[def.key] ?? def.default
          if (typeof v !== 'string' || !v) return false
          if (v.includes('..') || isAbsolute(v)) return true
          return !existsSync(join(deps.config.dataDir, 'uploads', v))
        }),
      )
    const pinnedHostId = referencesGpuFile ? (repo.getActiveHost(deps.db)?.id ?? null) : null
```

并把建批调用改为：

```ts
    const batch = repo.createBatch(deps.db, id, input, pinnedHostId)
```

文件顶部导入补：

```ts
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): 建批时检测 GPU 文件引用并自动锁定主机

引用 GPU 侧已有文件的任务搬不到别的主机,并行下会连续失败并误伤健康主机的
熔断计数。建批时按与 executor.execute 一致的判据(本地 uploads 有就上传、
没有才原样引用)检测,命中即把整批锁到参考主机。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 接线与数据导入适配

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/backup.ts`
- Test: `apps/server/test/backup.test.ts`（既有导入测试需跟随改动）

**Interfaces:**
- Consumes: Task 4 的 `ExecutorPool`、Task 5 的 `HostMonitor`
- Produces: `AppDeps.executor?: ExecutorPool | null`（**类型变更**）

- [ ] **Step 1: 改数据导入的暂停/恢复**

`apps/server/src/routes/backup.ts` 中导入流程的两处调用：

```ts
await deps.executor?.pauseAll()
```

```ts
deps.executor?.resumeAll(newDb)
```

（原先是 `pause()` 与 `resume(newDb)`。`resumeAll` 内部丢弃旧 worker、回收孤儿并按新库的 hosts 表重建——导入的库自带 hosts 表，旧主机 id 与新库无关。）

- [ ] **Step 2: 改 index.ts 接线**

`apps/server/src/index.ts`：`deps` 声明替换为

```ts
const deps = {
  config,
  db,
  comfy,
  events,
  executor: null as ExecutorPool | null,
  hostMonitor: undefined as HostMonitor | undefined,
}
```

`const executor = new Executor(...)` 起的三行替换为：

```ts
const pool = new ExecutorPool({
  db,
  events,
  dataDir: config.dataDir,
  comfyFactory: createComfyClient,
})
deps.executor = pool
// 先回收无主的 running job(主机已删/已停用/历史数据没盖章),再起 worker
pool.reclaimOrphans()
pool.syncFromDb()
deps.hostMonitor = startHostMonitor({ db, events, comfyFactory: createComfyClient })
```

导入替换（删除 `import { Executor } from './executor.js'`）：

```ts
import { ExecutorPool } from './executor-pool.js'
import { startHostMonitor, type HostMonitor } from './host-monitor.js'
```

启动日志改为：

```ts
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `comfy-workflow-executor listening on :${info.port} → 参考主机 ${activeHost.name}，${pool.size()} 台主机参与调度`,
  )
})
```

- [ ] **Step 3: 全量验证**

Run: `pnpm -r typecheck`
Expected: 通过。既有测试里手写 `{ pause, resume }` 桩充当 `deps.executor` 的位置，改为真实 `ExecutorPool`（`comfyFactory: () => new FakeComfy()`）或 `null`。

Run: `pnpm -r test`
Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): 接线 ExecutorPool 与主机监控

AppDeps.executor 换成 ExecutorPool;数据导入改用 pauseAll/resumeAll(换库后
按新库 hosts 表重建 worker);启动先回收孤儿 running job 再起 worker。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 前端主机状态底座

**Files:**
- Create: `apps/web/src/lib/hosts.ts`
- Create: `apps/web/src/lib/hosts.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/hooks/use-comfy-status.ts`

**Interfaces:**
- Consumes: Task 6 的 `GET /api/hosts`（附带 `online` 与 `pinnedBatches`）
- Produces:
  - `HostDto` 增加 `enabled: number`、`kind: 'resident' | 'rental'`、`rentedAt: string | null`、`hourlyRate: number | null`、`disabledReason: string | null`、`online: boolean | null`、`pinnedBatches: number`
  - `apps/web/src/lib/hosts.ts`：`onlineSummary(hosts, ): { online: number; total: number }`、`hasUsableHost(hosts): boolean`、`referenceHost(hosts): HostDto | undefined`、`rentalMinutes(rentedAt, nowMs): number`、`formatDuration(minutes): string`、`rentalCost(rentedAt, hourlyRate, nowMs): number | null`
  - `apps/web/src/hooks/use-comfy-status.ts`：`useHosts(): HostDto[] | undefined`、`useHostFeed(): void`
  - API：`disableHost(id, mode)`、`enableHost(id)`、`fetchHostStatsById(id)`；`activateHost(id)` **去掉 mode 参数**

**关键设计**：不再单独维护一份「在线状态映射」。`GET /api/hosts` 返回的列表本身就带 `online`，SSE 的 `comfy-status` 事件按 `hostId` **局部改写该列表缓存中的一项**。单一数据源同时提供主机名与在线态，避免两份缓存对不齐。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/hosts.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { HostDto } from './api'
import {
  formatDuration,
  hasUsableHost,
  onlineSummary,
  referenceHost,
  rentalCost,
  rentalMinutes,
} from './hosts'

const host = (over: Partial<HostDto>): HostDto => ({
  id: 1,
  name: 'A',
  url: 'http://a:8188',
  note: null,
  active: 0,
  enabled: 1,
  kind: 'resident',
  rentedAt: null,
  hourlyRate: null,
  disabledReason: null,
  online: true,
  pinnedBatches: 0,
  createdAt: '2026-08-15T00:00:00Z',
  ...over,
})

describe('onlineSummary', () => {
  it('只统计参与调度的主机', () => {
    const hosts = [
      host({ id: 1, online: true }),
      host({ id: 2, online: false }),
      host({ id: 3, online: true, enabled: 0 }), // 未参与调度,不计入
    ]
    expect(onlineSummary(hosts)).toEqual({ online: 1, total: 2 })
  })

  it('未探测过(null)不算在线', () => {
    expect(onlineSummary([host({ online: null })])).toEqual({ online: 0, total: 1 })
  })
})

describe('hasUsableHost', () => {
  it('存在既参与调度又在线的主机才算可用', () => {
    expect(hasUsableHost([host({ online: true })])).toBe(true)
    expect(hasUsableHost([host({ online: false })])).toBe(false)
    expect(hasUsableHost([host({ online: true, enabled: 0 })])).toBe(false)
    expect(hasUsableHost([])).toBe(false)
  })
})

describe('referenceHost', () => {
  it('取 active=1 的那台', () => {
    const hosts = [host({ id: 1 }), host({ id: 2, active: 1 })]
    expect(referenceHost(hosts)?.id).toBe(2)
  })
  it('没有 active 时返回 undefined', () => {
    expect(referenceHost([host({})])).toBeUndefined()
  })
})

describe('租用时长与费用', () => {
  const t0 = Date.parse('2026-08-15T00:00:00Z')

  it('按起租时间算已运行分钟数', () => {
    expect(rentalMinutes('2026-08-15T00:00:00Z', t0 + 3 * 3600_000 + 12 * 60_000)).toBe(192)
  })

  it('时长格式化', () => {
    expect(formatDuration(192)).toBe('3h 12m')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(120)).toBe('2h 0m')
  })

  it('费用按小时单价折算,无单价返回 null', () => {
    expect(rentalCost('2026-08-15T00:00:00Z', 2, t0 + 90 * 60_000)).toBeCloseTo(3)
    expect(rentalCost('2026-08-15T00:00:00Z', null, t0 + 90 * 60_000)).toBeNull()
  })

  it('起租时间在未来时按 0 处理,不出负数', () => {
    expect(rentalMinutes('2026-08-15T01:00:00Z', t0)).toBe(0)
    expect(rentalCost('2026-08-15T01:00:00Z', 2, t0)).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cwe/web test`
Expected: FAIL —— 找不到 `./hosts` 模块。

- [ ] **Step 3: 实现纯函数**

新建 `apps/web/src/lib/hosts.ts`：

```ts
import type { HostDto } from './api'

/** 在线台数/参与调度总台数。未探测过(null)按不在线计 */
export function onlineSummary(hosts: HostDto[]): { online: number; total: number } {
  const scheduling = hosts.filter((h) => h.enabled === 1)
  return {
    online: scheduling.filter((h) => h.online === true).length,
    total: scheduling.length,
  }
}

/** 是否还有主机能干活:既参与调度又在线 */
export function hasUsableHost(hosts: HostDto[]): boolean {
  return hosts.some((h) => h.enabled === 1 && h.online === true)
}

/** 参考主机:只服务节点/模型/文件列表查询,与「谁干活」无关 */
export function referenceHost(hosts: HostDto[]): HostDto | undefined {
  return hosts.find((h) => h.active === 1)
}

/** 已运行分钟数;起租时间在未来时按 0 处理 */
export function rentalMinutes(rentedAt: string, nowMs: number): number {
  const start = Date.parse(rentedAt)
  if (Number.isNaN(start)) return 0
  return Math.max(0, Math.floor((nowMs - start) / 60_000))
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** 估算费用;未填单价返回 null(只显示时长) */
export function rentalCost(
  rentedAt: string,
  hourlyRate: number | null,
  nowMs: number,
): number | null {
  if (hourlyRate == null) return null
  return (rentalMinutes(rentedAt, nowMs) / 60) * hourlyRate
}
```

- [ ] **Step 4: 扩展 API 客户端**

`apps/web/src/lib/api.ts`：`HostDto` 替换为

```ts
export interface HostDto {
  id: number
  name: string
  url: string
  note: string | null
  /** 参考主机(只服务查询),不再决定谁干活 */
  active: number
  /** 参与调度:为 1 才会起 worker */
  enabled: number
  kind: 'resident' | 'rental'
  rentedAt: string | null
  hourlyRate: number | null
  /** 自动停用原因(熔断) */
  disabledReason: string | null
  /** 来自服务端 monitor 缓存;null = 尚未探测过 */
  online: boolean | null
  /** 锁定到该主机的未完成批次数 */
  pinnedBatches: number
  createdAt: string
}
```

主机相关调用替换为：

```ts
export interface HostWritable {
  name: string
  url: string
  note?: string | null
  kind?: 'resident' | 'rental'
  rentedAt?: string | null
  hourlyRate?: number | null
}

export const createHost = (input: HostWritable) =>
  api<{ host: HostDto }>('/hosts', { method: 'POST', body: JSON.stringify(input) })

/** note 传 null 表示清空备注(传 undefined 会被 JSON 丢键,服务端保留原值) */
export const updateHost = (id: number, patch: Partial<HostWritable> & { enabled?: true }) =>
  api<{ host: HostDto }>(`/hosts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })

/** 设为参考主机。不影响任何 worker,故无需模式选择 */
export const activateHost = (id: number) =>
  api<{ host: HostDto }>(`/hosts/${id}/activate`, { method: 'POST' })

/** 停用调度。wait=等当前任务跑完;interrupt=放弃并重排到其他主机 */
export const disableHost = (id: number, mode: 'wait' | 'interrupt') =>
  api<{ host: HostDto }>(`/hosts/${id}/disable`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })

export const enableHost = (id: number) => updateHost(id, { enabled: true })

export const fetchHostStatsById = (id: number) => api<HostStatsDto>(`/hosts/${id}/stats`)
```

（`fetchHosts`、`deleteHost`、`testHost`、`fetchHostStats` 保持不变。）

- [ ] **Step 5: 重构 use-comfy-status.ts**

整体替换 `apps/web/src/hooks/use-comfy-status.ts`：

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { fetchHosts, getToken, type HostDto } from '@/lib/api'

/**
 * 全站主机列表(含在线态)。
 *
 * 单一数据源:列表本身带 online,SSE 的 comfy-status 按 hostId 局部改写其中一项。
 * 不另存一份在线映射——两份缓存必然会有对不齐的时候。
 */
export function useHosts(): HostDto[] | undefined {
  const { data } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
    staleTime: Infinity,
    refetchInterval: 60_000, // SSE 断线兜底
  })
  return data?.hosts
}

/** 只在常驻组件(HostStatus)挂一次:独占一条 SSE,把主机相关事件写回查询缓存 */
export function useHostFeed(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)

    es.addEventListener('comfy-status', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { online: boolean; hostId: number }
      qc.setQueryData<{ hosts: HostDto[] }>(['hosts'], (prev) =>
        prev
          ? { hosts: prev.hosts.map((h) => (h.id === d.hostId ? { ...h, online: d.online } : h)) }
          : prev,
      )
      // 主机或在线状态变化 → cwe 扩展安装状态需重探(不同主机装没装扩展不同)
      void qc.invalidateQueries({ queryKey: ['cwe-status'] })
    })

    es.addEventListener('host-disabled', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { hostName: string | null; reason: string | null }
      toast.error(`主机「${d.hostName ?? '未知'}」已自动停用调度`, { description: d.reason ?? undefined })
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    })

    es.addEventListener('host-idle', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { hostName: string | null; idleMinutes: number }
      toast.warning(`租用主机「${d.hostName ?? '未知'}」已空闲 ${d.idleMinutes} 分钟`, {
        description: '仍在计费中，考虑下线',
      })
    })

    es.onerror = () => console.warn('SSE connection error — browser will retry')
    return () => es.close()
  }, [qc])
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @cwe/web test`
Expected: PASS（`hosts.test.ts` 新增 11 个断言块）

Run: `pnpm --filter @cwe/web typecheck`
Expected: 报错集中在 `host-status.tsx` / `offline-banner.tsx` / `hosts.tsx`（仍在用已删除的 `useComfyStatus`、`activateHost(id, mode)`）——由 Task 10/11 修复。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/lib apps/web/src/hooks
git commit -m "$(cat <<'EOF'
feat(web): 主机状态改为单一数据源的列表缓存

原 useComfyStatus 只存单个主机的在线态,并行后最后广播的主机会把其他主机的
状态抹掉。改为以 GET /api/hosts 的列表(自带 online)为唯一数据源,SSE 按
hostId 局部改写其中一项;派生量抽 lib/hosts.ts 纯函数配单测。feed 同时接管
host-disabled / host-idle 的 toast。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 头部指示灯与离线横幅

**Files:**
- Modify: `apps/web/src/components/host-status.tsx`
- Modify: `apps/web/src/components/offline-banner.tsx`

**Interfaces:**
- Consumes: Task 9 的 `useHosts()`、`useHostFeed()`、`onlineSummary`、`hasUsableHost`、`referenceHost`

- [ ] **Step 1: 改写 host-status.tsx**

整体替换 `apps/web/src/components/host-status.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { useHostFeed, useHosts } from '@/hooks/use-comfy-status'
import { fetchHostStats, type HostDto } from '@/lib/api'
import { onlineSummary, referenceHost } from '@/lib/hosts'
import { cn } from '@/lib/utils'
import { useState } from 'react'

/** Header 常驻:参与调度主机的在线聚合;hover 出逐台清单与参考主机详情,点击进主机管理页 */
export function HostStatus() {
  useHostFeed()
  const hosts = useHosts()
  const [open, setOpen] = useState(false)

  const summary = hosts ? onlineSummary(hosts) : null
  const color =
    summary == null
      ? 'bg-muted-foreground'
      : summary.online === 0
        ? 'bg-destructive animate-pulse'
        : summary.online < summary.total
          ? 'bg-warning'
          : 'bg-success'

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to="/hosts" className="flex items-center gap-2 text-sm">
          <span className={cn('inline-flex size-2.5 rounded-full', color)} />
          <span className="text-muted-foreground transition-colors duration-150 hover:text-foreground">
            {summary ? `${summary.online}/${summary.total} 台在线` : 'GPU 主机'}
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72">
        <HostList hosts={hosts} open={open} />
      </HoverCardContent>
    </HoverCard>
  )
}

function HostList({ hosts, open }: { hosts: HostDto[] | undefined; open: boolean }) {
  const reference = hosts ? referenceHost(hosts) : undefined
  if (!hosts) return <p className="text-sm text-muted-foreground">加载中…</p>
  if (hosts.length === 0) return <p className="text-sm text-muted-foreground">尚未添加主机</p>
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {hosts.map((h) => (
          <li key={h.id} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'inline-flex size-2 shrink-0 rounded-full',
                h.online === true ? 'bg-success' : h.online === false ? 'bg-destructive' : 'bg-muted-foreground',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{h.name}</span>
            {h.active === 1 && <span className="text-xs text-muted-foreground">参考</span>}
            {h.enabled !== 1 && <span className="text-xs text-muted-foreground">未调度</span>}
          </li>
        ))}
      </ul>
      {reference && (
        <div className="border-t pt-2">
          <ReferenceStats enabled={open} online={reference.online} />
        </div>
      )}
    </div>
  )
}

/** 参考主机的详情:显存/队列/扩展 */
function ReferenceStats({ enabled, online }: { enabled: boolean; online: boolean | null }) {
  const { data, isError } = useQuery({
    queryKey: ['host-stats'],
    queryFn: fetchHostStats,
    enabled,
    staleTime: 30_000,
  })
  if (online === false || isError || data?.online === false)
    return <p className="text-sm text-muted-foreground">参考主机离线或不可达</p>
  if (!data) return <p className="text-sm text-muted-foreground">加载中…</p>
  const used =
    data.vramTotalMB != null && data.vramFreeMB != null ? data.vramTotalMB - data.vramFreeMB : null
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{data.gpuName ?? '未知 GPU'}</p>
      {used != null && data.vramTotalMB != null && (
        <div className="space-y-1">
          <Progress value={(used / data.vramTotalMB) * 100} />
          <p className="text-xs text-muted-foreground">
            显存 {(used / 1024).toFixed(1)} / {(data.vramTotalMB / 1024).toFixed(1)} GB
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        ComfyUI {data.comfyuiVersion ?? '?'} · 队列 {data.queueRunning ?? 0} 跑 /{' '}
        {data.queuePending ?? 0} 等 · cwe {data.cwe ? '✓' : '✗'}
      </p>
    </div>
  )
}
```

> 注：原先「离线→在线翻转时绿灯 ping 一次」的动画在聚合语义下没有对应物（多台主机各自翻转），本次移除。

- [ ] **Step 2: 改写 offline-banner.tsx**

整体替换：

```tsx
import { Link } from 'react-router-dom'
import { useHosts } from '@/hooks/use-comfy-status'
import { hasUsableHost } from '@/lib/hosts'

/** 没有任何「参与调度且在线」的主机、且页面存在未完成任务时的提示横幅 */
export function OfflineBanner({ hasActiveWork }: { hasActiveWork: boolean }) {
  const hosts = useHosts()
  if (!hosts || !hasActiveWork || hasUsableHost(hosts)) return null
  const allDisabled = hosts.length > 0 && hosts.every((h) => h.enabled !== 1)
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
      {allDisabled ? (
        <>
          所有主机均已停用调度，任务无人执行。
          <Link to="/hosts" className="ml-1 underline">
            前往主机管理
          </Link>
        </>
      ) : (
        '当前没有在线的调度主机，任务将在主机恢复后自动继续。'
      )}
    </div>
  )
}
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @cwe/web typecheck`
Expected: 仅 `hosts.tsx` 仍报错（Task 11 修）。

Run: `pnpm --filter @cwe/web build`
Expected: 构建成功（`hosts.tsx` 若阻塞构建，先跑 typecheck 即可，Task 11 后再 build）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components
git commit -m "$(cat <<'EOF'
feat(web): 头部指示灯改聚合显示,离线横幅区分「全停用」

指示灯显示「N/M 台在线」,hover 列出逐台状态并标出参考主机;横幅在所有主机
都被停用时给出明确提示与入口——否则用户只会看到任务卡在 pending 毫无线索。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 主机管理页

**Files:**
- Modify: `apps/web/src/pages/hosts.tsx`

**Interfaces:**
- Consumes: Task 9 的 API 客户端（`createHost`/`updateHost`/`activateHost(id)`/`disableHost`/`enableHost`/`fetchHostStatsById`）与 `lib/hosts.ts`

本任务在既有页面结构上增量修改，不重写整页。

- [ ] **Step 1: 修 activate 调用**

页面里 `activate` mutation 原先传 `mode`，改为：

```tsx
  const activate = useMutation({
    mutationFn: (id: number) => activateHost(id),
    onSuccess: () => {
      toast.success('已设为参考主机')
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
```

对应按钮文案由「切换到此主机」改为「设为参考主机」，并移除原先的 wait/interrupt 模式选择对话框（该选择迁移到停用）。

- [ ] **Step 2: 加参与调度开关与停用对话框**

在主机卡片的操作区加入：

```tsx
{host.enabled === 1 ? (
  <Button size="sm" variant="outline" onClick={() => setDisabling(host)}>
    停用调度
  </Button>
) : (
  <Button size="sm" variant="outline" onClick={() => enable.mutate(host.id)}>
    参与调度
  </Button>
)}
```

页面组件内新增状态与 mutation：

```tsx
  const [disabling, setDisabling] = useState<HostDto | null>(null)

  const enable = useMutation({
    mutationFn: (id: number) => enableHost(id),
    onSuccess: () => {
      toast.success('已加入调度')
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    },
  })

  const disable = useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: 'wait' | 'interrupt' }) => disableHost(id, mode),
    onSuccess: () => {
      toast.success('已停用调度')
      setDisabling(null)
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
```

在页面末尾（与既有对话框并列）加停用对话框：

```tsx
<Dialog open={disabling !== null} onOpenChange={(v) => !v && setDisabling(null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>停用「{disabling?.name}」的调度</DialogTitle>
      <DialogDescription>
        停用后该主机不再接新任务。它当前正在执行的任务如何处理？
      </DialogDescription>
    </DialogHeader>
    <DialogFooter className="flex-col gap-2 sm:flex-row">
      <Button
        variant="outline"
        disabled={disable.isPending}
        onClick={() => disabling && disable.mutate({ id: disabling.id, mode: 'wait' })}
      >
        等当前任务跑完
      </Button>
      <Button
        variant="destructive"
        disabled={disable.isPending}
        onClick={() => disabling && disable.mutate({ id: disabling.id, mode: 'interrupt' })}
      >
        立即放弃并重排
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 3: 显示自动停用原因与在线状态**

主机卡片标题区加标记：

```tsx
{host.enabled !== 1 && host.disabledReason && (
  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
    已自动停用：{host.disabledReason}
  </span>
)}
{host.active === 1 && (
  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">参考主机</span>
)}
<span
  className={cn(
    'inline-flex size-2 rounded-full',
    host.online === true ? 'bg-success' : host.online === false ? 'bg-destructive' : 'bg-muted-foreground',
  )}
/>
```

- [ ] **Step 4: 租用主机信息**

卡片内加（仅租用型显示）：

```tsx
{host.kind === 'rental' && host.rentedAt && (
  <p className="text-xs text-muted-foreground">
    已运行 {formatDuration(rentalMinutes(host.rentedAt, Date.now()))}
    {host.hourlyRate != null &&
      ` · 估算 ${rentalCost(host.rentedAt, host.hourlyRate, Date.now())!.toFixed(2)}`}
  </p>
)}
```

导入补 `import { formatDuration, rentalCost, rentalMinutes } from '@/lib/hosts'`。

- [ ] **Step 5: 表单加形态字段**

`HostForm` 内新增受控状态与字段：

```tsx
  const [kind, setKind] = useState<'resident' | 'rental'>(initial?.kind ?? 'resident')
  const [rentedAt, setRentedAt] = useState(initial?.rentedAt?.slice(0, 16) ?? '')
  const [hourlyRate, setHourlyRate] = useState(
    initial?.hourlyRate != null ? String(initial.hourlyRate) : '',
  )
```

```tsx
<div className="space-y-1">
  <Label>形态</Label>
  <Select value={kind} onValueChange={(v) => setKind(v as 'resident' | 'rental')}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="resident">常驻</SelectItem>
      <SelectItem value="rental">按小时租用</SelectItem>
    </SelectContent>
  </Select>
</div>
{kind === 'rental' && (
  <>
    <div className="space-y-1">
      <Label>起租时间</Label>
      <Input type="datetime-local" value={rentedAt} onChange={(e) => setRentedAt(e.target.value)} />
    </div>
    <div className="space-y-1">
      <Label>时薪（选填，不填只显示时长）</Label>
      <Input
        type="number"
        min={0}
        step="0.01"
        value={hourlyRate}
        onChange={(e) => setHourlyRate(e.target.value)}
      />
    </div>
  </>
)}
```

提交时组装（起租时间留空则用当前时间；常驻型把租用字段清空）：

```tsx
const payload = {
  name,
  url,
  note: note || null,
  kind,
  rentedAt: kind === 'rental' ? new Date(rentedAt || Date.now()).toISOString() : null,
  hourlyRate: kind === 'rental' && hourlyRate !== '' ? Number(hourlyRate) : null,
}
```

- [ ] **Step 6: 删除主机时的锁定警告**

删除确认对话框内加：

```tsx
{deleting != null && deleting.pinnedBatches > 0 && (
  <p className="text-sm text-warning">
    有 {deleting.pinnedBatches} 个未完成批次锁定在这台主机上，删除后它们将无人执行。
  </p>
)}
```

- [ ] **Step 7: 每主机独立 stats**

卡片里的 stats 查询由全局 `['host-stats']` 改为按 id：

```tsx
  const { data: stats } = useQuery({
    queryKey: ['host-stats', host.id],
    queryFn: () => fetchHostStatsById(host.id),
    enabled: host.online === true,
    staleTime: 30_000,
  })
```

- [ ] **Step 8: 验证**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web test && pnpm --filter @cwe/web build`
Expected: 全部通过。

构建产物核查（Tailwind 任意值陷阱）：如本任务引入了带 `calc(` 的任意值类名，执行
`grep -o 'calc([^)]*)' apps/web/dist/assets/*.css | sort -u` 确认生成的是带空格的合法 CSS。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/pages/hosts.tsx
git commit -m "$(cat <<'EOF'
feat(web): 主机页支持参与调度开关、停用双模式与租用形态

「切换到此主机」改为「设为参考主机」(不再中断任务,故无模式选择);停用对话框
提供「等当前任务跑完」/「立即放弃并重排」;自动停用标注原因;租用主机显示已
运行时长与估算费用;删除前提示锁定批次数;stats 查询改为按主机 id。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: 批次页锁定提示与参考主机降级

**Files:**
- Modify: `apps/web/src/pages/batch-detail.tsx`
- Modify: `apps/web/src/pages/batch-new.tsx`
- Modify: `apps/web/src/pages/template-import.tsx`

**Interfaces:**
- Consumes: Task 9 的 `useHosts()`；batch 详情响应中的 `pinnedHostId`

- [ ] **Step 1: 服务端补返回 pinnedHostId**

确认 `GET /api/batches/:id` 的响应里 batch 对象含 `pinnedHostId`（`repo.getBatchDetail` 直接 select 整行，Task 1 加列后自动带上）。前端类型 `BatchDetailDto` 的 batch 字段补 `pinnedHostId: number | null`。

- [ ] **Step 2: batch-detail 加锁定提示**

在页头下方、画廊上方插入：

```tsx
{batch.pinnedHostId != null &&
  (() => {
    const pinned = hosts?.find((h) => h.id === batch.pinnedHostId)
    const usable = pinned && pinned.enabled === 1 && pinned.online === true
    if (usable) return null
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
        本批次锁定在主机「{pinned?.name ?? `#${batch.pinnedHostId}`}」
        {pinned == null
          ? '（该主机已被删除）'
          : pinned.enabled !== 1
            ? '（该主机未参与调度）'
            : '（该主机离线）'}
        ，任务暂时无人执行。
      </div>
    )
  })()}
```

组件内加 `const hosts = useHosts()`，导入 `import { useHosts } from '@/hooks/use-comfy-status'`。

> 为什么必须有这个提示：锁定主机不可用时批次会永远无人认领，没有提示的话表现为「任务卡住不动、毫无线索」。

- [ ] **Step 3: batch-new 加锁定预告**

建批表单在「有 image 参数且所选值不是本次上传的本地文件」时提示。由于前端无法可靠判断文件是否在服务端 uploads 中，改为**建批成功后**依据返回的 `pinnedHostId` 提示：

```tsx
  const submit = useMutation({
    mutationFn: () => createBatch(templateId, { name, jobs }),
    onSuccess: (batch) => {
      if (batch.pinnedHostId != null) {
        toast.info('本批次引用了 GPU 主机上的文件，将只在该主机执行')
      }
      navigate(`/batches/${batch.id}`)
    },
  })
```

（保留既有 `onSuccess` 的其他逻辑，如输入历史缓存失效；`createBatch` 的返回类型补 `pinnedHostId: number | null`。）

- [ ] **Step 4: 模板导入页的参考主机降级提示**

模板导入依赖 `/comfy/convert` 与 `/comfy/validate`，二者都打到**参考主机**。spec 明确规定参考主机离线时**不自动回退**到其他在线主机——不同主机装的模型/节点可能不同，静默换一台会让用户选到目标主机上并不存在的模型，错误要到执行时才炸。因此必须把不可用状态显式说出来。

在 `apps/web/src/pages/template-import.tsx` 页面顶部插入：

```tsx
{reference && reference.online === false && (
  <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
    参考主机「{reference.name}」离线，模型列表与节点校验暂不可用。
    <Link to="/hosts" className="ml-1 underline">
      切换参考主机
    </Link>
  </div>
)}
```

组件内加：

```tsx
  const hosts = useHosts()
  const reference = hosts ? referenceHost(hosts) : undefined
```

导入补：

```tsx
import { Link } from 'react-router-dom'
import { useHosts } from '@/hooks/use-comfy-status'
import { referenceHost } from '@/lib/hosts'
```

（`Link` 若已从 `react-router-dom` 导入则合并到既有那行。）

- [ ] **Step 5: 验证**

Run: `pnpm -r typecheck && pnpm -r test && pnpm --filter @cwe/web build`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages
git commit -m "$(cat <<'EOF'
feat(web): 批次页提示主机锁定状态,导入页提示参考主机离线

锁定主机被删除/停用/离线时,批次会永远无人认领,没有提示就只表现为「任务卡住
不动」。详情页显式给出原因;建批成功若命中锁定则 toast 说明。参考主机离线时
导入页明确降级(按 spec 不自动回退到其他主机:各主机模型不同,静默换一台会让
用户选到目标主机上不存在的模型)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 手动验收清单

实施完成后由用户在真实环境验证（web 包不写渲染测试）：

- [ ] 两台主机都「参与调度」时，提交一批任务，两台**同时**在跑（batch 详情的「主机」列出现两个不同主机名）
- [ ] 停用其中一台选「等当前任务跑完」：该主机手上的任务正常完成，之后不再接新活
- [ ] 停用其中一台选「立即放弃并重排」：该任务回到 pending 并很快由另一台主机重跑
- [ ] 拔掉一台主机的网络（或停掉 ComfyUI）约 2 分钟：它手上的任务自动回池并由另一台接手，batch 最终能完成
- [ ] 故意让一台主机缺模型（模板引用它没有的 checkpoint）：连续 3 个任务失败后该主机自动停用，页面出现 toast 与「已自动停用」标记，剩余任务由健康主机跑完
- [ ] 所有主机都停用时，batch 详情出现「所有主机均已停用调度」提示与前往主机管理的入口
- [ ] 「设为参考主机」切换时，正在跑的并行任务**不中断**
- [ ] 参考主机离线时，模板导入的模型下拉不可用并有明确提示（不会静默取到别的主机的模型列表）
- [ ] 用「GPU 侧已有文件」作为 image 参数建批：建批后 toast 提示锁定，且该批次只在那台主机执行
- [ ] 把锁定主机停用：batch 详情出现「本批次锁定在主机 X（该主机未参与调度）」提示
- [ ] 添加一台「按小时租用」主机：hosts 页显示已运行时长；填了时薪则显示估算费用
- [ ] 租用主机空闲 5 分钟后出现「仍在计费中，考虑下线」toast
- [ ] 数据导入（备份恢复）后，worker 按导入库的 hosts 表重建，任务继续执行
- [ ] 单主机用户升级后行为不变（唯一主机 enabled=1 且为参考主机）

## 部署提醒

- 无新依赖、无 comfyui-cwe 扩展变更
- 数据库迁移随服务启动自动执行
- 部署：`git pull && docker compose up --build -d`
