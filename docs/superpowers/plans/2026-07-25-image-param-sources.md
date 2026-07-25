# image 参数多来源支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** image 参数支持三种来源——本机内联上传、服务端已上传文件、GPU 主机 input 目录已有文件；表格/矩阵录入模式提供选择与上传控件。

**Architecture:** 执行器改为"存在性回退"（服务端 uploads 有文件则上传替换，没有则文件名原样注入 prompt 引用 GPU 侧文件）；新增两个只读端点（GET /api/uploads 列服务端已上传、GET /api/comfy/input-files 借 LoadImage COMBO 列 GPU 侧文件）；前端新 ImageValueControl（表格单元格）与 ImageAxisPick（矩阵轴）。

**Tech Stack:** 现有栈（Hono、drizzle、React 19 + react-query + shadcn），无新依赖。

**Spec:** `docs/superpowers/specs/2026-07-25-image-param-sources-design.md`

## Global Constraints

- ESM + TS strict；测试 vitest 离线；pnpm 11（不改 pnpm-workspace.yaml，不设 minimum-release-age）
- `api()` 对非 2xx 抛 `Error(响应体文本)`；上传端点 `POST /api/uploads` 已存在（multipart `files` 字段，返回 201 `[{name, stored}]`）
- 中文 UI 文案；commit message 英文，trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 每任务完成后对应包测试 + `tsc --noEmit` 全绿才 commit
- 执行器回退语义（已裁决）：值含 `..` 或绝对路径 → 不读本地直接原样传；本地存在 → 上传替换；本地不存在 → 原样传

---

### Task 1: server — 执行器存在性回退

**Files:**
- Modify: `apps/server/src/executor.ts`（image 分支，约 104-112 行）
- Test: `apps/server/test/executor.test.ts`

**Interfaces:**
- Consumes: 现有 `comfy.uploadImage`、`FakeComfy.uploads`
- Produces: image 参数新语义（本地缺失原样注入）——Task 3/4 的 UI 与 CSV 依赖此语义

- [ ] **Step 1: 写失败测试**

`apps/server/test/executor.test.ts` 追加（沿用文件顶部 `params`/`seed`/`makeExecutor`/`comfy`；`comfyJson` 已含节点 '10' LoadImage）：

```ts
  it('image 参数本地不存在时原样注入(引用 GPU 侧文件)', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    seed([{ prompt: 'a', img: 'gpu-side.png' }], p)
    await makeExecutor().runPendingOnce()
    expect(comfy.uploads).toHaveLength(0)
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('gpu-side.png')
  })

  it('image 参数含 .. 时不读本地原样传', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    seed([{ prompt: 'a', img: '../secret.png' }], p)
    await makeExecutor().runPendingOnce()
    expect(comfy.uploads).toHaveLength(0)
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('../secret.png')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/executor.test.ts`
Expected: 新增 2 例 FAIL（当前实现对不存在的文件调用 uploadImage 抛 ENOENT → job failed，断言不满足）

- [ ] **Step 3: 实现**

`apps/server/src/executor.ts`：确保导入含 `existsSync`（`node:fs`）与 `isAbsolute`（并入现有 `node:path` 导入）。image 分支改为：

```ts
    for (const def of template.params) {
      if (def.type !== 'image') continue
      const v = values[def.key] ?? def.default
      if (typeof v === 'string' && v) {
        const local = join(this.dataDir, 'uploads', v)
        // 本地 uploads 有则上传替换;没有(或含 ../绝对路径)原样传,引用 GPU 侧 input 已有文件
        if (!v.includes('..') && !isAbsolute(v) && existsSync(local)) {
          values[def.key] = await this.comfy.uploadImage(local)
        }
      }
    }
```

- [ ] **Step 4: 全绿验证**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server exec tsc --noEmit`
Expected: 全部 PASS（既有 'uploads image params before submit' 测试覆盖本地存在路径的回归）

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): image params fall back to ComfyUI-side files when not in uploads"
```

---

### Task 2: server — GET /api/uploads + GET /api/comfy/input-files

**Files:**
- Modify: `apps/server/src/routes/files.ts`（uploadRoutes 加 GET /）
- Modify: `apps/server/src/routes/comfy.ts`（加 GET /input-files）
- Test: `apps/server/test/routes.test.ts`、`apps/server/test/comfy-routes.test.ts`

