# Templates / Batches 表格交互增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两个列表页升级为支持多选/全选/批量操作、搜索过滤、列排序、分页、列显隐、（仅 Templates）拖拽持久化排序的数据表。

**Architecture:** 服务端加 templates.sort_order + PATCH /order 与 DELETE /api/batches/:id(?purgeOutputs=1)；前端引入 @tanstack/react-table（shadcn data-table 官方底座）+ dnd-kit，搭一套共享 `components/data-table/` 基建，两个页面只写列定义与批量操作；数据操作全在客户端。批量操作复用单项端点、客户端 `Promise.allSettled` 并发汇总。

**Tech Stack:** Hono + drizzle/better-sqlite3（服务端）；React 19 + @tanstack/react-table + @dnd-kit + shadcn/ui（radix-ui 统一包 v1.6.5，已有）+ lucide-react（已有）。

**Spec:** `docs/superpowers/specs/2026-07-24-table-interactions-design.md`

## Global Constraints

- pnpm 11 monorepo；不改 pnpm-workspace.yaml 的 allowBuilds；不设仓库级 minimum-release-age
- ESM + TS strict；测试用 vitest（离线，不依赖真实 ComfyUI）
- shadcn 组件 import 风格：`import { X as XPrimitive } from "radix-ui"`（统一包，非 @radix-ui/react-*），函数组件 + data-slot 属性（参照现有 `apps/web/src/components/ui/select.tsx`）
- `apps/web/src/lib/api.ts` 的 `api()` 对非 2xx 抛 `Error(await res.text())`——错误信息是响应体 JSON 文本
- 中文 UI 文案；commit message 英文，结尾 trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 每个任务完成后：对应包测试 + `tsc --noEmit` 全绿才 commit

---

### Task 1: server — templates.sort_order 迁移 + 排序读取 + PATCH /order

**Files:**
- Modify: `apps/server/src/db/index.ts`（DDL + 迁移守卫）
- Modify: `apps/server/src/db/schema.ts`（templates 加 sortOrder 列）
- Modify: `apps/server/src/db/repo.ts`（createTemplate/listTemplates/reorderTemplates）
- Modify: `apps/server/src/routes/templates.ts`（PATCH /order）
- Test: `apps/server/test/repo.test.ts`、`apps/server/test/routes.test.ts`

**Interfaces:**
- Consumes: 现有 `repo.createTemplate/listTemplates`、`templateRoutes`
- Produces: `repo.reorderTemplates(db, ids: number[]): 'ok' | 'unknown-id' | 'incomplete'`；`PATCH /api/templates/order` body `{ ids: number[] }` → 200 `{ok:true}` / 400 / 404；`GET /api/templates` 按 sort_order 升序；Template 类型新增 `sortOrder: number`（前端 TemplateDto 在 Task 6 同步）

- [ ] **Step 1: 写失败测试（repo 层）**

在 `apps/server/test/repo.test.ts` 追加（文件已有 `createDb(':memory:')` 与 `repo` 导入，沿用现有测试的写法）：

```ts
describe('template sort_order', () => {
  it('新建模板追加到末尾, listTemplates 按 sort_order 返回', () => {
    const a = repo.createTemplate(db, { name: 'A', comfyJson: {}, params: [] })
    const b = repo.createTemplate(db, { name: 'B', comfyJson: {}, params: [] })
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder)
    expect(repo.listTemplates(db).map((t) => t.name)).toEqual(['A', 'B'])
  })

  it('reorderTemplates 持久化新顺序', () => {
    const a = repo.createTemplate(db, { name: 'A', comfyJson: {}, params: [] })
    const b = repo.createTemplate(db, { name: 'B', comfyJson: {}, params: [] })
    const c = repo.createTemplate(db, { name: 'C', comfyJson: {}, params: [] })
    expect(repo.reorderTemplates(db, [c.id, a.id, b.id])).toBe('ok')
    expect(repo.listTemplates(db).map((t) => t.name)).toEqual(['C', 'A', 'B'])
  })

  it('reorderTemplates 拒绝未知 id 与不完整列表', () => {
    const a = repo.createTemplate(db, { name: 'A', comfyJson: {}, params: [] })
    repo.createTemplate(db, { name: 'B', comfyJson: {}, params: [] })
    expect(repo.reorderTemplates(db, [a.id, 999])).toBe('unknown-id')
    expect(repo.reorderTemplates(db, [a.id])).toBe('incomplete')
    expect(repo.reorderTemplates(db, [a.id, a.id])).toBe('incomplete')
  })
})
```

注意：`repo.test.ts` 的 `db` 变量与 beforeEach 已存在，直接用；若该文件用其他变量名，按现有名对齐。

再写旧库迁移测试（同文件追加，需要 `mkdtempSync`/`tmpdir`/`join` 导入，参照 executor.test.ts 的导入方式；另需 `import Database from 'better-sqlite3'` 与 `import { createDb } from '../src/db/index.js'`——repo.test.ts 顶部若已导入 createDb 则复用）：

```ts
describe('sort_order migration', () => {
  it('旧库(无 sort_order 列)打开时自动迁移并按 id 初始化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwe-mig-'))
    const path = join(dir, 'old.db')
    const raw = new Database(path)
    raw.exec(`CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      comfy_json TEXT NOT NULL,
      params TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`)
    raw.prepare(`INSERT INTO templates (name, comfy_json, params) VALUES ('old', '{}', '[]')`).run()
    raw.close()
    const migrated = createDb(path)
    const rows = repo.listTemplates(migrated)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sortOrder).toBe(rows[0]!.id)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/repo.test.ts`
