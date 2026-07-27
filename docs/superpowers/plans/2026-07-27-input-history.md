# 输入历史 实现计划（七期 ⑤）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建批时服务端自动记录 text 参数值（按 key 全局共享、.env 上限修剪），输入框旁历史下拉回填/单条删除。

**Architecture:** 新表 `input_history`（UNIQUE(param_key,value) + upsert 计数）；`POST /api/templates/:id/batches` 建批后 try/catch 记录；`GET/DELETE /api/input-history` 查询与删除；前端新组件 `TextValueControl`（Input+历史下拉）接入表格行与矩阵共享区的 text 分支。spec：`docs/superpowers/specs/2026-07-27-input-history-design.md`。

**Tech Stack:** Hono + drizzle/better-sqlite3（服务端）；React 19 + react-query + shadcn DropdownMenu（前端）；vitest。

## Global Constraints

- 分支 `feat/input-history` 已建，直接在其上工作；**禁止 push / 建 PR**（控制器统一做）
- server 相对导入带 `.js` 后缀（ESM）
- web 包惯例：**不写渲染测试**，验证 = `pnpm typecheck` + 既有测试全绿
- 测试命令：`pnpm --filter @cwe/server test -- input-history`（单文件）、`pnpm test`（根，全量，当前 208 通过）、`pnpm typecheck`
- 提交信息结尾加 trailer：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 文案逐字用：400 `缺少 key 参数` / `缺少 key 或 value 参数`；空历史下拉项 `（无历史）`；env 变量名 `INPUT_HISTORY_LIMIT`（默认 100，非法/非正回退 100）
- 记录规则：仅 `type === 'text'` 参数；值非 string 或 trim 后为空跳过；**原样存储**（不 trim）；同批同 (key,value) 只记一次；记录失败 console.error 不影响建批

---

### Task 1: 服务端（表 + 配置 + repo + 路由 + 建批挂钩 + 测试）

**Files:**
- Modify: `apps/server/src/db/index.ts`（DDL 追加表）
- Modify: `apps/server/src/db/schema.ts`（drizzle 表定义）
- Modify: `apps/server/src/config.ts`（inputHistoryLimit）
- Modify: `apps/server/src/db/repo.ts`（record/list/delete 三函数）
- Create: `apps/server/src/routes/input-history.ts`
- Modify: `apps/server/src/app.ts`（挂载 /api/input-history）
- Modify: `apps/server/src/routes/templates.ts`（建批后记录）
- Test: `apps/server/test/input-history.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `createBatchSchema`、`AppDeps`、`repo.getTemplate/createBatch`
- Produces:
  - `Config.inputHistoryLimit: number`
  - `repo.recordInputHistory(db, textKeys: string[], jobsParams: ParamValues[], limit: number): void`
  - `repo.listInputHistory(db, key: string, limit: number): string[]`（last_used_at 降序、id 降序 tiebreak）
  - `repo.deleteInputHistory(db, key: string, value: string): void`
  - `GET /api/input-history?key=` → `{ values: string[] }`；`DELETE /api/input-history?key=&value=` → `{ ok: true }`（幂等）

- [ ] **Step 1: 写失败测试**

创建 `apps/server/test/input-history.test.ts`：

```ts
import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import { inputHistory } from '../src/db/schema.js'

let db: Db
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

function makeApp(dbi: Db, extraEnv: Record<string, string> = {}) {
  return createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', ...extraEnv }),
    db: dbi,
    comfy: null,
    events: new EventEmitter(),
  })
}

beforeEach(() => {
  db = createDb(':memory:')
  app = makeApp(db)
})

const templateBody = {
  name: 'T',
  comfyJson: {
    '3': { class_type: 'KSampler', inputs: { steps: 4 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  },
  params: [
    { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' },
    { key: 'steps', label: 'Steps', nodeId: '3', inputName: 'steps', type: 'number' },
  ],
}

async function createTemplate(a = app) {
  const res = await a.request('/api/templates', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(templateBody),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number }
}

async function createBatch(templateId: number, jobs: Array<Record<string, unknown>>, a = app) {
  const res = await a.request(`/api/templates/${templateId}/batches`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'B', jobs }),
  })
  expect(res.status).toBe(201)
}

async function getHistory(key: string, a = app): Promise<string[]> {
  const res = await a.request(`/api/input-history?key=${encodeURIComponent(key)}`, { headers: H })
  expect(res.status).toBe(200)
  return ((await res.json()) as { values: string[] }).values
}

