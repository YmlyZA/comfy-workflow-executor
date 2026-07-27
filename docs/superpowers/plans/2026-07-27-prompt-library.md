# Prompt 管理库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompt 片段库：CRUD + JSON 导入导出 + 输入框 `$key` 补全展开插入。

**Architecture:** 服务端新表 `prompts`（key 全局唯一，点分仅展示分组）+ `/api/prompts` 路由；前端独立管理页 `/prompts` + 共享补全组件包装 Input/Textarea，接入 TextValueControl 与矩阵 text 轴值编辑。

**Tech Stack:** Hono + better-sqlite3 + drizzle（服务端）；React 19 + react-query + shadcn/ui（前端）；vitest。

**Spec:** `docs/superpowers/specs/2026-07-27-prompt-library-design.md`

## Global Constraints

- 分支 `feat/prompt-library`，工作目录为本 worktree；不改 `pnpm-workspace.yaml`
- 服务端相对导入必须带 `.js` 后缀（ESM）
- web 包惯例：**不写渲染测试**，手动验收清单进 PR 描述
- key 规则（spec 原文）：trim 后非空、不含空白字符；content 规则：trim 后非空（存储原样，不 trim）
- 错误文案精确值：409 `{ error: 'key 已存在' }`
- 导出格式精确值：`{ version: 1, prompts: [{ key, content }] }`，文件名 `cwe-prompts-<YYYY-MM-DD>.json`
- commit 尾行：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 测试命令：`pnpm --filter @cwe/server test`；typecheck：`pnpm typecheck`（仓库根）

---

## File Structure

- `apps/server/src/db/index.ts` — DDL 追加 prompts 表（Task 1）
- `apps/server/src/db/schema.ts` — drizzle 表定义 + Prompt 类型（Task 1）
- `apps/server/src/db/repo.ts` — listPrompts/createPrompt/updatePrompt/deletePrompt（Task 1）、importPrompts（Task 2）
- `apps/server/src/routes/prompts.ts` — 新路由文件：CRUD（Task 1）、export/import（Task 2）
- `apps/server/src/app.ts` — 挂载 `/api/prompts`（Task 1）
- `apps/server/test/prompts.test.ts` — 服务端测试（Task 1 建，Task 2 增）
- `apps/web/src/lib/api.ts` — `promptsExportUrl()`（Task 3）
- `apps/web/src/lib/prompts.ts` — 新：`PromptRow` 类型 + `fetchPrompts()`（Task 3，Task 4 消费）
- `apps/web/src/pages/prompts.tsx` — 新：管理页（Task 3）
- `apps/web/src/App.tsx` — 导航 + 路由（Task 3）
- `apps/web/src/components/prompt-complete.tsx` — 新：补全组件（Task 4）
- `apps/web/src/components/text-value-control.tsx` — Input 换补全版（Task 4）
- `apps/web/src/components/matrix-entry.tsx` — ValueList multiline 分支换补全版（Task 4）

---

### Task 1: prompts 表 + repo + CRUD 路由

**Files:**
- Modify: `apps/server/src/db/index.ts`（DDL 常量末尾追加）
- Modify: `apps/server/src/db/schema.ts`（文件末尾 type 导出之前）
- Modify: `apps/server/src/db/repo.ts`（文件末尾追加）
- Create: `apps/server/src/routes/prompts.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/prompts.test.ts`

**Interfaces:**
- Consumes: 既有 `createApp(deps)`/`loadConfig`/`createDb`（test harness 同 `test/input-history.test.ts` 模式）
- Produces: repo 函数 `listPrompts(db): Prompt[]`、`createPrompt(db, key, content): Prompt | 'conflict'`、`updatePrompt(db, id, patch: {key?, content?}): Prompt | 'not-found' | 'conflict'`、`deletePrompt(db, id): void`；路由 `GET/POST /api/prompts`、`PUT/DELETE /api/prompts/:id`；schema 导出 `prompts` 表与 `Prompt` 类型（Task 2/3/4 依赖）

- [ ] **Step 1: 写失败测试**

`apps/server/test/prompts.test.ts` 全文：

```ts
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'

let db: Db
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  db = createDb(':memory:')
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db,
    comfy: null,
    events: new EventEmitter(),
  })
})

async function post(path: string, body: unknown) {
  return app.request(`/api/prompts${path}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body),
  })
}