Expected: FAIL（sortOrder 不存在 / reorderTemplates 未定义）

- [ ] **Step 3: 实现**

`apps/server/src/db/index.ts` — DDL 中 templates 表定义加一行，并在 `sqlite.exec(DDL)` 之后加迁移守卫：

```ts
// DDL 里 templates 表改为:
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  comfy_json TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

```ts
export function createDb(path: string) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  // 旧库迁移:补 sort_order 列并按 id 初始化(保持既有展示顺序)
  const cols = sqlite.prepare(`PRAGMA table_info(templates)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'sort_order')) {
    sqlite.exec(`ALTER TABLE templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
    sqlite.exec(`UPDATE templates SET sort_order = id`)
  }
  return drizzle(sqlite, { schema })
}
```

`apps/server/src/db/schema.ts` — templates 表加列（createdAt 之后）：

```ts
  sortOrder: integer('sort_order').notNull().default(0),
```

`apps/server/src/db/repo.ts` — 三处：

```ts
export function createTemplate(db: Db, input: CreateTemplateInput): Template {
  return db.transaction((tx) => {
    const max = tx
      .select({ m: sql<number>`coalesce(max(${templates.sortOrder}), 0)` })
      .from(templates)
      .get()
    return tx
      .insert(templates)
      .values({ ...input, sortOrder: (max?.m ?? 0) + 1 })
      .returning()
      .get()
  })
}

export function listTemplates(db: Db): Template[] {
  return db.select().from(templates).orderBy(asc(templates.sortOrder), asc(templates.id)).all()
}

/** 全量重排:ids 必须恰好覆盖全部模板且不重复 */
export function reorderTemplates(db: Db, ids: number[]): 'ok' | 'unknown-id' | 'incomplete' {
  return db.transaction((tx) => {
    const existing = tx.select({ id: templates.id }).from(templates).all().map((r) => r.id)
    const known = new Set(existing)
    if (ids.some((id) => !known.has(id))) return 'unknown-id'
    if (ids.length !== existing.length || new Set(ids).size !== ids.length) return 'incomplete'
    ids.forEach((id, i) => {
      tx.update(templates).set({ sortOrder: i + 1 }).where(eq(templates.id, id)).run()
    })
    return 'ok'
  })
}
```

`apps/server/src/routes/templates.ts` — 在 `app.get('/')` 之后加：

```ts
  app.patch('/order', async (c) => {
    const body = (await c.req.json()) as { ids?: unknown }
    const ids =
      Array.isArray(body?.ids) && body.ids.every((n): n is number => typeof n === 'number')
        ? body.ids
        : null
    if (!ids) return c.json({ error: 'ids 必须是数字数组' }, 400)
    const res = repo.reorderTemplates(deps.db, ids)
    if (res === 'unknown-id') return c.json({ error: '包含不存在的模板 id' }, 404)
    if (res === 'incomplete') return c.json({ error: 'ids 必须包含全部模板且不重复' }, 400)
    return c.json({ ok: true })
  })
```

- [ ] **Step 4: 写路由测试**

`apps/server/test/routes.test.ts` 追加（沿用文件顶部的 `app`/`H`/`createTemplate` 辅助）：

```ts
describe('PATCH /api/templates/order', () => {
  it('重排后 GET 按新顺序返回', async () => {
    const a = await createTemplate()
    const res2 = await app.request('/api/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...templateBody, name: 'T2' }),
    })
    const b = (await res2.json()) as { id: number }
    const patch = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [b.id, a.id] }),
    })
    expect(patch.status).toBe(200)
    const list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list.map((t) => t.id)).toEqual([b.id, a.id])
  })

  it('非法 body 400, 未知 id 404, 不完整 400', async () => {
    const a = await createTemplate()
    const bad = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: 'x' }),
    })
    expect(bad.status).toBe(400)
    const unknown = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [a.id, 999] }),
    })
    expect(unknown.status).toBe(404)
    const incomplete = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [] }),
    })
    expect(incomplete.status).toBe(400)
  })
})
```

- [ ] **Step 5: 全绿验证**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): persistent template ordering with sort_order and PATCH /order"
```

---

### Task 2: server — DELETE /api/batches/:id（含 purgeOutputs）

**Files:**
- Modify: `apps/server/src/db/repo.ts`（deleteBatch）
- Modify: `apps/server/src/routes/batches.ts`（DELETE /:id）
- Test: `apps/server/test/routes.test.ts`