describe('input history', () => {
  it('建批记录 text 值,最近使用在前', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'a', steps: 1 }, { prompt: 'b' }])
    expect(await getHistory('prompt')).toEqual(['b', 'a'])
  })

  it('仅 text 参数入历史', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'a', steps: 7 }])
    expect(await getHistory('steps')).toEqual([])
  })

  it('空白与非 string 值不记录', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: '' }, { prompt: '   ' }, { prompt: 5 }])
    expect(await getHistory('prompt')).toEqual([])
  })

  it('同批重复只记一次,跨批 upsert 刷新排序与计数', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'x' }, { prompt: 'x' }])
    let rows = db.select().from(inputHistory).where(eq(inputHistory.paramKey, 'prompt')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.useCount).toBe(1)
    await createBatch(t.id, [{ prompt: 'y' }])
    await createBatch(t.id, [{ prompt: 'x' }])
    rows = db.select().from(inputHistory).where(eq(inputHistory.paramKey, 'prompt')).all()
    expect(rows.find((r) => r.value === 'x')!.useCount).toBe(2)
    expect(await getHistory('prompt')).toEqual(['x', 'y'])
  })

  it('超过 INPUT_HISTORY_LIMIT 按最近使用修剪', async () => {
    const smallDb = createDb(':memory:')
    const smallApp = makeApp(smallDb, { INPUT_HISTORY_LIMIT: '3' })
    const t = await createTemplate(smallApp)
    for (const v of ['a', 'b', 'c', 'd']) {
      await createBatch(t.id, [{ prompt: v }], smallApp)
    }
    expect(await getHistory('prompt', smallApp)).toEqual(['d', 'c', 'b'])
    const rows = smallDb.select().from(inputHistory).all()
    expect(rows).toHaveLength(3)
  })

  it('GET 缺 key 返回 400', async () => {
    const res = await app.request('/api/input-history', { headers: H })
    expect(res.status).toBe(400)
  })

  it('DELETE 删除单条,幂等,缺参 400', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'a' }, { prompt: 'b' }])
    const del = await app.request(
      `/api/input-history?key=prompt&value=${encodeURIComponent('a')}`,
      { method: 'DELETE', headers: H },
    )
    expect(del.status).toBe(200)
    expect(await getHistory('prompt')).toEqual(['b'])
    const again = await app.request(
      `/api/input-history?key=prompt&value=${encodeURIComponent('a')}`,
      { method: 'DELETE', headers: H },
    )
    expect(again.status).toBe(200)
    const missing = await app.request('/api/input-history?key=prompt', {
      method: 'DELETE',
      headers: H,
    })
    expect(missing.status).toBe(400)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- input-history`
Expected: 编译失败或断言失败（schema 无 `inputHistory` 导出 → import 报错），全部 FAIL

- [ ] **Step 3: 表与配置**

`apps/server/src/db/index.ts` 的 DDL 模板字符串末尾（`CREATE INDEX IF NOT EXISTS idx_jobs_status ...;` 之后）追加：

```sql
CREATE TABLE IF NOT EXISTS input_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  param_key TEXT NOT NULL,
  value TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT NOT NULL,
  UNIQUE(param_key, value)
);
CREATE INDEX IF NOT EXISTS idx_input_history_key ON input_history(param_key, last_used_at);
```

`apps/server/src/db/schema.ts` 末尾类型导出之前加：

```ts
export const inputHistory = sqliteTable('input_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paramKey: text('param_key').notNull(),
  value: text('value').notNull(),
  useCount: integer('use_count').notNull().default(1),
  lastUsedAt: text('last_used_at').notNull(),
})
```

`apps/server/src/config.ts`：`Config` 接口加 `inputHistoryLimit: number`；`loadConfig` 返回对象加：

```ts
    inputHistoryLimit: (() => {
      const n = Number(env.INPUT_HISTORY_LIMIT ?? 100)
      return Number.isInteger(n) && n > 0 ? n : 100
    })(),
```

- [ ] **Step 4: repo 三函数**

`apps/server/src/db/repo.ts`：import 行的 `batches, jobs, templates` 处加 `inputHistory`；`import type { CreateBatchInput, ... }` 处补 `ParamValues`（来自 `@cwe/shared`）。文件末尾加：

```ts
// -- input history --

