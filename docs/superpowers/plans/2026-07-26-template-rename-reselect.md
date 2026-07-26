# 模板改名 + 从模板重选参数 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模板列表支持改名（PATCH，不动 id/params/comfyJson）；「重选参数」入口从已有模板带入 comfyJson 重新圈选参数另存新模板。

**Architecture:** 服务端只加一个 `PATCH /api/templates/:id` 改名端点（zod schema 放 shared，与 createTemplateSchema 同处）。重选参数零服务端改动：`GET /api/templates` 已返回完整 comfyJson+params，导入页读 `?from=<id>` 后复用现有 `ingest()` 流程，预选改用源模板的 params。

**Tech Stack:** Hono + drizzle + better-sqlite3（server）、React 19 + react-query + shadcn/radix-ui（web）、vitest。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-26-template-rename-reselect-design.md`
- server/shared 是 ESM：相对导入必须带 `.js` 后缀
- web 包约定：**不写渲染测试**（手动验收清单代替）
- UI 文案一律中文
- 全量测试命令：`pnpm test`（根目录）；类型检查：`pnpm typecheck`
- 提交信息结尾加：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 当前分支 `feat/template-rename-reselect`（已存在，勿新建）

---

### Task 1: 服务端改名端点（shared schema + repo + route）

**Files:**
- Modify: `packages/shared/src/types.ts`（`createTemplateSchema` 之后追加）
- Modify: `apps/server/src/db/repo.ts`（`deleteTemplate` 之后追加）
- Modify: `apps/server/src/routes/templates.ts`（`app.patch('/order')` **之后**追加——`/order` 静态路由必须先注册）
- Test: `apps/server/test/routes.test.ts`（`describe('PATCH /api/templates/order')` 之后追加）

**Interfaces:**
- Consumes: 现有 `templateBody`/`createTemplate()` 测试辅助（routes.test.ts 顶部已有）
- Produces: `renameTemplateSchema`（shared 导出）、`repo.renameTemplate(db, id, name): Template | undefined`、`PATCH /api/templates/:id` → 200 返回更新后模板行 / 404 / 400（后续任务不依赖，仅前端调用）

- [ ] **Step 1: 写失败测试**

在 `apps/server/test/routes.test.ts` 的 `describe('PATCH /api/templates/order')` 块之后追加：

```ts
describe('PATCH /api/templates/:id', () => {
  it('改名成功,返回新名且列表可见', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '新名字' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('新名字')
    const list = (await (await app.request('/api/templates', { headers: H })).json()) as Array<{ name: string }>
    expect(list[0]!.name).toBe('新名字')
  })

  it('未知 id 404', async () => {
    const res = await app.request('/api/templates/999', {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('空名 400', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: 新增 3 条 FAIL（PATCH /:id 现在会落到 404 兜底或 zod 抛错——只要 3 条不全绿即可；「改名成功」条必须 FAIL）

- [ ] **Step 3: 最小实现**

`packages/shared/src/types.ts`，`createTemplateSchema`/`CreateTemplateInput` 之后追加：

```ts
export const renameTemplateSchema = z.object({ name: z.string().min(1) })
export type RenameTemplateInput = z.infer<typeof renameTemplateSchema>
```

`apps/server/src/db/repo.ts`，`deleteTemplate` 之后追加：

```ts
export function renameTemplate(db: Db, id: number, name: string): Template | undefined {
  return db.update(templates).set({ name }).where(eq(templates.id, id)).returning().get()
}
```

`apps/server/src/routes/templates.ts`：import 行改为从 `@cwe/shared` 多引入 `renameTemplateSchema`：

```ts
import { createBatchSchema, createTemplateSchema, renameTemplateSchema } from '@cwe/shared'
```

在 `app.patch('/order', ...)` 块**之后**、`app.post('/', ...)` 之前追加（zod parse 抛错由 app 级错误处理转 400，与 POST 同模式）：

```ts
app.patch('/:id', async (c) => {
  const { name } = renameTemplateSchema.parse(await c.req.json())
  const t = repo.renameTemplate(deps.db, Number(c.req.param('id')), name)
  if (!t) return c.json({ error: 'template not found' }, 404)
  return c.json(t)
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: 全绿（含新增 3 条；`PATCH /api/templates/order` 既有 4 条也必须仍绿——静态路由未被 `/:id` 抢走）

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts apps/server/src/db/repo.ts apps/server/src/routes/templates.ts apps/server/test/routes.test.ts
git commit -m "feat(server): PATCH /api/templates/:id 模板改名

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 模板列表行操作——重命名对话框 + 重选参数入口

**Files:**
- Create: `apps/web/src/components/ui/dialog.tsx`（手写 shadcn 风格子集；项目用统一 `radix-ui` 包，`Dialog` 原语已在依赖内，零新依赖——镜像 `alert-dialog.tsx` 的写法）
- Modify: `apps/web/src/pages/templates.tsx`

**Interfaces:**
- Consumes: Task 1 的 `PATCH /api/templates/:id`（body `{ name }`）；现有 `api`、`apiErrorText`、`TemplateDto`
- Produces: `components/ui/dialog.tsx` 导出 `Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter`（Task 3 不用；后续 PR 可复用）；templates 行操作出现「⋯」菜单（重命名/重选参数），重选参数跳 `/templates/new?from=<id>`

- [ ] **Step 1: 创建 `apps/web/src/components/ui/dialog.tsx`**

```tsx
import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-hidden">
          <XIcon className="size-4" />
          <span className="sr-only">关闭</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  )
}

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle }
```

- [ ] **Step 2: templates.tsx 接入行操作**

`apps/web/src/pages/templates.tsx` 改动四处：

(a) import 区追加（保持既有分组风格）：

```tsx
import { MoreHorizontalIcon } from 'lucide-react'
import { useEffect, useState } from 'react'   // 替换原 useState 单独导入行
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
```

(b) `columns` 中 `id: 'actions'` 列的 `cell` 整体替换为：

```tsx
    cell: ({ row }) => <RowActions t={row.original} />,
```

(c) 文件底部追加 `RowActions`（「新建 Batch」保持一级按钮，低频操作收进「⋯」菜单，行宽不膨胀）：

```tsx
function RowActions({ t }: { t: TemplateDto }) {
  const [renameOpen, setRenameOpen] = useState(false)
  return (
    <span className="flex items-center justify-end gap-1 whitespace-nowrap">
      <Button asChild size="sm" variant="outline">
        <Link to={`/batches/new?template=${t.id}`}>新建 Batch</Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="px-2" aria-label="更多操作">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>重命名</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/templates/new?from=${t.id}`}>重选参数</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog t={t} open={renameOpen} onOpenChange={setRenameOpen} />
    </span>
  )
}
```

(d) 继续追加 `RenameDialog`：

```tsx
function RenameDialog({
  t,
  open,
  onOpenChange,
}: {
  t: TemplateDto
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(t.name)
  const [error, setError] = useState('')
  // 每次打开回到当前名并清错(列表刷新后重开也拿到最新名)
  useEffect(() => {
    if (open) {
      setName(t.name)
      setError('')
    }
  }, [open, t.name])
  const rename = useMutation({
    mutationFn: (next: string) =>
      api(`/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ name: next }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['templates'] })
      onOpenChange(false)
    },
    onError: (e) => setError(apiErrorText(e)),
  })
  const trimmed = name.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名模板</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !rename.isPending) rename.mutate(trimmed)
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!trimmed || rename.isPending} onClick={() => rename.mutate(trimmed)}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（web 无渲染测试，靠类型检查兜底）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/dialog.tsx apps/web/src/pages/templates.tsx
git commit -m "feat(web): 模板列表行操作——重命名对话框 + 重选参数入口

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 导入页 `?from=` 从模板带入并预选参数

