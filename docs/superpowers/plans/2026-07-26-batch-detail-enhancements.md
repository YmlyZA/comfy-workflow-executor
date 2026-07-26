# Batch 详情增强(复制新建+上下翻+Lightbox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 详情页支持「以此新建」（全部 jobs 参数预填到新建页表格 tab）、「← 更早 / 更新 →」相邻跳转、画廊 Lightbox 查看器。

**Architecture:** 服务端只加 `nav: { prevId, nextId }`（detail 响应，两条单行查询）。复制新建走前端：新建页读 `?from=<batchId>` 取详情（共享 react-query 缓存）预填模板/名称/表格行；Lightbox 是纯前端 Dialog 组件遍历已加载的 gallery 数组。

**Tech Stack:** Hono + drizzle + better-sqlite3（server）、React 19 + react-query + shadcn/radix-ui（web，复用 PR① 的 `ui/dialog.tsx`）、vitest。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-26-batch-detail-enhancements-design.md`
- server/shared 是 ESM：相对导入必须带 `.js` 后缀
- web 包约定：**不写渲染测试**（手动验收清单代替）；UI 文案一律中文
- 全量测试命令：`pnpm test`（根目录）；类型检查：`pnpm typecheck`
- 提交信息结尾加：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 当前分支 `feat/batch-detail-enhancements`（已存在，勿新建）
- 复制范围 = **全部 jobs**（成功/失败/取消都带，立项确认）

---

### Task 1: 服务端 detail 响应加 nav（prevId/nextId）

**Files:**
- Modify: `apps/server/src/db/repo.ts`（`getBatchDetail` 之后追加；第 1 行 drizzle 导入扩充）
- Modify: `apps/server/src/routes/batches.ts`（`app.get('/:id')`）
- Test: `apps/server/test/routes.test.ts`（`describe('batches routes')` 块之后追加）

**Interfaces:**
- Consumes: 现有 `createTemplate()` 测试辅助、`POST /api/templates/:id/batches`
- Produces: `repo.getBatchNav(db, id): { prevId: number | null; nextId: number | null }`；`GET /api/batches/:id` 响应新增顶层字段 `nav`（Task 2/3 的 `BatchDetailDto` 依赖）

- [ ] **Step 1: 写失败测试**

在 `apps/server/test/routes.test.ts` 的 `describe('batches routes')` 块之后追加：

```ts
describe('GET /api/batches/:id nav', () => {
  async function createBatchOn(templateId: number, name: string): Promise<number> {
    const res = await app.request(`/api/templates/${templateId}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name, jobs: [{ prompt: 'x' }] }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: number }).id
  }

  async function navOf(id: number) {
    const res = await app.request(`/api/batches/${id}`, { headers: H })
    expect(res.status).toBe(200)
    return ((await res.json()) as { nav: { prevId: number | null; nextId: number | null } }).nav
  }

  it('中间/首/尾 batch 的 prevId/nextId 正确', async () => {
    const t = await createTemplate()
    const a = await createBatchOn(t.id, 'a')
    const b = await createBatchOn(t.id, 'b')
    const c = await createBatchOn(t.id, 'c')
    expect(await navOf(b)).toEqual({ prevId: a, nextId: c })
    expect(await navOf(a)).toEqual({ prevId: null, nextId: b })
    expect(await navOf(c)).toEqual({ prevId: b, nextId: null })
  })

  it('单 batch 双 null', async () => {
    const t = await createTemplate()
    const only = await createBatchOn(t.id, 'only')
    expect(await navOf(only)).toEqual({ prevId: null, nextId: null })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: 新增 2 条 FAIL（`nav` 为 undefined）

- [ ] **Step 3: 最小实现**

`apps/server/src/db/repo.ts` 第 1 行改为：

```ts
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
```

`getBatchDetail` 之后追加：

```ts
/** 相邻 batch 导航:prev=更早(小于当前的最大 id),next=更新(大于当前的最小 id) */
export function getBatchNav(db: Db, id: number): { prevId: number | null; nextId: number | null } {
  const prev = db.select({ id: batches.id }).from(batches).where(lt(batches.id, id)).orderBy(desc(batches.id)).limit(1).get()
  const next = db.select({ id: batches.id }).from(batches).where(gt(batches.id, id)).orderBy(asc(batches.id)).limit(1).get()
  return { prevId: prev?.id ?? null, nextId: next?.id ?? null }
}
```

`apps/server/src/routes/batches.ts` 的 `app.get('/:id', ...)` 整体替换为：

```ts
app.get('/:id', (c) => {
  const id = Number(c.req.param('id'))
  const detail = repo.getBatchDetail(deps.db, id)
  if (!detail) return c.json({ error: 'batch not found' }, 404)
  return c.json({ ...detail, nav: repo.getBatchNav(deps.db, id) })
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: 全绿（含既有 detail 测试——响应加字段不破坏旧断言）

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repo.ts apps/server/src/routes/batches.ts apps/server/test/routes.test.ts
git commit -m "feat(server): batch 详情响应加 nav(prevId/nextId 相邻导航)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 新建页 `?from=` 复制预填 + TableEntry initialRows

**Files:**
- Modify: `apps/web/src/pages/batch-detail.tsx`（仅一处：`interface BatchDetailDto` 加 `export`）
- Modify: `apps/web/src/pages/batch-new.tsx`

**Interfaces:**
- Consumes: `GET /api/batches/:id`（含 Task 1 的 `nav`，本任务不读它）；`JobDto`/`BatchDetailDto`（`@/pages/batch-detail`）
- Produces: `BatchDetailDto` 变为导出类型（Task 3 复用）；`TableEntry` 新可选 prop `initialRows?: ParamValues[]`；`/batches/new?from=<id>` 预填行为（Task 3 的「以此新建」按钮指向它）

- [ ] **Step 1: 导出 BatchDetailDto**

`apps/web/src/pages/batch-detail.tsx`：`interface BatchDetailDto {` 改为 `export interface BatchDetailDto {`。

- [ ] **Step 2: batch-new.tsx 预填逻辑**

(a) 确认 react import 含 `useEffect, useRef, useState`（缺则补）；import 区追加：

```tsx
import type { BatchDetailDto } from '@/pages/batch-detail'
```

(b) `BatchNewPage` 组件内，`const [error, setError] = useState('')` 之后追加：

```tsx
  const [fromError, setFromError] = useState('')
  const [initialRows, setInitialRows] = useState<ParamValues[] | undefined>(undefined)
  const from = search.get('from')
  const fromBatch = useQuery({
    queryKey: ['batches', from],
    queryFn: () => api<BatchDetailDto>(`/batches/${from}`),
    enabled: from !== null,
  })
  const fromLoaded = useRef(false)
  useEffect(() => {
    if (from === null || fromLoaded.current) return
    if (fromBatch.isError) {
      fromLoaded.current = true
      setFromError(`加载来源 batch 失败(from=${from}),可手动选择模板继续`)
      return
    }
    if (!fromBatch.data) return
    fromLoaded.current = true
    const d = fromBatch.data
    setTemplateId(String(d.template.id))
    setName((prev) => prev || `${d.batch.name} 副本`)
    setInitialRows(d.jobs.map((j) => j.params))
  }, [from, fromBatch.data, fromBatch.isError])
```

(c) 模板 Select 的 `onValueChange` 改为（手动换模板时丢弃预填行，防止旧模板参数 key 泄漏进新模板）：

```tsx
onValueChange={(v) => { setTemplateId(v); setJobs([]); setInitialRows(undefined) }}
```

(d) 头部 `<div className="flex items-end gap-4">...</div>` 闭合之后追加一行：

```tsx
      {fromError && <p className="text-sm text-destructive">{fromError}</p>}
```

(e) 表格 tab 挂载点改为：

```tsx
<TableEntry template={template} onChange={setJobs} initialRows={initialRows} />
```

- [ ] **Step 3: TableEntry 加 initialRows prop**

`TableEntry` 签名与首行 state 改为（不传时行为与现状完全一致）：

```tsx
function TableEntry({
  template,
  onChange,
  initialRows,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
  initialRows?: ParamValues[]
}) {
  const [rows, setRows] = useState<ParamValues[]>(initialRows ?? [{}])
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/batch-detail.tsx apps/web/src/pages/batch-new.tsx
git commit -m "feat(web): 新建页 ?from= 复制已有 batch 全部参数到表格 tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 详情页——上下翻按钮 + 以此新建 + 画廊 Lightbox

**Files:**
- Modify: `apps/web/src/pages/batch-detail.tsx`

**Interfaces:**
- Consumes: Task 1 的 `nav` 字段；Task 2 已导出的 `BatchDetailDto`；PR① 的 `@/components/ui/dialog`（`Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter`）；现有 `outputUrl`、`JobDto`
- Produces: 无对外接口（页面内部组件 `Lightbox`）

- [ ] **Step 1: 类型与 import**

(a) `BatchDetailDto` 加字段：

```tsx
export interface BatchDetailDto {
  batch: { id: number; name: string; status: BatchStatus; createdAt: string }
  template: TemplateDto
  jobs: JobDto[]
  nav: { prevId: number | null; nextId: number | null }
}
```

(b) import 调整：

```tsx
import { Link, useNavigate, useParams } from 'react-router-dom'   // 追加 Link, useNavigate
import { useState } from 'react'                                   // 新增行
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'                                    // 新增块
```

- [ ] **Step 2: 标题栏加导航与「以此新建」**

(a) 组件内加 `const navigate = useNavigate()` 与 `const [lightbox, setLightbox] = useState<number | null>(null)`（与其他 hook 并列，放在 `if (!data) return null` **之前**）。

(b) 标题左侧组（`<div className="flex items-center gap-3">` 内、`<h1>` 之前）插入：

```tsx
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={data.nav.prevId === null}
              onClick={() => navigate(`/batches/${data.nav.prevId}`)}
            >
              ← 更早
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.nav.nextId === null}
              onClick={() => navigate(`/batches/${data.nav.nextId}`)}
            >
              更新 →
            </Button>
          </span>
```

(c) 右侧操作区（「下载 ZIP」按钮之前）插入：

```tsx
          <Button asChild variant="outline">
            <Link to={`/batches/new?from=${batch.id}`}>以此新建</Link>
          </Button>
```

- [ ] **Step 3: 画廊改 Lightbox**

(a) 画廊 `gallery.map(...)` 的 `<a>` 整体替换为 button（样式保持，点击开查看器）：

```tsx
            {gallery.map(({ job, output }, i) => (
              <button
                type="button"
                key={output.path}
                onClick={() => setLightbox(i)}
                className="group space-y-1 text-left"
              >
                <img
                  src={outputUrl(output.path)}
                  alt={output.filename}
                  loading="lazy"
                  className="aspect-square w-full rounded-md border object-cover transition group-hover:opacity-80"
                />
                <p className="truncate font-mono text-xs text-muted-foreground">
                  #{job.sortOrder} {JSON.stringify(job.params)}
                </p>
              </button>
            ))}
```

(b) 页面根 `<div className="space-y-6">` 闭合前追加：

```tsx
      {lightbox !== null && (
        <Lightbox
          items={gallery}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
        />
      )}
```

(c) 文件底部追加组件：

```tsx
function Lightbox({
  items,
  index,
  onClose,
  onIndex,
}: {
  items: Array<{ job: JobDto; output: { path: string; filename: string } }>
  index: number
  onClose: () => void
  onIndex: (i: number) => void
}) {
  const cur = items[index]
  if (!cur) return null
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="sm:max-w-4xl"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
          if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1)
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-normal text-muted-foreground">
            {index + 1} / {items.length} · #{cur.job.sortOrder} · {cur.output.filename}
          </DialogTitle>
        </DialogHeader>
        <img
          src={outputUrl(cur.output.path)}
          alt={cur.output.filename}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
        <p className="max-h-20 overflow-y-auto font-mono text-xs text-muted-foreground">
          {JSON.stringify(cur.job.params)}
        </p>
        <DialogFooter className="sm:justify-between">
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={index === 0} onClick={() => onIndex(index - 1)}>
              ←
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={index === items.length - 1}
              onClick={() => onIndex(index + 1)}
            >
              →
            </Button>
          </span>
          <Button asChild size="sm" variant="outline">
            <a href={outputUrl(cur.output.path)} target="_blank" rel="noreferrer">
              查看原图
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

说明：图片用 `max-h-[70vh]`（spec 写 80vh，但 Dialog 还有标题/参数/按钮三段，70vh 才能保证整体不超屏——以本 plan 为准）；键盘事件挂在 `DialogContent`（Radix 打开时聚焦 content，←/→ 直接可用）；Esc 关闭是 Dialog 默认行为。

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/batch-detail.tsx
git commit -m "feat(web): 详情页相邻导航+以此新建+画廊 Lightbox

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（合并前用户过一遍）

1. 详情页「以此新建」→ 新建页预填模板、名称「原名 副本」、全部 jobs 行（含失败/取消的），删改后提交成功
2. 含 image 参数的 batch 复制后直接提交可运行
3. `/batches/new?from=99999` → 错误提示，手动流程不受影响；预填后手动换模板 → 预填行被清空
4. 详情页「← 更早 / 更新 →」跳转正确，首尾对应禁用
5. 画廊点图打开 Lightbox：大图、信息条、i/N 计数；←/→ 键盘与按钮导航、首尾钳制；Esc 关闭
6. Lightbox 内「查看原图」新开页仍可用