**Interfaces:**
- Consumes: `deps.config.dataDir`；`ObjectInfoCache`（comfy.ts 内已有 `objectInfo()` 辅助）
- Produces: `GET /api/uploads` → 200 `{ files: string[] }`（mtime 倒序，跳过子目录，目录不存在返回空）；`GET /api/comfy/input-files` → 200 `{ files: string[] }` / 503 离线——Task 3/4 前端 hooks 依赖这两个形状

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes.test.ts` 追加（文件已有 mkdtempSync/mkdirSync/writeFileSync/existsSync/tmpdir/join/createDb/createApp/loadConfig/EventEmitter 等导入——若缺 `utimesSync` 并入 `node:fs` 导入）：

```ts
describe('GET /api/uploads', () => {
  it('目录不存在返回空;有文件按修改时间倒序且跳过子目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-ls-'))
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: createDb(':memory:'), comfy: null, events: new EventEmitter(),
    })
    expect(await (await localApp.request('/api/uploads', { headers: H })).json()).toEqual({ files: [] })

    const dir = join(dataDir, 'uploads')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), 'x')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'a.png'), past, past)
    writeFileSync(join(dir, 'b.png'), 'y')
    mkdirSync(join(dir, 'sub'))
    const res = (await (await localApp.request('/api/uploads', { headers: H })).json()) as { files: string[] }
    expect(res.files).toEqual(['b.png', 'a.png'])
  })
})
```

`apps/server/test/comfy-routes.test.ts` 追加（beforeEach 的 objectInfo 已含 `LoadImage: { input: { required: { image: [['existing.png'], { image_upload: true }] } } }`）：

```ts
describe('GET /api/comfy/input-files', () => {
  it('返回 LoadImage 的 GPU 侧输入文件清单', async () => {
    const res = await app.request('/api/comfy/input-files', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: ['existing.png'] })
  })

  it('object_info 无 LoadImage 时返回空数组', async () => {
    delete (comfy.objectInfo as Record<string, unknown>).LoadImage
    const res = await app.request('/api/comfy/input-files', { headers: H })
    expect(await res.json()).toEqual({ files: [] })
  })

  it('离线返回 503', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('down')
    }
    expect((await app.request('/api/comfy/input-files', { headers: H })).status).toBe(503)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/routes.test.ts test/comfy-routes.test.ts`
Expected: 新增用例 FAIL（GET /api/uploads 404；input-files 404）

- [ ] **Step 3: 实现**

`apps/server/src/routes/files.ts` — `node:fs` 导入并入 `readdirSync`，uploadRoutes 的 `app.post('/')` 之前加：

```ts
  app.get('/', (c) => {
    const dir = join(deps.config.dataDir, 'uploads')
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return c.json({ files: [] })
    }
    const files = entries
      .map((name) => ({ name, stat: statSync(join(dir, name), { throwIfNoEntry: false }) }))
      .filter((e) => e.stat?.isFile())
      .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
      .map((e) => e.name)
    return c.json({ files })
  })
```

`apps/server/src/routes/comfy.ts` — `app.get('/input-options', ...)` 之后加：

```ts
  /** GPU 主机 input 目录文件清单(借 LoadImage 的 COMBO 选项);enum 语义不受影响 */
  app.get('/input-files', async (c) => {
    const info = await objectInfo(c.req.query('refresh') === '1')
    if (!info) return c.json({ error: 'ComfyUI 离线,无法获取输入文件列表' }, 503)
    const spec = info.LoadImage?.input?.required?.image
    const files = Array.isArray(spec?.[0]) ? (spec[0] as unknown[]).map(String) : []
    return c.json({ files })
  })
```

- [ ] **Step 4: 全绿验证**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): list server uploads and ComfyUI-side input files"
```

---

### Task 3: web — hooks + ImageValueControl + 表格接入

**Files:**
- Create: `apps/web/src/hooks/use-upload-files.ts`
- Create: `apps/web/src/hooks/use-comfy-input-files.ts`
- Create: `apps/web/src/components/image-value-control.tsx`
- Modify: `apps/web/src/pages/batch-new.tsx`（TableEntry 单元格加 image 分支）

**Interfaces:**
- Consumes: Task 2 两端点；现有 `POST /api/uploads`（multipart `files` → 201 `[{name, stored}]`）；shadcn `DropdownMenu*`/`Button`/`Input`
- Produces: `useUploadFiles()` / `useComfyInputFiles()`（返回 react-query 结果，data 形状 `{files: string[]}`）；`ImageValueControl` props `{ value: string; onChange: (v: string) => void; placeholder?: string }`——Task 4 复用两个 hooks

- [ ] **Step 1: 创建 use-upload-files.ts**