**Files:**
- Modify: `apps/web/src/pages/template-import.tsx`

**Interfaces:**
- Consumes: `GET /api/templates`（react-query key `['templates']`，与列表页共享缓存）；`TemplateDto`（`@/pages/templates`）；`EnumRef`（`@cwe/shared`）；现有 `ingest`/`Selection`/`apiErrorMessage`
- Produces: 无对外接口；`ingest` 第三参 `preset?: { sel: Record<string, Selection>; refs: Map<string, EnumRef> }`

- [ ] **Step 1: 改造 ingest 支持预设圈选**

`apps/web/src/pages/template-import.tsx`：

(a) import 调整：

```tsx
import { useMutation, useQuery } from '@tanstack/react-query'   // 追加 useQuery
import { useEffect, useRef, useState } from 'react'             // 追加 useEffect
import { useNavigate, useSearchParams } from 'react-router-dom' // 追加 useSearchParams
import type { EnumRef, ParamDef, ParamType } from '@cwe/shared' // 追加 EnumRef
import type { TemplateDto } from '@/pages/templates'            // 新增行
```

(b) `ingest` 签名加第三参：

```tsx
  /** 返回是否成功导入(被更新的导入取代视为不成功,但不写任何状态) */
  async function ingest(
    parsed: unknown,
    sourceName: string,
    preset?: { sel: Record<string, Selection>; refs: Map<string, EnumRef> },
  ): Promise<boolean> {
```