async function listKeys(): Promise<string[]> {
  const res = await app.request('/api/prompts', { headers: H })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { prompts: Array<{ key: string }> }
  return body.prompts.map((p) => p.key)
}

describe('prompts CRUD', () => {
  it('增查改删全链路,删除幂等', async () => {
    const created = await post('', { key: '人物.少女', content: '1girl, solo' })
    expect(created.status).toBe(201)
    const row = (await created.json()) as { id: number; key: string; content: string }
    expect(row).toMatchObject({ key: '人物.少女', content: '1girl, solo' })

    expect(await listKeys()).toEqual(['人物.少女'])

    const upd = await app.request(`/api/prompts/${row.id}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ content: '1girl' }),
    })
    expect(upd.status).toBe(200)
    expect(((await upd.json()) as { content: string }).content).toBe('1girl')

    const updKey = await app.request(`/api/prompts/${row.id}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ key: '人物.女孩' }),
    })
    expect(updKey.status).toBe(200)
    expect(((await updKey.json()) as { key: string }).key).toBe('人物.女孩')

    const del = await app.request(`/api/prompts/${row.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    const again = await app.request(`/api/prompts/${row.id}`, { method: 'DELETE', headers: H })
    expect(again.status).toBe(200)
    expect(await listKeys()).toEqual([])
  })

  it('列表按 key 升序', async () => {
    await post('', { key: 'b.x', content: '2' })
    await post('', { key: 'a.y', content: '1' })
    expect(await listKeys()).toEqual(['a.y', 'b.x'])
  })

  it('POST 重复 key 409;PUT 改 key 撞已有 409', async () => {
    await post('', { key: 'a', content: '1' })
    const dup = await post('', { key: 'a', content: '2' })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'key 已存在' })

    const other = await post('', { key: 'b', content: '3' })
    const { id } = (await other.json()) as { id: number }
    const clash = await app.request(`/api/prompts/${id}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ key: 'a' }),
    })
    expect(clash.status).toBe(409)
  })

  it('key/content 校验 400;PUT 不存在 404', async () => {
    const bads = [
      { key: '', content: 'x' },
      { key: '   ', content: 'x' },
      { key: 'a b', content: 'x' },
      { key: 'a\tb', content: 'x' },
      { key: 'ok', content: '' },
      { key: 'ok', content: '   ' },
    ]
    for (const bad of bads) {
      expect((await post('', bad)).status).toBe(400)
    }
    const missing = await app.request('/api/prompts/999', {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ content: 'x' }),
    })
    expect(missing.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- prompts`
Expected: FAIL（404 not found——路由不存在）

- [ ] **Step 3: 实现**

`apps/server/src/db/index.ts` 的 `DDL` 模板串末尾（`idx_input_history_key` 行后）追加：

```sql
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`apps/server/src/db/schema.ts` 在 type 导出前追加：

```ts
export const prompts = sqliteTable('prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  content: text('content').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

并在文件末尾 type 导出区追加：

```ts
export type Prompt = typeof prompts.$inferSelect
```

`apps/server/src/db/repo.ts` 末尾追加（`asc` 若未导入则加进既有 drizzle-orm import；`prompts`、`Prompt` 加进既有 schema import）：

```ts
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export function listPrompts(db: Db): Prompt[] {
  return db.select().from(prompts).orderBy(asc(prompts.key)).all()
}

export function createPrompt(db: Db, key: string, content: string): Prompt | 'conflict' {
  try {
    return db
      .insert(prompts)
      .values({ key, content, updatedAt: new Date().toISOString() })
      .returning()
      .get()
  } catch (err) {
    if (isUniqueViolation(err)) return 'conflict'
    throw err
  }
}

export function updatePrompt(
  db: Db,
  id: number,
  patch: { key?: string; content?: string },
): Prompt | 'not-found' | 'conflict' {
  const existing = db.select().from(prompts).where(eq(prompts.id, id)).get()
  if (!existing) return 'not-found'
  try {
    return db
      .update(prompts)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(prompts.id, id))
      .returning()
      .get()
  } catch (err) {
    if (isUniqueViolation(err)) return 'conflict'
    throw err
  }
}

export function deletePrompt(db: Db, id: number): void {
  db.delete(prompts).where(eq(prompts.id, id)).run()
}
```

`apps/server/src/routes/prompts.ts` 全文：

```ts
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import * as repo from '../db/repo.js'