/** 建批时记录 text 参数值:同批 (key,value) 去重后 upsert,再按 key 修剪到 limit */
export function recordInputHistory(
  db: Db,
  textKeys: string[],
  jobsParams: ParamValues[],
  limit: number,
): void {
  if (textKeys.length === 0) return
  const seen = new Set<string>()
  const entries: Array<{ key: string; value: string }> = []
  for (const params of jobsParams) {
    for (const key of textKeys) {
      const v = params[key]
      if (typeof v !== 'string' || v.trim() === '') continue
      const dedup = `${key}\u0000${v}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      entries.push({ key, value: v })
    }
  }
  if (entries.length === 0) return
  db.transaction((tx) => {
    const ts = now()
    for (const e of entries) {
      tx.insert(inputHistory)
        .values({ paramKey: e.key, value: e.value, lastUsedAt: ts })
        .onConflictDoUpdate({
          target: [inputHistory.paramKey, inputHistory.value],
          set: { useCount: sql`${inputHistory.useCount} + 1`, lastUsedAt: ts },
        })
        .run()
    }
    for (const key of new Set(entries.map((e) => e.key))) {
      tx.run(sql`DELETE FROM input_history WHERE param_key = ${key} AND id NOT IN (
        SELECT id FROM input_history WHERE param_key = ${key}
        ORDER BY last_used_at DESC, id DESC LIMIT ${limit})`)
    }
  })
}

export function listInputHistory(db: Db, key: string, limit: number): string[] {
  return db
    .select({ value: inputHistory.value })
    .from(inputHistory)
    .where(eq(inputHistory.paramKey, key))
    .orderBy(desc(inputHistory.lastUsedAt), desc(inputHistory.id))
    .limit(limit)
    .all()
    .map((r) => r.value)
}

export function deleteInputHistory(db: Db, key: string, value: string): void {
  db.delete(inputHistory)
    .where(and(eq(inputHistory.paramKey, key), eq(inputHistory.value, value)))
    .run()
}
```

- [ ] **Step 5: 路由与挂钩**

创建 `apps/server/src/routes/input-history.ts`：

```ts
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import * as repo from '../db/repo.js'

export function inputHistoryRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => {
    const key = c.req.query('key')
    if (!key) return c.json({ error: '缺少 key 参数' }, 400)
    return c.json({ values: repo.listInputHistory(deps.db, key, deps.config.inputHistoryLimit) })
  })

  app.delete('/', (c) => {
    const key = c.req.query('key')
    const value = c.req.query('value')
    if (!key || !value) return c.json({ error: '缺少 key 或 value 参数' }, 400)
    repo.deleteInputHistory(deps.db, key, value)
    return c.json({ ok: true })
  })

  return app
}
```

`apps/server/src/app.ts`：import 区加

```ts
import { inputHistoryRoutes } from './routes/input-history.js'
```

`app.route('/api/thumbs', thumbRoutes(deps))` 之后加：

```ts
  app.route('/api/input-history', inputHistoryRoutes(deps))
```

`apps/server/src/routes/templates.ts` 的 `app.post('/:id/batches', ...)` 整段替换为：

```ts
  app.post('/:id/batches', async (c) => {
    const id = Number(c.req.param('id'))
    const template = repo.getTemplate(deps.db, id)
    if (!template) return c.json({ error: 'template not found' }, 404)
    const input = createBatchSchema.parse(await c.req.json())
    const batch = repo.createBatch(deps.db, id, input)
    // 输入历史记录失败不影响建批
    try {
      const textKeys = template.params.filter((p) => p.type === 'text').map((p) => p.key)
      repo.recordInputHistory(deps.db, textKeys, input.jobs, deps.config.inputHistoryLimit)
    } catch (err) {
      console.error('record input history failed', err)
    }
    deps.events.emit('event', { type: 'batch-updated', batchId: batch.id, status: batch.status })
    return c.json(batch, 201)
  })
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- input-history`
Expected: 7 个测试全 PASS

- [ ] **Step 7: 全量验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净；全量 215 通过（208 + 新增 7）

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/db/index.ts apps/server/src/db/schema.ts apps/server/src/config.ts apps/server/src/db/repo.ts apps/server/src/routes/input-history.ts apps/server/src/app.ts apps/server/src/routes/templates.ts apps/server/test/input-history.test.ts
git commit -m "feat(server): 输入历史表+记录+查询/删除端点(INPUT_HISTORY_LIMIT)"
```

---

### Task 2: 前端 TextValueControl + 两处接入

**Files:**
- Create: `apps/web/src/components/text-value-control.tsx`
- Modify: `apps/web/src/pages/batch-new.tsx`（表格行 text 分支）
- Modify: `apps/web/src/components/matrix-entry.tsx`（共享区 text 分支）

**Interfaces:**
- Consumes: Task 1 的 `GET/DELETE /api/input-history`；既有 `api`、shadcn `DropdownMenu`/`Input`/`Button`
- Produces: `TextValueControl({ paramKey: string, value: string, onChange: (v: string) => void, placeholder?: string })`

- [ ] **Step 1: 创建组件**

创建 `apps/web/src/components/text-value-control.tsx`：

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HistoryIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

/** text 参数单值控件:手填 + 历史下拉(回填/单条删除);历史由服务端建批时自动记录 */
export function TextValueControl({
  paramKey,
  value,
  onChange,
  placeholder,
}: {
  paramKey: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const history = useQuery({
    queryKey: ['input-history', paramKey],
    queryFn: () => api<{ values: string[] }>(`/input-history?key=${encodeURIComponent(paramKey)}`),
    staleTime: 30_000,
    enabled: open,
  })

  async function remove(v: string) {
    await api(`/input-history?key=${encodeURIComponent(paramKey)}&value=${encodeURIComponent(v)}`, {
      method: 'DELETE',
    })
    void qc.invalidateQueries({ queryKey: ['input-history', paramKey] })
  }

  const values = history.data?.values ?? []
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 px-2" title="输入历史">
            <HistoryIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
          {values.map((v) => (
            <DropdownMenuItem key={v} onSelect={() => onChange(v)} className="flex items-center gap-2">
              <span className="max-w-72 truncate" title={v}>
                {v}
              </span>
              <button
                type="button"
                className="ml-auto rounded p-0.5 hover:bg-muted"
                title="删除该条历史"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(v)
                }}
              >
                <XIcon className="size-3" />
              </button>
            </DropdownMenuItem>
          ))}
          {values.length === 0 && <DropdownMenuItem disabled>（无历史）</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
```

- [ ] **Step 2: 表格行接入**

`apps/web/src/pages/batch-new.tsx`：

- import 区加 `import { TextValueControl } from '@/components/text-value-control'`
- `TableEntry` 内表格单元格的最后一个分支（`p.type === 'enum'` 的 `EnumValueSelect` 之后的兜底 `<Input ...>`）改为先判 text。将

```tsx
                  ) : (
                    <Input
                      className="h-8"
                      placeholder={String(p.default ?? '')}
                      value={String(row[p.key] ?? '')}
                      onChange={(e) => {
                        const next = rows.map((r, j) =>
                          j === i ? { ...r, [p.key]: e.target.value } : r,
                        )
                        update(next)
                      }}
                    />
                  )}
```

改为：

```tsx
                  ) : p.type === 'text' ? (
                    <TextValueControl
                      paramKey={p.key}
                      placeholder={String(p.default ?? '')}
                      value={String(row[p.key] ?? '')}
                      onChange={(v) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, [p.key]: v } : r))
                        update(next)
                      }}
                    />
                  ) : (
                    <Input
                      className="h-8"
                      placeholder={String(p.default ?? '')}
                      value={String(row[p.key] ?? '')}
                      onChange={(e) => {
                        const next = rows.map((r, j) =>
                          j === i ? { ...r, [p.key]: e.target.value } : r,
                        )
                        update(next)
                      }}
                    />
                  )}
```

- [ ] **Step 3: 矩阵共享区接入**

`apps/web/src/components/matrix-entry.tsx`：

- import 区加 `import { TextValueControl } from '@/components/text-value-control'`
- 共享参数网格里的兜底分支（`p.type === 'image'` 的 `ImageValueControl` 之后的 `<Input ...>`）改为先判 text。将

```tsx
                ) : (
                  <Input
                    placeholder={String(p.default ?? '')}
                    value={String(shared[p.key] ?? '')}
                    onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
                  />
                )}
```

改为：

```tsx
                ) : p.type === 'text' ? (
                  <TextValueControl
                    paramKey={p.key}
                    placeholder={String(p.default ?? '')}
                    value={String(shared[p.key] ?? '')}
                    onChange={(v) => setShared((prev) => ({ ...prev, [p.key]: v }))}
                  />
                ) : (
                  <Input
                    placeholder={String(p.default ?? '')}
                    value={String(shared[p.key] ?? '')}
                    onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
                  />
                )}
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净、215 通过

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/text-value-control.tsx apps/web/src/pages/batch-new.tsx apps/web/src/components/matrix-entry.tsx
git commit -m "feat(web): TextValueControl 历史下拉接入表格行与矩阵共享区"
```

---

## 手动验收清单（放 PR 描述,用户执行）

1. 表格行 text 参数出现历史按钮；建一批后再新建，下拉能看到上批的值，点击回填
2. 矩阵共享区 text 参数同样可用
3. 历史按 key 跨模板共享（另一模板同名 key 能看到）
4. 单条 × 删除后立即从下拉消失（且不触发回填）
5. 无历史时显示「（无历史）」
6. number/seed 输入框无历史按钮（未挂）