**Interfaces:**
- Consumes: `deps.config.dataDir`（输出目录根，`outputs/<batchId>/`）；现有 batches/jobs 表（jobs.batch_id 有 FK、无级联，须先删 jobs）
- Produces: `repo.deleteBatch(db, id): 'ok' | 'not-found' | 'running'`；`DELETE /api/batches/:id?purgeOutputs=1` → 200 `{ok:true, purgeFailed?:true}` / 404 / 409 `{error:'batch is running'}`；成功后 emit `{ type: 'batch-updated', batchId: id, status: 'deleted' }`（前端 useEvents 对任意 batch-updated 都 invalidate ['batches']，无需改动）

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes.test.ts` 追加。purge 测试需要真实 dataDir：文件顶部导入区补 `import { mkdirSync, mkdtempSync, existsSync } from 'node:fs'`、`import { writeFileSync } from 'node:fs'`、`import { tmpdir } from 'node:os'`、`import { join } from 'node:path'`（与现有导入合并，不重复）：

```ts
describe('DELETE /api/batches/:id', () => {
  async function makeBatch() {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    return (await res.json()) as { id: number }
  }

  it('删除 pending batch 及其 jobs', async () => {
    const b = await makeBatch()
    const del = await app.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    expect((await app.request(`/api/batches/${b.id}`, { headers: H })).status).toBe(404)
  })

  it('running batch 返回 409', async () => {
    const b = await makeBatch()
    // 直接用 repo 把 batch 置为 running(模拟执行器认领)
    const { claimNextJob } = await import('../src/db/repo.js')
    claimNextJob(db)
    const del = await app.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(409)
    expect(await del.json()).toEqual({ error: 'batch is running' })
  })

  it('未知 id 404', async () => {
    const del = await app.request('/api/batches/999', { method: 'DELETE', headers: H })
    expect(del.status).toBe(404)
  })

  it('purgeOutputs=1 时清理输出目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-del-'))
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: localDb, comfy: null, events: new EventEmitter(),
    })
    const t = await localApp.request('/api/templates', {
      method: 'POST', headers: H, body: JSON.stringify(templateBody),
    })
    const tid = ((await t.json()) as { id: number }).id
    const bRes = await localApp.request(`/api/templates/${tid}/batches`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const bid = ((await bRes.json()) as { id: number }).id
    const outDir = join(dataDir, 'outputs', String(bid))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'x.png'), 'png')
    const del = await localApp.request(`/api/batches/${bid}?purgeOutputs=1`, {
      method: 'DELETE', headers: H,
    })
    expect(del.status).toBe(200)
    expect(existsSync(outDir)).toBe(false)
  })

  it('不带 purgeOutputs 时输出目录保留', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-keep-'))
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: localDb, comfy: null, events: new EventEmitter(),
    })
    const t = await localApp.request('/api/templates', {
      method: 'POST', headers: H, body: JSON.stringify(templateBody),
    })
    const tid = ((await t.json()) as { id: number }).id
    const bRes = await localApp.request(`/api/templates/${tid}/batches`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const bid = ((await bRes.json()) as { id: number }).id
    const outDir = join(dataDir, 'outputs', String(bid))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'x.png'), 'png')
    const del = await localApp.request(`/api/batches/${bid}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    expect(existsSync(outDir)).toBe(true)
  })
})
```

注意：running 测试里 `db` 是文件级 beforeEach 建的 in-memory db（与 `app` 同源）；`claimNextJob` 也可以直接加到顶部 `import * as repo` 后用 `repo.claimNextJob(db)`——如果文件已有 repo 导入就用它，没有则按上面动态 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/routes.test.ts`
Expected: FAIL（DELETE 返回 404 not found——路由不存在）

- [ ] **Step 3: 实现**

`apps/server/src/db/repo.ts` 追加（batches 区）：

```ts
/** 状态检查与删除同事务,避免与执行器认领竞态;jobs 无级联须先删 */
export function deleteBatch(db: Db, id: number): 'ok' | 'not-found' | 'running' {
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, id)).get()
    if (!batch) return 'not-found'
    if (batch.status === 'running') return 'running'
    tx.delete(jobs).where(eq(jobs.batchId, id)).run()
    tx.delete(batches).where(eq(batches.id, id)).run()
    return 'ok'
  })
}
```

`apps/server/src/routes/batches.ts` — 顶部加 `import { rm } from 'node:fs/promises'` 和 `import { join } from 'node:path'`，`app.get('/:id')` 之后加：

```ts
  app.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const res = repo.deleteBatch(deps.db, id)
    if (res === 'not-found') return c.json({ error: 'batch not found' }, 404)
    if (res === 'running') return c.json({ error: 'batch is running' }, 409)
    let purgeFailed = false
    if (c.req.query('purgeOutputs') === '1') {
      try {
        await rm(join(deps.config.dataDir, 'outputs', String(id)), { recursive: true, force: true })
      } catch {
        purgeFailed = true
      }
    }
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'deleted' })
    return c.json(purgeFailed ? { ok: true, purgeFailed: true } : { ok: true })
  })
```

- [ ] **Step 4: 全绿验证**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): DELETE /api/batches/:id with optional output purge"
```

---

### Task 3: web — 依赖 + shadcn 组件（checkbox / dropdown-menu / alert-dialog）

**Files:**
- Modify: `apps/web/package.json`（pnpm add）
- Create: `apps/web/src/components/ui/checkbox.tsx`
- Create: `apps/web/src/components/ui/dropdown-menu.tsx`
- Create: `apps/web/src/components/ui/alert-dialog.tsx`

**Interfaces:**
- Consumes: `radix-ui` 统一包（已装 v1.6.5）、`lucide-react`、`@/lib/utils` 的 `cn`、`@/components/ui/button` 的 `buttonVariants`
- Produces: `Checkbox`；`DropdownMenu/DropdownMenuTrigger/DropdownMenuContent/DropdownMenuItem/DropdownMenuCheckboxItem/DropdownMenuLabel/DropdownMenuSeparator`；`AlertDialog/AlertDialogTrigger/AlertDialogContent/AlertDialogHeader/AlertDialogFooter/AlertDialogTitle/AlertDialogDescription/AlertDialogAction/AlertDialogCancel`——Task 5-7 直接 import
- 新依赖：`@tanstack/react-table`、`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/modifiers`、`@dnd-kit/utilities`（Task 5 用，这里一次装齐）

- [ ] **Step 1: 安装依赖**

```bash
pnpm --filter @cwe/web add @tanstack/react-table @dnd-kit/core @dnd-kit/sortable @dnd-kit/modifiers @dnd-kit/utilities
```

- [ ] **Step 2: 创建 checkbox.tsx**

```tsx
import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
```

- [ ] **Step 3: 创建 dropdown-menu.tsx**

```tsx
import * as React from "react"
import { CheckIcon } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-md",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 text-sm font-medium", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
}
```