const keySchema = z
  .string()
  .trim()
  .min(1, 'key 不能为空')
  .refine((k) => !/\s/.test(k), 'key 不能含空白字符')
const contentSchema = z.string().refine((s) => s.trim() !== '', 'content 不能为空')

const createSchema = z.object({ key: keySchema, content: contentSchema })
const updateSchema = z.object({ key: keySchema.optional(), content: contentSchema.optional() })

export function promptRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json({ prompts: repo.listPrompts(deps.db) }))

  app.post('/', async (c) => {
    const body = createSchema.parse(await c.req.json())
    const row = repo.createPrompt(deps.db, body.key, body.content)
    if (row === 'conflict') return c.json({ error: 'key 已存在' }, 409)
    return c.json(row, 201)
  })

  app.put('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = updateSchema.parse(await c.req.json())
    const row = repo.updatePrompt(deps.db, id, body)
    if (row === 'not-found') return c.json({ error: 'not found' }, 404)
    if (row === 'conflict') return c.json({ error: 'key 已存在' }, 409)
    return c.json(row)
  })

  app.delete('/:id', (c) => {
    repo.deletePrompt(deps.db, Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  return app
}
```

（校验失败 zod 抛 ZodError，`app.ts` 的 `onError` 已统一转 400，无需路由内处理。）

`apps/server/src/app.ts`：import 区加 `import { promptRoutes } from './routes/prompts.js'`；挂载区（`inputHistoryRoutes` 行后）加：

```ts
app.route('/api/prompts', promptRoutes(deps))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test`
Expected: 全绿（prompts 4 个新测试 + 既有 168 个不回归）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/index.ts apps/server/src/db/schema.ts apps/server/src/db/repo.ts apps/server/src/routes/prompts.ts apps/server/src/app.ts apps/server/test/prompts.test.ts
git commit -m "feat(server): prompts 表与 CRUD 路由

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Prompt 库导入导出路由

**Files:**
- Modify: `apps/server/src/db/repo.ts`（末尾追加 importPrompts）
- Modify: `apps/server/src/routes/prompts.ts`
- Test: `apps/server/test/prompts.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `repo.listPrompts`、`keySchema`/`contentSchema`（同文件内）、test harness（`post`/`listKeys` helper）
- Produces: `repo.importPrompts(db, items: Array<{key, content}>): { created: number; updated: number }`；路由 `GET /api/prompts/export`、`POST /api/prompts/import`

- [ ] **Step 1: 写失败测试**

`apps/server/test/prompts.test.ts` 追加：

```ts
describe('prompts 导入导出', () => {
  it('export 返回全量与固定格式,带下载头', async () => {
    await post('', { key: 'b', content: '2' })
    await post('', { key: 'a', content: '1' })
    const res = await app.request('/api/prompts/export', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('cwe-prompts-')
    expect(await res.json()).toEqual({
      version: 1,
      prompts: [
        { key: 'a', content: '1' },
        { key: 'b', content: '2' },
      ],
    })
  })

  it('import 按 key upsert 并计数', async () => {
    await post('', { key: 'a', content: 'old' })
    const res = await post('/import', {
      version: 1,
      prompts: [
        { key: 'a', content: 'new' },
        { key: 'c', content: '3' },
      ],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: 1, updated: 1 })
    const exp = await app.request('/api/prompts/export', { headers: H })
    expect(((await exp.json()) as { prompts: Array<{ key: string; content: string }> }).prompts).toEqual([
      { key: 'a', content: 'new' },
      { key: 'c', content: '3' },
    ])
  })

  it('import 非法格式整体拒绝,库不变', async () => {
    await post('', { key: 'keep', content: 'x' })
    const bads = [
      {},
      { prompts: 'nope' },
      { prompts: [{ key: 'ok' }] },
      { prompts: [{ content: 'x' }] },
      { prompts: [{ key: 'bad key', content: 'x' }] },
      { prompts: [{ key: 'ok', content: '' }] },
    ]
    for (const bad of bads) {
      expect((await post('/import', bad)).status).toBe(400)
    }
    expect(await listKeys()).toEqual(['keep'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- prompts`
Expected: 新 describe 3 个 FAIL（/export 404）

- [ ] **Step 3: 实现**

`apps/server/src/db/repo.ts` 末尾追加：

```ts
export function importPrompts(
  db: Db,
  items: Array<{ key: string; content: string }>,
): { created: number; updated: number } {
  return db.transaction((tx) => {
    let created = 0
    let updated = 0
    const now = new Date().toISOString()
    for (const item of items) {
      const existing = tx.select().from(prompts).where(eq(prompts.key, item.key)).get()
      if (existing) {
        tx.update(prompts)
          .set({ content: item.content, updatedAt: now })
          .where(eq(prompts.id, existing.id))
          .run()
        updated++
      } else {
        tx.insert(prompts).values({ key: item.key, content: item.content, updatedAt: now }).run()
        created++
      }
    }
    return { created, updated }
  })
}
```

`apps/server/src/routes/prompts.ts`：schema 区追加：

```ts
const importSchema = z.object({
  prompts: z.array(z.object({ key: keySchema, content: contentSchema })),
})
```

`promptRoutes` 内（`app.get('/')` 之后、`app.put('/:id')` 之前均可）追加：

```ts
app.get('/export', (c) => {
  const rows = repo.listPrompts(deps.db)
  const date = new Date().toISOString().slice(0, 10)
  c.header('Content-Disposition', `attachment; filename="cwe-prompts-${date}.json"`)
  return c.json({ version: 1, prompts: rows.map((p) => ({ key: p.key, content: p.content })) })
})

app.post('/import', async (c) => {
  const body = importSchema.parse(await c.req.json())
  return c.json(repo.importPrompts(deps.db, body.prompts))
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repo.ts apps/server/src/routes/prompts.ts apps/server/test/prompts.test.ts
git commit -m "feat(server): prompt 库 JSON 导入导出

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Prompt 库管理页 + 导航

**Files:**
- Modify: `apps/web/src/lib/api.ts`（末尾追加）
- Create: `apps/web/src/lib/prompts.ts`
- Create: `apps/web/src/pages/prompts.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 1/2 的 API 形状（`GET /api/prompts` → `{ prompts: [{id,key,content,updatedAt}] }`；`POST /api/prompts/import` → `{created, updated}`；409 body `{ error: 'key 已存在' }`）
- Produces: `apps/web/src/lib/prompts.ts` 导出 `type PromptRow = { id: number; key: string; content: string; updatedAt: string }` 与 `fetchPrompts(): Promise<{ prompts: PromptRow[] }>`（Task 4 消费，签名勿改）；`promptsExportUrl(): string`

web 惯例：不写渲染测试；本 task 交付以 `pnpm typecheck` + `pnpm --filter @cwe/web build` 通过为准。

- [ ] **Step 1: lib 实现**

`apps/web/src/lib/api.ts` 末尾追加：

```ts
export function promptsExportUrl(): string {
  return `/api/prompts/export?token=${encodeURIComponent(getToken())}`
}
```

`apps/web/src/lib/prompts.ts` 全文：

```ts
import { api } from './api'

export type PromptRow = { id: number; key: string; content: string; updatedAt: string }

export function fetchPrompts() {
  return api<{ prompts: PromptRow[] }>('/prompts')
}
```

- [ ] **Step 2: 管理页实现**

`apps/web/src/pages/prompts.tsx` 全文：

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, promptsExportUrl } from '@/lib/api'
import { fetchPrompts, type PromptRow } from '@/lib/prompts'

function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return '操作失败'
  try {
    return (JSON.parse(e.message) as { error?: string }).error ?? e.message
  } catch {
    return e.message
  }
}