(c) `ingest` 内部：在 `if (seq !== importSeq.current) return false`（validate 之后那次检查）与 `setJson(comfyJson)` 之间，把原来的 `const pre` 构造块：

```tsx
      const pre: Record<string, Selection> = {}
      for (const s of suggestParams(comfyJson)) {
        pre[`${s.nodeId}.${s.inputName}`] = { key: s.key, type: s.type }
      }
```

整体替换为：

```tsx
      // 从模板重选:预选与 enumRef 用源模板的 params(离线时 enum 类型也不丢);否则走智能预选
      for (const [id, ref] of preset?.refs ?? []) {
        if (!refs.has(id)) refs.set(id, ref)
      }
      const pre: Record<string, Selection> = preset ? { ...preset.sel } : {}
      if (!preset) {
        for (const s of suggestParams(comfyJson)) {
          pre[`${s.nodeId}.${s.inputName}`] = { key: s.key, type: s.type }
        }
      }
```

- [ ] **Step 2: 挂载时读 ?from= 触发导入**

组件内 state 声明之后（`const [busy, setBusy] = useState(false)` 下方）追加：

```tsx
  const [searchParams] = useSearchParams()
  const from = searchParams.get('from')
  const fromTemplates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
    enabled: from !== null,
  })
  const fromLoaded = useRef(false)
  useEffect(() => {
    if (from === null || fromLoaded.current) return
    if (fromTemplates.isError) {
      fromLoaded.current = true
      setError(`加载模板失败:${apiErrorMessage(fromTemplates.error)}`)
      return
    }
    if (!fromTemplates.data) return
    fromLoaded.current = true
    const t = fromTemplates.data.find((x) => x.id === Number(from))
    if (!t) {
      setError(`模板不存在(from=${from}),可改用下方手动导入`)
      return
    }
    const sel: Record<string, Selection> = {}
    const refs = new Map<string, EnumRef>()
    for (const p of t.params) {
      const id = `${p.nodeId}.${p.inputName}`
      sel[id] = { key: p.key, type: p.type, ...(p.enumRef ? { enumRef: p.enumRef } : {}) }
      if (p.enumRef) refs.set(id, p.enumRef)
    }
    void ingest(t.comfyJson, `${t.name} 副本`, { sel, refs })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fromLoaded 保证只跑一次,ingest/error 依赖无需追踪
  }, [from, fromTemplates.data, fromTemplates.isError])
```

说明：名称预填走 `ingest` 既有逻辑（`if (!name && sourceName) setName(sourceName)`），自动满足「仅当名称为空时预填」；comfyJson 是 API 格式，`detectFormat` 直接命中不走转换。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/template-import.tsx
git commit -m "feat(web): 导入页支持 ?from= 从已有模板重选参数另存

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（合并前用户过一遍）

1. 列表重命名生效，关联 batch 的模板显示同步变化，batch 数据不受影响
2. 「重选参数」进入导入页：参数预选 = 源模板参数（key/type 一致）、名称预填「原名 副本」
3. 改动圈选后另存 → 新模板入列表，原模板参数无变化
4. ComfyUI 离线时重选：enum 参数类型与 enumRef 保留
5. 手动导入流程（文件/PNG/粘贴）不受 `?from=` 改动影响