- [ ] **Step 4: 创建 alert-dialog.tsx**

```tsx
import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} {...props} />
  )
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
```

- [ ] **Step 5: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS（新组件尚无使用方，typecheck/build 通过即可）

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add react-table + dnd-kit deps and checkbox/dropdown-menu/alert-dialog components"
```

---

### Task 4: web — 批量操作纯逻辑 lib + 测试

**Files:**
- Create: `apps/web/src/lib/bulk.ts`
- Test: `apps/web/src/lib/bulk.test.ts`

**Interfaces:**
- Consumes: `@cwe/shared` 的 `BatchStatus`
- Produces（Task 6/7 直接 import）:
  - `apiErrorText(e: unknown): string`
  - `runBulk<T>(items: T[], name: (t: T) => string, fn: (t: T) => Promise<unknown>): Promise<BulkResult>`，`BulkResult = { ok: number; failed: Array<{ name: string; message: string }> }`
  - `summarizeBulk(action: string, r: BulkResult): string`
  - `batchBulkActions(selected: Array<{ status: BatchStatus; failed: number }>): { cancel: boolean; retry: boolean; del: boolean }`

- [ ] **Step 1: 写失败测试**

`apps/web/src/lib/bulk.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { apiErrorText, batchBulkActions, runBulk, summarizeBulk } from './bulk'

describe('apiErrorText', () => {
  it('解析 JSON 响应体错误', () => {
    expect(apiErrorText(new Error('{"error":"batch is running"}'))).toBe('batch is running')
  })
  it('非 JSON 原样返回', () => {
    expect(apiErrorText(new Error('network down'))).toBe('network down')
  })
})

describe('runBulk + summarizeBulk', () => {
  it('全成功', async () => {
    const r = await runBulk([1, 2], String, async () => 'ok')
    expect(r).toEqual({ ok: 2, failed: [] })
    expect(summarizeBulk('删除', r)).toBe('删除成功 2 个')
  })
  it('部分失败不中断其余, 汇总含原因', async () => {
    const r = await runBulk([1, 2, 3], (n) => `B${n}`, async (n) => {
      if (n === 2) throw new Error('{"error":"batch is running"}')
    })
    expect(r.ok).toBe(2)
    expect(r.failed).toEqual([{ name: 'B2', message: 'batch is running' }])
    expect(summarizeBulk('删除', r)).toBe('删除成功 2 个，失败 1 个：B2(batch is running)')
  })
})