export default function PromptsPage() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['prompts'], queryFn: fetchPrompts })
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; row: PromptRow } | null>(
    null,
  )
  const [deleting, setDeleting] = useState<PromptRow | null>(null)
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const groups = useMemo(() => {
    const map = new Map<string, PromptRow[]>()
    for (const p of query.data?.prompts ?? []) {
      const group = p.key.includes('.') ? p.key.slice(0, p.key.indexOf('.')) : '未分组'
      map.set(group, [...(map.get(group) ?? []), p])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [query.data])

  async function handleImportFile(file: File) {
    setNotice('')
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const res = await api<{ created: number; updated: number }>('/prompts/import', {
        method: 'POST',
        body: JSON.stringify(parsed),
      })
      setNotice(`导入完成：新增 ${res.created}，覆盖 ${res.updated}`)
      void qc.invalidateQueries({ queryKey: ['prompts'] })
    } catch (e) {
      setNotice(`导入失败：${errMsg(e)}`)
    }
  }

  async function handleDelete(row: PromptRow) {
    await api(`/prompts/${row.id}`, { method: 'DELETE' })
    setDeleting(null)
    void qc.invalidateQueries({ queryKey: ['prompts'] })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">Prompt 库</h1>
        <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
          <PlusIcon className="size-4" /> 新建
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <UploadIcon className="size-4" /> 导入
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={promptsExportUrl()} download>
            <DownloadIcon className="size-4" /> 导出
          </a>
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImportFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      {query.data?.prompts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          还没有 prompt 片段。key 用点分组织（如 人物.少女），输入框里打 $ 即可展开插入。
        </p>
      )}

      {groups.map(([group, rows]) => (
        <section key={group} className="space-y-1">
          <h2 className="text-sm font-medium text-muted-foreground">{group}</h2>
          <div className="divide-y rounded-md border">
            {rows.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2">
                <span className="shrink-0 font-mono text-sm">{p.key}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={p.content}>
                  {p.content}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setDialog({ mode: 'edit', row: p })}>
                  <PencilIcon className="size-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(p)}>
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>
      ))}

      {dialog && (
        <EditDialog
          initial={dialog.mode === 'edit' ? dialog.row : null}
          onClose={(changed) => {
            setDialog(null)
            if (changed) void qc.invalidateQueries({ queryKey: ['prompts'] })
          }}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleting?.key}？</AlertDialogTitle>
            <AlertDialogDescription>已展开插入的内容不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && void handleDelete(deleting)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function EditDialog({
  initial,
  onClose,
}: {
  initial: PromptRow | null
  onClose: (changed: boolean) => void
}) {
  const [key, setKey] = useState(initial?.key ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    setError('')
    try {
      if (initial) {
        await api(`/prompts/${initial.id}`, { method: 'PUT', body: JSON.stringify({ key, content }) })
      } else {
        await api('/prompts', { method: 'POST', body: JSON.stringify({ key, content }) })
      }
      onClose(true)
    } catch (e) {
      setError(errMsg(e))
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? '编辑片段' : '新建片段'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="prompt-key">key（点分分组，如 人物.少女）</Label>
            <Input id="prompt-key" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="prompt-content">内容</Label>
            <Textarea
              id="prompt-content"
              rows={4}
              className="field-sizing-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving || !key.trim() || !content.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: 导航与路由**

`apps/web/src/App.tsx`：

- import 区加 `import PromptsPage from '@/pages/prompts'`
- nav 中 Templates Link 之后加：

```tsx
<Link to="/prompts" className="text-sm hover:underline">
  Prompt 库
</Link>
```

- Routes 中 `/templates/new` 行后加：

```tsx
<Route path="/prompts" element={<PromptsPage />} />
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm --filter @cwe/web build`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/prompts.ts apps/web/src/pages/prompts.tsx apps/web/src/App.tsx
git commit -m "feat(web): Prompt 库管理页(分组/CRUD/导入导出)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: $key 补全组件 + 两处接入

**Files:**
- Create: `apps/web/src/components/prompt-complete.tsx`
- Modify: `apps/web/src/components/text-value-control.tsx`
- Modify: `apps/web/src/components/matrix-entry.tsx`

**Interfaces:**
- Consumes: Task 3 的 `fetchPrompts`/`PromptRow`（`@/lib/prompts`）；既有 `cn`（`@/lib/utils`）、`Input`/`Textarea`（shadcn）
- Produces: `PromptCompleteInput({ value, onChange, className?, placeholder? })` 与 `PromptCompleteTextarea({ value, onChange, className?, rows? })`——受控组件，`onChange` 收字符串（非事件）

- [ ] **Step 1: 补全组件实现**

`apps/web/src/components/prompt-complete.tsx` 全文：

```tsx
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { fetchPrompts, type PromptRow } from '@/lib/prompts'
import { cn } from '@/lib/utils'

/** 光标前最近的 $ 且到光标间无空白 → 捕获态 {start, frag};否则 null */
function deriveCapture(value: string, caret: number): { start: number; frag: string } | null {
  const before = value.slice(0, caret)
  const dollar = before.lastIndexOf('$')
  if (dollar === -1) return null
  const frag = before.slice(dollar + 1)
  if (/\s/.test(frag)) return null
  return { start: dollar, frag }
}

function usePromptComplete(value: string, onChange: (v: string) => void) {
  const [caret, setCaret] = useState<number | null>(null)
  const [closed, setClosed] = useState(false)
  const [hi, setHi] = useState(0)
  const capture = !closed && caret != null ? deriveCapture(value, caret) : null
  const open = capture != null
  const query = useQuery({
    queryKey: ['prompts'],
    queryFn: fetchPrompts,
    staleTime: 30_000,
    enabled: open,
  })
  const matches = capture
    ? (query.data?.prompts ?? []).filter((p) =>
        p.key.toLowerCase().includes(capture.frag.toLowerCase()),
      )
    : []
  const highlighted = Math.min(hi, Math.max(matches.length - 1, 0))

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setCaret(e.target.selectionStart)
    setClosed(false)
    setHi(0)
    onChange(e.target.value)
  }

  function pick(p: PromptRow) {
    if (!capture || caret == null) return
    onChange(value.slice(0, capture.start) + p.content + value.slice(caret))
    setClosed(true)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosed(true)
      return
    }
    if (matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi(Math.min(highlighted + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi(Math.max(highlighted - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(matches[highlighted]!)
    }
  }

  const dropdown = open ? (
    <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full min-w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {matches.map((p, i) => (
        <button
          key={p.id}
          type="button"
          className={cn(
            'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm',
            i === highlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(p)}
        >
          <span className="font-mono text-xs">{p.key}</span>
          <span className="max-w-full truncate text-xs text-muted-foreground">{p.content}</span>
        </button>
      ))}
      {matches.length === 0 && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">（无匹配）</div>
      )}
    </div>
  ) : null

  return { handleChange, handleKeyDown, handleBlur: () => setClosed(true), dropdown }
}

/** 带 $key 补全的 text 单值输入框;onChange 收字符串 */
export function PromptCompleteInput({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}) {
  const c = usePromptComplete(value, onChange)
  return (
    <div className="relative flex-1">
      <Input
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={c.handleChange}
        onKeyDown={c.handleKeyDown}
        onBlur={c.handleBlur}
      />
      {c.dropdown}
    </div>
  )
}

/** 带 $key 补全的多行输入;onChange 收字符串 */
export function PromptCompleteTextarea({
  value,
  onChange,
  className,
  rows,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  rows?: number
}) {
  const c = usePromptComplete(value, onChange)
  return (
    <div className="relative flex-1">
      <Textarea
        className={className}
        rows={rows}
        value={value}
        onChange={c.handleChange}
        onKeyDown={c.handleKeyDown}
        onBlur={c.handleBlur}
      />
      {c.dropdown}
    </div>
  )
}
```

- [ ] **Step 2: 接入 TextValueControl**

`apps/web/src/components/text-value-control.tsx`：把

```tsx
      <Input
        className="h-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
```

替换为：

```tsx
      <PromptCompleteInput className="h-8" placeholder={placeholder} value={value} onChange={onChange} />
```

import 区加 `import { PromptCompleteInput } from '@/components/prompt-complete'`，删除不再使用的 `Input` import。

- [ ] **Step 3: 接入矩阵 text 轴**

`apps/web/src/components/matrix-entry.tsx` `ValueList` 内，把 multiline 分支

```tsx
          {multiline ? (
            <Textarea
              rows={2}
              className="field-sizing-content min-h-0"
              value={v}
              onChange={(e) => setAt(i, e.target.value)}
            />
          ) : (
```

替换为：

```tsx
          {multiline ? (
            <PromptCompleteTextarea
              rows={2}
              className="field-sizing-content min-h-0"
              value={v}
              onChange={(nv) => setAt(i, nv)}
            />
          ) : (
```

import 区加 `import { PromptCompleteTextarea } from '@/components/prompt-complete'`；若 `Textarea` 在该文件其他处仍有使用则保留其 import，否则删除。

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm --filter @cwe/web build && pnpm test`
Expected: 全部通过（web 无渲染测试，靠 typecheck/build + 手动验收）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/prompt-complete.tsx apps/web/src/components/text-value-control.tsx apps/web/src/components/matrix-entry.tsx
git commit -m "feat(web): \$key 补全展开接入 text 单值框与矩阵 text 轴

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（放 PR 描述）

1. Prompt 库页增删改查、点分分组正确
2. 导出 JSON 可下载；导入合法文件提示计数、库更新
3. 表格行 text 输入 `$` 出补全，Enter 展开插入内容
4. 矩阵 text 轴 Textarea 同样可用
5. 与历史下拉并存：同一输入框历史按钮照常工作
6. `$` 后输入空格退出捕获，正常输入不受干扰