```ts
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** 服务端 uploads 目录清单(最近上传在前) */
export function useUploadFiles() {
  return useQuery({
    queryKey: ['upload-files'],
    queryFn: () => api<{ files: string[] }>('/uploads'),
    staleTime: 30_000,
    retry: false,
  })
}
```

- [ ] **Step 2: 创建 use-comfy-input-files.ts**

```ts
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** GPU 主机 input 目录文件清单;离线时 isError,调用方隐藏该组 */
export function useComfyInputFiles() {
  return useQuery({
    queryKey: ['comfy-input-files'],
    queryFn: () => api<{ files: string[] }>('/comfy/input-files'),
    staleTime: 30_000,
    retry: false,
  })
}
```

- [ ] **Step 3: 创建 image-value-control.tsx**

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { ImageIcon, UploadIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { useUploadFiles } from '@/hooks/use-upload-files'
import { api } from '@/lib/api'

/** image 参数单值控件:手填 + 双来源下拉 + 本机上传 */
export function ImageValueControl({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()

  async function onFile(file: File) {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('files', file)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      const name = stored[0]?.stored
      if (name) onChange(name)
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Input
          className="h-8"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 px-2" title="选择已有文件">
              <ImageIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
            <DropdownMenuLabel>服务端已上传</DropdownMenuLabel>
            {(uploads.data?.files ?? []).map((f) => (
              <DropdownMenuItem key={`up-${f}`} onSelect={() => onChange(f)}>
                {f}
              </DropdownMenuItem>
            ))}
            {(uploads.data?.files ?? []).length === 0 && (
              <DropdownMenuItem disabled>（无）</DropdownMenuItem>
            )}
            {!gpuFiles.isError && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>GPU 主机已有</DropdownMenuLabel>
                {(gpuFiles.data?.files ?? []).map((f) => (
                  <DropdownMenuItem key={`gpu-${f}`} onSelect={() => onChange(f)}>
                    {f}
                  </DropdownMenuItem>
                ))}
                {(gpuFiles.data?.files ?? []).length === 0 && (
                  <DropdownMenuItem disabled>（无）</DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          disabled={uploading}
          title="上传本机图片"
          onClick={() => fileRef.current?.click()}
        >
          <UploadIcon className="size-4" />
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
            e.target.value = ''
          }}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 4: TableEntry 接入**

`apps/web/src/pages/batch-new.tsx`：顶部加 `import { ImageValueControl } from '@/components/image-value-control'`。TableEntry 单元格的三元最外层加 image 分支（在现有 `p.type === 'enum'` 判断之前）：

```tsx
                <TableCell key={p.key}>
                  {p.type === 'image' ? (
                    <ImageValueControl
                      value={String(row[p.key] ?? '')}
                      placeholder={String(p.default ?? '')}
                      onChange={(v) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, [p.key]: v } : r))
                        update(next)
                      }}
                    />
                  ) : p.type === 'enum' ? (
                    <EnumValueSelect
                      param={p}
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
                </TableCell>
```

- [ ] **Step 5: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): image value control with upload and dual-source picker in table entry"
```

---

### Task 4: web — ImageAxisPick + 矩阵接入

**Files:**
- Modify: `apps/web/src/pages/batch-new.tsx`（新组件 ImageAxisPick + MatrixEntry 接入）

**Interfaces:**
- Consumes: Task 3 的 `useUploadFiles`/`useComfyInputFiles`；现有 `POST /api/uploads`、`EnumAxisPick` 同款 axes 文本协议（换行分隔）
- Produces: 无下游消费

- [ ] **Step 1: 实现 ImageAxisPick**

`apps/web/src/pages/batch-new.tsx`：确保顶部导入含 `useRef`（并入 react 导入）、`useQueryClient`（并入 @tanstack/react-query 导入）、`useUploadFiles`/`useComfyInputFiles`（新行）。文件末尾（EnumAxisPick 之后）追加：

```tsx
/** image 参数矩阵轴:双来源勾选 + 本机多选上传追加 + 手填 */
function ImageAxisPick({
  text,
  onChange,
}: {
  text: string
  onChange: (v: string) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const chosen = new Set(lines)

  function toggle(name: string, checked: boolean) {
    const next = new Set(chosen)
    if (checked) next.add(name)
    else next.delete(name)
    onChange([...next].join('\n'))
  }

  async function onFiles(files: FileList) {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      onChange([...lines, ...stored.map((s) => s.stored)].join('\n'))
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const groups: Array<[string, string[]]> = [['服务端已上传', uploads.data?.files ?? []]]
  if (!gpuFiles.isError) groups.push(['GPU 主机已有', gpuFiles.data?.files ?? []])

  return (
    <div className="space-y-2">
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
        {groups.map(([label, files]) => (
          <div key={label}>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            {files.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.has(f)}
                  onChange={(e) => toggle(f, e.target.checked)}
                />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </label>
            ))}
            {files.length === 0 && <p className="text-xs text-muted-foreground">（无）</p>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
          上传本机图片
        </Button>
        {uploading && <span className="text-xs text-muted-foreground">上传中…</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <Textarea
        rows={3}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="也可手填,一行一个文件名"
      />
    </div>
  )
}
```

- [ ] **Step 2: MatrixEntry 接入**

MatrixEntry 参数渲染的三元最外层加 image 分支（现有 `p.type === 'enum'` 之前）：

```tsx
            {p.type === 'image' ? (
              <ImageAxisPick
                text={axes[p.key] ?? ''}
                onChange={(v) => setAxes((prev) => ({ ...prev, [p.key]: v }))}
              />
            ) : p.type === 'enum' ? (
              <EnumAxisPick
                param={p}
                text={axes[p.key] ?? ''}
                onChange={(v) => setAxes((prev) => ({ ...prev, [p.key]: v }))}
              />
            ) : (
              <Textarea
                rows={4}
                value={axes[p.key] ?? ''}
                onChange={(e) => setAxes((prev) => ({ ...prev, [p.key]: e.target.value }))}
              />
            )}
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/batch-new.tsx
git commit -m "feat(web): image axis multi-pick with inline upload in matrix entry"
```

---

### Task 5: README + 全仓验证

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前面全部任务

- [ ] **Step 1: 更新 README**

「使用流程」第 3 条：

```markdown
3. New Batch → 三种方式生成任务：表格/CSV、矩阵组合、批量图片
```

改为：

```markdown
3. New Batch → 三种方式生成任务：表格/CSV、矩阵组合、批量图片。image 参数支持三种来源：本机上传（表格/矩阵内联控件）、服务端已上传文件、GPU 主机 input 目录已有文件（CSV/手填直接写文件名即可——服务端没有该文件时会原样传给 ComfyUI 解析）
```

（若第 3 条当前文案与上述"改前"不完全一致，保留其既有措辞，仅追加 image 来源说明句。）

- [ ] **Step 2: 全仓验证**

Run: `pnpm -r test && pnpm -r typecheck && pnpm --filter @cwe/web build && pnpm --filter @cwe/server build`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: image param source options in usage flow"
```

---

## 手动验收清单（合并前人工过一遍）

- [ ] 表格模式 image 单元格：上传本机图片后值自动填入存储名，提交批次可出图
- [ ] 下拉两组来源可选；ComfyUI 断开后 GPU 组消失、其余可用
- [ ] 矩阵模式：勾选 + 上传追加行，生成组合数量正确
- [ ] CSV 填 GPU 主机 input 已有文件名，端到端出图（存在性回退生效）
- [ ] 打错文件名：job 失败且错误信息来自 ComfyUI（可接受语义确认）

## Self-Review 记录

- Spec 覆盖：§1.1 存在性回退+护栏 → Task 1；§1.2 GET /uploads → Task 2；§1.3 input-files（LoadImage COMBO、离线 503、无 LoadImage 空数组）→ Task 2；§2.1 ImageValueControl+表格接入 → Task 3；§2.2 ImageAxisPick+矩阵接入 → Task 4；§2.3 不变项（CSV/批量图片 tab 无改动——各任务均未触碰）；§3 错误表逐条（回退/穿越/503 隐组/空目录/上传失败提示不清值——ImageValueControl 的 catch 只 setError 不动 value）；§4 测试 → Task 1 executor 2 例 + Task 2 路由 4 例，web 无组件测试+手动清单；§5 边界未越。
- 类型一致性：两 hooks 返回 `{files:string[]}` 与 Task 2 响应一致；ImageValueControl props 在 Task 3 定义、仅 Task 3 使用；ImageAxisPick 的 text/onChange 协议与 EnumAxisPick 相同；POST /uploads 响应形状 `[{name,stored}]` 与 files.ts 实际一致。
- 占位符扫描：无；所有代码步骤完整。
- 注意：Task 3/4 都改 batch-new.tsx 导入区（Task 3 加 ImageValueControl import，Task 4 加 useRef/useQueryClient/hooks import），顺序执行无冲突。