describe('batchBulkActions', () => {
  it('按选中项状态判定按钮启停', () => {
    expect(batchBulkActions([])).toEqual({ cancel: false, retry: false, del: false })
    expect(batchBulkActions([{ status: 'completed', failed: 0 }])).toEqual({
      cancel: false, retry: false, del: true,
    })
    expect(batchBulkActions([{ status: 'running', failed: 0 }])).toEqual({
      cancel: true, retry: false, del: true,
    })
    expect(
      batchBulkActions([
        { status: 'completed', failed: 2 },
        { status: 'pending', failed: 0 },
      ]),
    ).toEqual({ cancel: true, retry: true, del: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/web exec vitest run src/lib/bulk.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 bulk.ts**

```ts
import type { BatchStatus } from '@cwe/shared'

export interface BulkResult {
  ok: number
  failed: Array<{ name: string; message: string }>
}

/** api() 抛出的 Error message 是响应体 JSON 文本,提取其中的 error 字段 */
export function apiErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(msg) as { error?: string }
    return parsed.error ?? msg
  } catch {
    return msg
  }
}

/** 并发执行,部分失败不中断其余项 */
export async function runBulk<T>(
  items: T[],
  name: (item: T) => string,
  fn: (item: T) => Promise<unknown>,
): Promise<BulkResult> {
  const settled = await Promise.allSettled(items.map(fn))
  const failed: BulkResult['failed'] = []
  settled.forEach((s, i) => {
    if (s.status === 'rejected') failed.push({ name: name(items[i]!), message: apiErrorText(s.reason) })
  })
  return { ok: items.length - failed.length, failed }
}

export function summarizeBulk(action: string, r: BulkResult): string {
  if (r.failed.length === 0) return `${action}成功 ${r.ok} 个`
  const detail = r.failed.map((f) => `${f.name}(${f.message})`).join('、')
  return `${action}成功 ${r.ok} 个，失败 ${r.failed.length} 个：${detail}`
}

/** 选中批次决定批量按钮启停 */
export function batchBulkActions(
  selected: Array<{ status: BatchStatus; failed: number }>,
): { cancel: boolean; retry: boolean; del: boolean } {
  return {
    cancel: selected.some((b) => b.status === 'pending' || b.status === 'running'),
    retry: selected.some((b) => b.failed > 0),
    del: selected.length > 0,
  }
}
```

- [ ] **Step 4: 全绿验证**

Run: `pnpm --filter @cwe/web test && pnpm --filter @cwe/web exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib
git commit -m "feat(web): bulk operation helpers with per-item failure summary"
```

---

### Task 5: web — data-table 共享基建

**Files:**
- Create: `apps/web/src/components/data-table/data-table.tsx`
- Create: `apps/web/src/components/data-table/data-table-toolbar.tsx`
- Create: `apps/web/src/components/data-table/data-table-pagination.tsx`
- Create: `apps/web/src/components/data-table/sortable-rows.tsx`

**Interfaces:**
- Consumes: Task 3 的依赖与 ui 组件；现有 `@/components/ui/{table,input,button,select}`
- Produces（Task 6/7 直接 import）:
  - `DataTable<TData>` props: `{ columns: ColumnDef<TData, any>[]; data: TData[]; getRowId: (row: TData) => string; searchPlaceholder?: string; emptyText?: string; toolbarSlot?: (table: TanstackTable<TData>) => ReactNode; bulkSlot?: (table: TanstackTable<TData>) => ReactNode; reorder?: { onReorder: (ids: string[]) => void } }`
  - `SortableHeader`（列头排序按钮）、`selectColumn<TData>()`（勾选列 ColumnDef）
  - `DragHandle`（拖拽手柄，供 reorder 表的列定义用）
  - 约定：列定义用 `meta: { title: '中文名' }` 供列显隐菜单展示；仅名称列设 `enableGlobalFilter: true`，其余列 `enableGlobalFilter: false`

- [ ] **Step 1: 创建 sortable-rows.tsx**

```tsx
import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { flexRender, type Row } from '@tanstack/react-table'
import { GripVerticalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TableCell, TableRow } from '@/components/ui/table'

/** 列排序/搜索/过滤激活时置 true,由 DataTable 提供 */
export const DndDisabledContext = React.createContext(false)

export function DragHandle({ id }: { id: string }) {
  const disabled = React.useContext(DndDisabledContext)
  const { attributes, listeners } = useSortable({ id, disabled })
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      title={disabled ? '排序或过滤激活时不可拖拽' : '拖拽调整顺序'}
      className="size-7 cursor-grab p-0 text-muted-foreground"
      {...attributes}
      {...(disabled ? {} : listeners)}
    >
      <GripVerticalIcon className="size-4" />
    </Button>
  )
}

export function SortableRow<TData>({ row }: { row: Row<TData> }) {
  const { setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  return (
    <TableRow
      ref={setNodeRef}
      data-state={row.getIsSelected() && 'selected'}
      className={isDragging ? 'relative z-10 opacity-80' : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
      ))}
    </TableRow>
  )
}
```

- [ ] **Step 2: 创建 data-table-pagination.tsx**

```tsx
import type { Table as TanstackTable } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function DataTablePagination<TData>({ table }: { table: TanstackTable<TData> }) {
  const { pageIndex, pageSize } = table.getState().pagination
  const total = table.getFilteredRowModel().rows.length
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>共 {total} 条</span>
      <div className="flex items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
          <SelectTrigger size="sm" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[20, 50].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} / 页
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          上一页
        </Button>
        <span>
          {pageIndex + 1} / {Math.max(table.getPageCount(), 1)}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 创建 data-table-toolbar.tsx**

```tsx
import type { ReactNode } from 'react'
import type { Table as TanstackTable } from '@tanstack/react-table'
import { Settings2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

export function DataTableViewOptions<TData>({ table }: { table: TanstackTable<TData> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Settings2Icon className="mr-1 size-4" />列
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {table
          .getAllColumns()
          .filter((c) => c.getCanHide())
          .map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              onCheckedChange={(v) => column.toggleVisibility(!!v)}
            >
              {(column.columnDef.meta as { title?: string } | undefined)?.title ?? column.id}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DataTableToolbar<TData>({
  table,
  searchPlaceholder,
  toolbarSlot,
  bulkSlot,
}: {
  table: TanstackTable<TData>
  searchPlaceholder?: string
  toolbarSlot?: (table: TanstackTable<TData>) => ReactNode
  bulkSlot?: (table: TanstackTable<TData>) => ReactNode
}) {
  const selected = table.getFilteredSelectedRowModel().rows.length
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder={searchPlaceholder ?? '搜索…'}
        value={(table.getState().globalFilter as string) ?? ''}
        onChange={(e) => table.setGlobalFilter(e.target.value)}
        className="h-8 w-56"
      />
      {toolbarSlot?.(table)}
      <div className="ml-auto flex items-center gap-2">
        {selected > 0 && <span className="text-sm text-muted-foreground">已选 {selected} 项</span>}
        {bulkSlot?.(table)}
        <DataTableViewOptions table={table} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 data-table.tsx**

```tsx
import * as React from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type RowSelectionState,
  type SortingState,
  type Table as TanstackTable,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTablePagination } from './data-table-pagination'
import { DataTableToolbar } from './data-table-toolbar'
import { DndDisabledContext, SortableRow } from './sortable-rows'

export function SortableHeader<TData>({
  column,
  children,
}: {
  column: Column<TData, unknown>
  children: React.ReactNode
}) {
  const dir = column.getIsSorted()
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-8"
      onClick={() => column.toggleSorting(dir === 'asc')}
    >
      {children}
      {dir === 'asc' ? (
        <ArrowUpIcon className="ml-1 size-3.5" />
      ) : dir === 'desc' ? (
        <ArrowDownIcon className="ml-1 size-3.5" />
      ) : (
        <ArrowUpDownIcon className="ml-1 size-3.5" />
      )}
    </Button>
  )
}

/** 勾选列:表头全选作用于过滤后的全部行(跨页) */
export function selectColumn<TData>(): ColumnDef<TData> {
  return {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && 'indeterminate')
        }
        onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
        aria-label="全选"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
        aria-label="选择行"
      />
    ),
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  }
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[]
  data: TData[]
  getRowId: (row: TData) => string
  searchPlaceholder?: string
  emptyText?: string
  toolbarSlot?: (table: TanstackTable<TData>) => React.ReactNode
  bulkSlot?: (table: TanstackTable<TData>) => React.ReactNode
  /** 提供即启用行拖拽(仅在无排序/搜索/过滤时可拖);onReorder 收到过滤前完整 id 新顺序 */
  reorder?: { onReorder: (ids: string[]) => void }
}

export function DataTable<TData>({
  columns,
  data,
  getRowId,
  searchPlaceholder,
  emptyText = '暂无数据',
  toolbarSlot,
  bulkSlot,
  reorder,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, columnFilters, globalFilter, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  })

  const dndDisabled =
    sorting.length > 0 || columnFilters.length > 0 || globalFilter.trim() !== ''

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor))

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = data.map(getRowId)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    reorder?.onReorder(arrayMove(ids, from, to))
  }

  const rows = table.getRowModel().rows

  const tableEl = (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((h) => (
              <TableHead key={h.id}>
                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
              {emptyText}
            </TableCell>
          </TableRow>
        ) : reorder ? (
          rows.map((row) => <SortableRow key={row.id} row={row} />)
        ) : (
          rows.map((row) => (
            <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-3">
      <DataTableToolbar
        table={table}
        searchPlaceholder={searchPlaceholder}
        toolbarSlot={toolbarSlot}
        bulkSlot={bulkSlot}
      />
      {reorder ? (
        <DndDisabledContext.Provider value={dndDisabled}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              {tableEl}
            </SortableContext>
          </DndContext>
        </DndDisabledContext.Provider>
      ) : (
        tableEl
      )}
      <DataTablePagination table={table} />
    </div>
  )
}
```

- [ ] **Step 5: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build`
Expected: PASS（组件尚无使用方；若 `enableGlobalFilter` 在 ColumnDef 上报类型错误，改为在 column def 中用 `enableGlobalFilter: false as const` 或确认 @tanstack/react-table 版本 ≥8.10 支持该字段——它是标准字段，正常应通过）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/data-table
git commit -m "feat(web): shared DataTable with selection, sorting, filtering, pagination, dnd rows"
```

---

### Task 6: web — Templates 页重构（拖拽 + 批删）

**Files:**
- Modify: `apps/web/src/pages/templates.tsx`（整页重写）

**Interfaces:**
- Consumes: Task 1 的 `PATCH /api/templates/order` 与 `sortOrder` 字段；Task 4 `runBulk/summarizeBulk/apiErrorText`；Task 5 `DataTable/SortableHeader/selectColumn/DragHandle`；Task 3 AlertDialog
- Produces: `TemplateDto` 加 `sortOrder: number`（batch-new.tsx 等既有 import 不受影响——只增字段）

- [ ] **Step 1: 重写 templates.tsx**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, Table as TanstackTable } from '@tanstack/react-table'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ParamDef } from '@cwe/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, SortableHeader, selectColumn } from '@/components/data-table/data-table'
import { DragHandle } from '@/components/data-table/sortable-rows'
import { api } from '@/lib/api'
import { apiErrorText, runBulk, summarizeBulk } from '@/lib/bulk'

export interface TemplateDto {
  id: number
  name: string
  comfyJson: Record<string, any>
  params: ParamDef[]
  createdAt: string
  sortOrder: number
}

const columns: ColumnDef<TemplateDto, any>[] = [
  {
    id: 'drag',
    header: '',
    cell: ({ row }) => <DragHandle id={row.id} />,
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  },
  selectColumn<TemplateDto>(),
  {
    accessorKey: 'name',
    meta: { title: '名称' },
    header: ({ column }) => <SortableHeader column={column}>名称</SortableHeader>,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    id: 'params',
    meta: { title: '参数' },
    header: '参数',
    cell: ({ row }) => (
      <span className="space-x-1">
        {row.original.params.map((p) => (
          <Badge key={p.key} variant="secondary">
            {p.key}:{p.type}
          </Badge>
        ))}
      </span>
    ),
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    accessorKey: 'createdAt',
    meta: { title: '创建时间' },
    header: ({ column }) => <SortableHeader column={column}>创建时间</SortableHeader>,
    enableGlobalFilter: false,
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <span className="text-right">
        <Button asChild size="sm" variant="outline">
          <Link to={`/batches/new?template=${row.original.id}`}>新建 Batch</Link>
        </Button>
      </span>
    ),
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  },
]

export default function TemplatesPage() {
  const qc = useQueryClient()
  const [banner, setBanner] = useState('')
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
  })

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) =>
      api('/templates/order', { method: 'PATCH', body: JSON.stringify({ ids }) }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['templates'] })
      const prev = qc.getQueryData<TemplateDto[]>(['templates'])
      if (prev) {
        const byId = new Map(prev.map((t) => [t.id, t]))
        qc.setQueryData(
          ['templates'],
          ids.map((id) => byId.get(id)).filter((t): t is TemplateDto => !!t),
        )
      }
      return { prev }
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(['templates'], ctx.prev)
      setBanner(`排序保存失败：${apiErrorText(e)}`)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Templates</h1>
        <Button asChild>
          <Link to="/templates/new">导入 Workflow</Link>
        </Button>
      </div>
      {banner && <p className="text-sm text-destructive">{banner}</p>}
      <DataTable
        columns={columns}
        data={templates}
        getRowId={(t) => String(t.id)}
        searchPlaceholder="搜索模板名称…"
        emptyText="还没有模板——先导入 workflow（支持 UI/API JSON 或 PNG）"
        reorder={{ onReorder: (ids) => reorderMut.mutate(ids.map(Number)) }}
        bulkSlot={(table) => (
          <TemplatesBulkDelete table={table} onDone={setBanner} />
        )}
      />
    </div>
  )
}

function TemplatesBulkDelete({
  table,
  onDone,
}: {
  table: TanstackTable<TemplateDto>
  onDone: (msg: string) => void
}) {
  const qc = useQueryClient()
  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original)
  if (selected.length === 0) return null
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          删除所选（{selected.length}）
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除 {selected.length} 个模板？</AlertDialogTitle>
          <AlertDialogDescription>
            已有 batch 的模板会被跳过并在结果中列出。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              const r = await runBulk(
                selected,
                (t) => t.name,
                (t) => api(`/templates/${t.id}`, { method: 'DELETE' }),
              )
              onDone(summarizeBulk('删除', r))
              table.resetRowSelection()
              void qc.invalidateQueries({ queryKey: ['templates'] })
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

说明：原单行「删除」按钮被批量删除取代（勾选一行即可删单个）；「新建 Batch」保留为行操作。

- [ ] **Step 2: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/templates.tsx
git commit -m "feat(web): templates list with drag reorder, search, sort, bulk delete"
```

---

### Task 7: web — Batches 页重构（过滤 + 批量取消/重试/删除）

**Files:**
- Modify: `apps/web/src/pages/batches.tsx`（整页重写）

**Interfaces:**
- Consumes: Task 2 的 `DELETE /api/batches/:id?purgeOutputs=1`；现有 `POST /:id/cancel`、`POST /:id/retry-failed`；Task 4/5 基建；`useEvents()`（SSE 自动 invalidate ['batches']）
- Produces: `BatchSummaryDto`、`statusVariant` 导出保持不变（batch-detail.tsx 依赖 statusVariant）

- [ ] **Step 1: 重写 batches.tsx**

```tsx
import { useQueryClient, useQuery } from '@tanstack/react-query'
import type { ColumnDef, Table as TanstackTable } from '@tanstack/react-table'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { BatchStatus } from '@cwe/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DataTable, SortableHeader, selectColumn } from '@/components/data-table/data-table'
import { useEvents } from '@/hooks/use-events'
import { api } from '@/lib/api'
import { batchBulkActions, runBulk, summarizeBulk } from '@/lib/bulk'

export interface BatchSummaryDto {
  id: number
  templateId: number
  name: string
  status: BatchStatus
  createdAt: string
  templateName: string
  total: number
  succeeded: number
  failed: number
}

export const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'default',
  completed: 'secondary',
  canceled: 'outline',
  succeeded: 'secondary',
  failed: 'destructive',
}

const STATUSES: BatchStatus[] = ['pending', 'running', 'completed', 'canceled']

const columns: ColumnDef<BatchSummaryDto, any>[] = [
  selectColumn<BatchSummaryDto>(),
  {
    accessorKey: 'name',
    meta: { title: '名称' },
    header: ({ column }) => <SortableHeader column={column}>名称</SortableHeader>,
    cell: ({ row }) => (
      <Link to={`/batches/${row.original.id}`} className="font-medium hover:underline">
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: 'templateName',
    meta: { title: '模板' },
    header: '模板',
    filterFn: 'equals',
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    accessorKey: 'status',
    meta: { title: '状态' },
    header: '状态',
    cell: ({ row }) => <Badge variant={statusVariant[row.original.status]}>{row.original.status}</Badge>,
    filterFn: (row, id, value: string[]) =>
      value.length === 0 || value.includes(String(row.getValue(id))),
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    id: 'progress',
    meta: { title: '进度' },
    header: '进度',
    cell: ({ row }) => (
      <span>
        {row.original.succeeded + row.original.failed}/{row.original.total}
        {row.original.failed > 0 && (
          <span className="ml-1 text-destructive">({row.original.failed} 失败)</span>
        )}
      </span>
    ),
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    accessorKey: 'createdAt',
    meta: { title: '创建时间' },
    header: ({ column }) => <SortableHeader column={column}>创建时间</SortableHeader>,
    enableGlobalFilter: false,
  },
]

export default function BatchesPage() {
  useEvents()
  const [banner, setBanner] = useState('')
  const { data: batches = [] } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })
  const templateNames = [...new Set(batches.map((b) => b.templateName))]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Batches</h1>
        <Button asChild>
          <Link to="/batches/new">New Batch</Link>
        </Button>
      </div>
      {banner && <p className="text-sm text-muted-foreground">{banner}</p>}
      <DataTable
        columns={columns}
        data={batches}
        getRowId={(b) => String(b.id)}
        searchPlaceholder="搜索 batch 名称…"
        emptyText="还没有 batch"
        toolbarSlot={(table) => <BatchFilters table={table} templateNames={templateNames} />}
        bulkSlot={(table) => <BatchesBulkActions table={table} onDone={setBanner} />}
      />
    </div>
  )
}

function BatchFilters({
  table,
  templateNames,
}: {
  table: TanstackTable<BatchSummaryDto>
  templateNames: string[]
}) {
  const statusFilter = (table.getColumn('status')?.getFilterValue() as string[] | undefined) ?? []
  const templateFilter = (table.getColumn('templateName')?.getFilterValue() as string) ?? ''
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8">
            状态{statusFilter.length > 0 ? `(${statusFilter.length})` : ''}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {STATUSES.map((s) => (
            <DropdownMenuCheckboxItem
              key={s}
              checked={statusFilter.includes(s)}
              onCheckedChange={(v) => {
                const next = v ? [...statusFilter, s] : statusFilter.filter((x) => x !== s)
                table.getColumn('status')?.setFilterValue(next.length > 0 ? next : undefined)
              }}
            >
              {s}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select
        value={templateFilter || '__all__'}
        onValueChange={(v) =>
          table.getColumn('templateName')?.setFilterValue(v === '__all__' ? undefined : v)
        }
      >
        <SelectTrigger size="sm" className="w-40">
          <SelectValue placeholder="全部模板" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部模板</SelectItem>
          {templateNames.map((n) => (
            <SelectItem key={n} value={n}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}

function BatchesBulkActions({
  table,
  onDone,
}: {
  table: TanstackTable<BatchSummaryDto>
  onDone: (msg: string) => void
}) {
  const qc = useQueryClient()
  const [purge, setPurge] = useState(false)
  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original)
  const actions = batchBulkActions(selected)

  async function run(action: string, filter: (b: BatchSummaryDto) => boolean, fn: (b: BatchSummaryDto) => Promise<unknown>) {
    const targets = selected.filter(filter)
    const r = await runBulk(targets, (b) => b.name, fn)
    onDone(summarizeBulk(action, r))
    table.resetRowSelection()
    void qc.invalidateQueries({ queryKey: ['batches'] })
  }

  if (selected.length === 0) return null
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!actions.cancel}
        onClick={() =>
          run(
            '取消',
            (b) => b.status === 'pending' || b.status === 'running',
            (b) => api(`/batches/${b.id}/cancel`, { method: 'POST' }),
          )
        }
      >
        取消所选
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!actions.retry}
        onClick={() =>
          run(
            '重试',
            (b) => b.failed > 0,
            (b) => api(`/batches/${b.id}/retry-failed`, { method: 'POST' }),
          )
        }
      >
        重试失败
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="destructive" disabled={!actions.del}>
            删除所选（{selected.length}）
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {selected.length} 个 batch？</AlertDialogTitle>
            <AlertDialogDescription>
              运行中的 batch 会被跳过（先取消再删）。默认只删除记录，输出文件保留在磁盘。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2">
            <Checkbox id="purge" checked={purge} onCheckedChange={(v) => setPurge(!!v)} />
            <Label htmlFor="purge">同时删除输出文件（结果画廊将被清空，不可恢复）</Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(
                  '删除',
                  () => true,
                  (b) =>
                    api(`/batches/${b.id}${purge ? '?purgeOutputs=1' : ''}`, { method: 'DELETE' }),
                )
              }
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS（注意 batch-detail.tsx import 的 `statusVariant` 仍从本文件导出）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/batches.tsx
git commit -m "feat(web): batches list with filters, sort, bulk cancel/retry/delete"
```

---

### Task 8: README 更新 + 全仓验证

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前面全部任务

- [ ] **Step 1: 更新 README 使用流程**

「使用流程」第 4 条（Batches 详情页那条）之前，将第 3 条后补充列表管理描述——把现有：

```markdown
4. Batches 详情页看实时进度与画廊，完成后下载 zip
```

改为：

```markdown
4. Batches 详情页看实时进度与画廊，完成后下载 zip
5. 列表管理：Templates / Batches 均支持搜索、列排序、分页、列显隐与多选批量操作（模板批量删除、batch 批量取消 / 重试失败 / 删除——删除默认保留输出文件，可勾选一并清理）；Templates 支持拖拽调整顺序
```

- [ ] **Step 2: 全仓验证**

Run: `pnpm -r test && pnpm -r typecheck && pnpm --filter @cwe/web build && pnpm --filter @cwe/server build`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: list management capabilities in usage flow"
```

---

## 手动验收清单（合并前人工过一遍）

- [ ] 拖拽模板行，刷新页面后顺序保持
- [ ] 激活列排序 / 搜索 / 状态过滤任一项后，拖拽手柄禁用（hover 有提示）
- [ ] Batch 运行中 SSE 刷新列表：已选行与过滤条件不丢
- [ ] 批删混合选择（含 running batch）：running 跳过、其余删除、汇总横幅列出原因
- [ ] 删除 batch 勾选"同时删除输出文件"后 `data/outputs/<id>/` 目录消失；不勾选则保留
- [ ] 模板批删含"有 batch 的模板"：该项跳过并在汇总中列出

## Self-Review 记录

- Spec 覆盖：§1.1 sort_order/PATCH order → Task 1；§1.2 DELETE batch/purge/事务竞态 → Task 2；§1.3 客户端 fan-out → Task 4+6+7；§2.1 四个基建文件 → Task 5（sortable-rows/toolbar/pagination 独立文件，dnd 上下文在 data-table 内组装）；§2.2 Templates 列/批删/乐观回滚 → Task 6；§2.3 Batches 列/三种批量/purge 勾选默认不勾/选中按 id 保持 → Task 7（getRowId=String(id)）；§2.4 汇总反馈 → Task 4 summarizeBulk；§3 错误表逐条：PATCH 失败回滚(T6)/400/404(T1)/模板 409 跳过(T6)/batch running 409 跳过(T7)/purgeFailed 标记(T2, 前端在 summarizeBulk 之外无需特殊处理——200 不会进 failed 列表, purgeFailed 提示由横幅文案覆盖不足，已知取舍记录于此)/部分失败不中断(T4)；§4 测试 → T1/T2 服务端、T4 纯逻辑、手动清单在上；§5 边界一致。
- 类型一致性：`reorderTemplates` 返回字面量三态在 T1 repo 与 route 一致；`BulkResult`/`batchBulkActions` 签名在 T4 定义、T6/T7 使用一致；`DataTable` props 在 T5 定义、T6/T7 使用一致（`reorder.onReorder(ids: string[])`，T6 转 Number）；`selectColumn`/`SortableHeader`/`DragHandle` 名称三处一致；`statusVariant` 继续从 batches.tsx 导出（batch-detail 依赖）。
- 占位符扫描：无 TBD/TODO；所有代码步骤给出完整代码。
- 已知小取舍：purgeFailed=true 时前端横幅只显示"删除成功"（200 不算失败）——目录清理失败属罕见路径，后续可在 runBulk 的 fn 里检查响应体补提示，不阻塞本期。
