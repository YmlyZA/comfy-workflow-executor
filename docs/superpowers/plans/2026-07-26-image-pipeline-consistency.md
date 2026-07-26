# UI 打磨与 image 输入一致化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Templates 列表列宽约束；批量图片 tab 支持双来源选择；上传按内容 hash 去重；文件选择列表带缩略图预览。

**Architecture:** 服务端三个小改动（POST /uploads 去重、两个只读文件端点、executor 进程内上传缓存）；前端把矩阵 tab 的双来源选择器抽成共享组件 `ImageMultiPick`，批量图片 tab 改为「已选文件集合 → 声明式派生 jobs」。规格见 `docs/superpowers/specs/2026-07-26-image-pipeline-consistency-design.md`。

**Tech Stack:** Hono + better-sqlite3 + vitest（server）；React 19 + react-query + shadcn/ui（web）；pnpm 11 monorepo。

## Global Constraints

- server/shared 是 ESM：**相对导入必须带 `.js` 后缀**（如 `../src/app.js`）
- web 约定**不写渲染测试**，UI 文案用中文
- 不新增依赖，不改 `pnpm-workspace.yaml`
- 测试命令：`pnpm --filter @cwe/server test`、根目录 `pnpm test`（全部）、`pnpm typecheck`
- 提交信息结尾加 trailer：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 当前分支 `feat/image-pipeline-consistency`，直接在其上提交

---

### Task 1: POST /uploads 内容 hash 去重

**Files:**
- Modify: `apps/server/src/routes/files.ts`（uploadRoutes 的 POST handler，当前 30-48 行）
- Test: `apps/server/test/files.test.ts`（更新 3 个既有断言 + 新增 3 个去重测试）

**Interfaces:**
- Produces: `POST /api/uploads` 返回结构不变 `[{ name, stored }]`；stored 命名从 `8位hex-safe名` 改为 `sha256前16位hex-safe名`；同内容复用已有文件名
- Consumes: 无

- [ ] **Step 1: 更新既有测试的命名断言并新增去重测试（先写失败测试）**

`apps/server/test/files.test.ts`：顶部 import 行加 `readdirSync`：

```ts
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
```

把两处 `/^[a-f0-9]{8}-cat\.png$/` 与 `/^[a-f0-9]{8}-photo\.final\.png$/` 改为 16 位：

```ts
expect(body[0]?.stored).toMatch(/^[a-f0-9]{16}-cat\.png$/)
```

```ts
expect(body[0]?.stored).toMatch(/^[a-f0-9]{16}-photo\.final\.png$/)
```

在 `describe('uploads', ...)` 内追加：

```ts
  async function uploadOne(content: string, fname: string): Promise<string> {
    const form = new FormData()
    form.append('files', new Blob([content]), fname)
    const res = await app.request('/api/uploads', { method: 'POST', headers: H, body: form })
    expect(res.status).toBe(201)
    return ((await res.json()) as Array<{ stored: string }>)[0]!.stored
  }

  it('同内容重复上传返回同名且不新增文件', async () => {
    const first = await uploadOne('same-bytes', 'a.png')
    const second = await uploadOne('same-bytes', 'a.png')
    expect(second).toBe(first)
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([first])
  })

  it('同内容不同原名复用先到者', async () => {
    const first = await uploadOne('same-bytes', 'a.png')
    const second = await uploadOne('same-bytes', 'b.png')
    expect(second).toBe(first)
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([first])
  })

  it('不同内容得到不同存储名', async () => {
    const first = await uploadOne('bytes-1', 'a.png')
    const second = await uploadOne('bytes-2', 'a.png')
    expect(second).not.toBe(first)
    expect(readdirSync(join(dataDir, 'uploads')).sort()).toEqual([first, second].sort())
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- files`
Expected: FAIL——16 位正则断言失败（现实现是 8 位随机 hex），去重测试 `second === first` 失败

- [ ] **Step 3: 实现去重**

`apps/server/src/routes/files.ts`：把第 1 行 `import { randomBytes } from 'node:crypto'` 改为 `import { createHash } from 'node:crypto'`，POST handler 整体替换为：

```ts
  app.post('/', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const raw = body['files']
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: 'no files' }, 400)
    const dir = join(deps.config.dataDir, 'uploads')
    const stored: Array<{ name: string; stored: string }> = []
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer())
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
      // 同内容(hash 前缀相同)复用已有文件,不重复写盘;返回名以先到者为准
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        // 目录不存在时走写盘路径,由 writeFile 抛错(与旧行为一致)
      }
      const existing = entries.find((n) => n.startsWith(`${hash}-`))
      if (existing) {
        stored.push({ name: file.name, stored: existing })
        continue
      }
      const safe = basename(file.name)
        .replace(/[^\w.-]/g, '_')
        .replace(/\.{2,}/g, '.')
      const name = `${hash}-${safe}`
      await writeFile(join(dir, name), buf)
      stored.push({ name: file.name, stored: name })
    }
    return c.json(stored, 201)
  })
```

（`readdirSync` 已在文件顶部 import，无需新增。旧文件是 8 位 hex 前缀，长度不同不会被 16 位前缀误匹配。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- files`
Expected: PASS（全部 uploads / outputs / zip / sse 测试绿）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/files.ts apps/server/test/files.test.ts
git commit -m "feat(server): uploads 按内容 sha256 去重,同内容复用已有文件

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 文件内容端点（uploads serve + GPU input 代理）

**Files:**
- Create: `apps/server/src/mime.ts`
- Modify: `apps/server/src/routes/files.ts`（uploadRoutes 加 GET /:name）
- Modify: `apps/server/src/routes/comfy.ts`（加 GET /input-image）
- Test: `apps/server/test/files.test.ts`、`apps/server/test/comfy-routes.test.ts`

**Interfaces:**
- Produces: `GET /api/uploads/:name`（200 文件流 / 400 非法名 / 404 不存在）；`GET /api/comfy/input-image?name=`（200 图片 bytes / 400 缺 name / 404 不存在 / 503 离线）；`imageMime(name: string): string`
- Consumes: 无（`getInputImage` 为既有 client 方法）

- [ ] **Step 1: 写失败测试**

`apps/server/test/files.test.ts` 追加：

```ts
describe('GET /api/uploads/:name', () => {
  it('返回文件内容与图片 Content-Type', async () => {
    writeFileSync(join(dataDir, 'uploads', 'abc-pic.png'), 'img-bytes')
    const res = await app.request('/api/uploads/abc-pic.png', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('img-bytes')
  })

  it('未知扩展名回退 octet-stream', async () => {
    writeFileSync(join(dataDir, 'uploads', 'abc-blob.xyz'), 'x')
    const res = await app.request('/api/uploads/abc-blob.xyz', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('路径穿越返回 400', async () => {
    const res = await app.request(`/api/uploads/${encodeURIComponent('../secret.png')}`, { headers: H })
    expect(res.status).toBe(400)
  })

  it('不存在返回 404', async () => {
    const res = await app.request('/api/uploads/nope.png', { headers: H })
    expect(res.status).toBe(404)
  })
})
```

`apps/server/test/comfy-routes.test.ts` 追加：

```ts
describe('GET /api/comfy/input-image', () => {
  it('缺 name 返回 400', async () => {
    expect((await app.request('/api/comfy/input-image', { headers: H })).status).toBe(400)
  })

  it('代理返回 GPU 侧图片内容与 Content-Type', async () => {
    comfy.inputImages['gpu.png'] = PNG_1X1
    const res = await app.request('/api/comfy/input-image?name=gpu.png', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_1X1)
  })

  it('不存在返回 404', async () => {
    expect((await app.request('/api/comfy/input-image?name=nope.png', { headers: H })).status).toBe(404)
  })

  it('comfy 未配置返回 503', async () => {
    const res = await makeApp(false).request('/api/comfy/input-image?name=x.png', { headers: H })
    expect(res.status).toBe(503)
  })

  it('getInputImage 抛错(离线)返回 503', async () => {
    comfy.getInputImage = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect((await app.request('/api/comfy/input-image?name=x.png', { headers: H })).status).toBe(503)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- files comfy-routes`
Expected: FAIL——两组新端点 404（路由不存在时 Hono 落到 `/api/*` 兜底 404，断言 400/503/Content-Type 的用例失败）

- [ ] **Step 3: 实现**

新建 `apps/server/src/mime.ts`：

```ts
import { extname } from 'node:path'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** 按扩展名给常见图片 Content-Type,未知回退 octet-stream */
export function imageMime(name: string): string {
  return IMAGE_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}
```

`apps/server/src/routes/files.ts`：顶部加 `import { imageMime } from '../mime.js'`，uploadRoutes 内（GET `/` 之后、POST 之前）插入：

```ts
  /** 上传文件内容(缩略图用);仅裸文件名,防穿越 */
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    if (name.includes('..') || basename(name) !== name) return c.json({ error: 'invalid name' }, 400)
    const full = join(deps.config.dataDir, 'uploads', name)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat?.isFile()) return c.json({ error: 'not found' }, 404)
    c.header('Content-Type', imageMime(name))
    return c.body(Readable.toWeb(createReadStream(full)) as ReadableStream)
  })
```

（`statSync`、`createReadStream`、`Readable`、`basename` 均已在文件顶部 import。）

`apps/server/src/routes/comfy.ts`：顶部加 `import { imageMime } from '../mime.js'`，在 `image-dims` 端点后追加：

```ts
  /** GPU 侧 input 图片内容代理(缩略图用);错误语义与 image-dims 对齐 */
  app.get('/input-image', async (c) => {
    const name = c.req.query('name') ?? ''
    if (!name) return c.json({ error: '缺少 name 参数' }, 400)
    if (!deps.comfy) return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
    let buf: ArrayBuffer | null
    try {
      buf = await deps.comfy.getInputImage(name)
    } catch {
      return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
    }
    if (!buf) return c.json({ error: '图片不存在' }, 404)
    c.header('Content-Type', imageMime(name))
    return c.body(buf)
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- files comfy-routes`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mime.ts apps/server/src/routes/files.ts apps/server/src/routes/comfy.ts apps/server/test/files.test.ts apps/server/test/comfy-routes.test.ts
git commit -m "feat(server): uploads 文件与 GPU input 图片只读端点(缩略图用)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: executor 进程内上传缓存

**Files:**
- Modify: `apps/server/src/executor.ts`（execute 方法，当前 104-122 行）
- Test: `apps/server/test/executor.test.ts`

**Interfaces:**
- Produces: 同一本地 stored 名在 Executor 实例生命周期内只调用一次 `comfy.uploadImage`，后续 job 复用 GPU 侧返回名
- Consumes: 无（`FakeComfy.uploads` 数组既有）

- [ ] **Step 1: 写失败测试**

`apps/server/test/executor.test.ts` 的 `describe('executor', ...)` 内追加：

```ts
  it('同一本地文件多个 job 只上传一次(进程内缓存)', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'uploads'), { recursive: true })
    await writeFile(join(dataDir, 'uploads', 'input.png'), 'x')
    seed(
      [
        { prompt: 'a', img: 'input.png' },
        { prompt: 'b', img: 'input.png' },
      ],
      p,
    )
    const ex = makeExecutor()
    await ex.runPendingOnce()
    await ex.runPendingOnce()
    expect(comfy.uploads).toHaveLength(1)
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('uploaded-input.png')
    expect(comfy.submitted[1]?.['10'].inputs.image).toBe('uploaded-input.png')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- executor`
Expected: FAIL——`comfy.uploads` 长度为 2

- [ ] **Step 3: 实现缓存**

`apps/server/src/executor.ts`：类字段区（`private disconnectWs` 之后）加：

```ts
  /** 本地 stored 名 → GPU 侧返回名;进程内去重,重启后靠 overwrite 幂等重传 */
  private readonly gpuUploads = new Map<string, string>()
```

`execute` 方法中把：

```ts
        if (!v.includes('..') && !isAbsolute(v) && existsSync(local)) {
          values[def.key] = await this.comfy.uploadImage(local)
        }
```

替换为：

```ts
        if (!v.includes('..') && !isAbsolute(v) && existsSync(local)) {
          let gpuName = this.gpuUploads.get(v)
          if (!gpuName) {
            gpuName = await this.comfy.uploadImage(local)
            this.gpuUploads.set(v, gpuName)
          }
          values[def.key] = gpuName
        }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- executor`
Expected: PASS（既有 image 上传/回退测试同样绿）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/executor.ts apps/server/test/executor.test.ts
git commit -m "feat(server): executor 进程内缓存已上传图片,同文件只传一次

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Templates 列表列宽约束

**Files:**
- Modify: `apps/web/src/pages/templates.tsx`（columns 定义中 name 与 params 两列的 cell）

**Interfaces:**
- Consumes: 无；Produces: 无（纯展示改动）

- [ ] **Step 1: 改两列 cell**

`apps/web/src/pages/templates.tsx`，name 列 cell 改为：

```tsx
    cell: ({ row }) => (
      <span className="block max-w-48 truncate font-medium" title={row.original.name}>
        {row.original.name}
      </span>
    ),
```

params 列 cell 改为（只显示前 3 个 Badge，其余折叠 `+N`，悬停看全部）：

```tsx
    cell: ({ row }) => {
      const params = row.original.params
      const rest = params.length - 3
      return (
        <span
          className="flex items-center gap-1 whitespace-nowrap"
          title={params.map((p) => `${p.key}:${p.type}`).join(', ')}
        >
          {params.slice(0, 3).map((p) => (
            <Badge key={p.key} variant="secondary" className="max-w-28">
              <span className="truncate">
                {p.key}:{p.type}
              </span>
            </Badge>
          ))}
          {rest > 0 && <Badge variant="outline">+{rest}</Badge>}
        </span>
      )
    },
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/templates.tsx
git commit -m "feat(web): templates 列表限宽,参数列折叠为前3个+N

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: ImageMultiPick 共享组件 + 缩略图

**Files:**
- Modify: `apps/web/src/lib/api.ts`（加两个 URL helper）
- Create: `apps/web/src/components/image-multi-pick.tsx`
- Modify: `apps/web/src/pages/batch-new.tsx`（ImageAxisPick 变薄壳）
- Modify: `apps/web/src/components/image-value-control.tsx`（下拉项加缩略图）

**Interfaces:**
- Produces:
  - `uploadFileUrl(name: string): string`、`comfyInputFileUrl(name: string): string`（lib/api）
  - `ImageMultiPick({ value: string[], onChange: (next: string[]) => void })`：双来源勾选 + 本机上传（成功自动选中）+ 缩略图；value 顺序即选中顺序
  - `FileThumb({ src: string })`：加载失败隐藏但保位的 size-8 缩略图
- Consumes: Task 2 的 `GET /api/uploads/:name` 与 `GET /api/comfy/input-image?name=`

- [ ] **Step 1: lib/api 加 URL helper**

`apps/web/src/lib/api.ts` 末尾追加：

```ts
export function uploadFileUrl(name: string): string {
  return `/api/uploads/${encodeURIComponent(name)}?token=${encodeURIComponent(getToken())}`
}

export function comfyInputFileUrl(name: string): string {
  return `/api/comfy/input-image?name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken())}`
}
```

- [ ] **Step 2: 新建 ImageMultiPick 组件**

新建 `apps/web/src/components/image-multi-pick.tsx`：

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { useUploadFiles } from '@/hooks/use-upload-files'
import { api, comfyInputFileUrl, uploadFileUrl } from '@/lib/api'

/** 缩略图:加载失败隐藏但保位,不破版式 */
export function FileThumb({ src }: { src: string }) {
  const [hidden, setHidden] = useState(false)
  return (
    <span className="size-8 shrink-0 overflow-hidden rounded">
      {!hidden && (
        <img
          src={src}
          loading="lazy"
          alt=""
          className="size-8 object-cover"
          onError={() => setHidden(true)}
        />
      )}
    </span>
  )
}

/** image 多选:双来源勾选 + 本机上传(成功自动选中);value 顺序即选中顺序 */
export function ImageMultiPick({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()
  const chosen = new Set(value)

  function toggle(name: string, checked: boolean) {
    if (checked) onChange([...value, name])
    else onChange(value.filter((v) => v !== name))
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
      // 去重上传可能返回已选中的名字,过滤避免重复
      const fresh = [...new Set(stored.map((s) => s.stored))].filter((s) => !chosen.has(s))
      onChange([...value, ...fresh])
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const groups: Array<[string, string[], (f: string) => string]> = [
    ['服务端已上传', uploads.data?.files ?? [], uploadFileUrl],
  ]
  if (!gpuFiles.isError && !gpuFiles.isLoading) {
    groups.push(['GPU 主机已有', gpuFiles.data?.files ?? [], comfyInputFileUrl])
  }
  const listed = new Set(groups.flatMap(([, files]) => files))
  // 已选但不在任何列表(如 GPU 离线后其文件从列表消失):仍渲染,保证能取消勾选
  const orphans = value.filter((v) => !listed.has(v))

  return (
    <div className="space-y-2">
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
        {groups.map(([label, files, urlOf]) => (
          <div key={label}>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            {files.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.has(f)}
                  onChange={(e) => toggle(f, e.target.checked)}
                />
                <FileThumb src={urlOf(f)} />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </label>
            ))}
            {files.length === 0 && <p className="text-xs text-muted-foreground">（无）</p>}
          </div>
        ))}
        {orphans.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">其他已选</p>
            {orphans.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked onChange={() => toggle(f, false)} />
                <FileThumb src={uploadFileUrl(f)} />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
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
    </div>
  )
}
```

- [ ] **Step 3: ImageAxisPick 变薄壳**

`apps/web/src/pages/batch-new.tsx`：整个 `ImageAxisPick` 函数（含其 JSDoc 注释）替换为：

```tsx
/** image 参数矩阵轴:复用 ImageMultiPick(换行文本 ↔ string[] 适配) + 手填 textarea */
function ImageAxisPick({
  text,
  onChange,
}: {
  text: string
  onChange: (v: string) => void
}) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (
    <div className="space-y-2">
      <ImageMultiPick value={lines} onChange={(next) => onChange(next.join('\n'))} />
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

batch-new.tsx 顶部 import 区：加 `import { ImageMultiPick } from '@/components/image-multi-pick'`；删除因此不再使用的 import（`useQueryClient`、`useUploadFiles`、`useComfyInputFiles`——先确认文件内无其他使用处再删；`useRef` 仍被 SourceDimCell 使用，保留）。

- [ ] **Step 4: ImageValueControl 下拉项加缩略图**

`apps/web/src/components/image-value-control.tsx`：顶部加：

```tsx
import { FileThumb } from '@/components/image-multi-pick'
import { comfyInputFileUrl, uploadFileUrl } from '@/lib/api'
```

（`api` 的既有 import 合并为 `import { api, comfyInputFileUrl, uploadFileUrl } from '@/lib/api'`。）

「服务端已上传」项改为：

```tsx
            {(uploads.data?.files ?? []).map((f) => (
              <DropdownMenuItem key={`up-${f}`} onSelect={() => onChange(f)}>
                <FileThumb src={uploadFileUrl(f)} />
                <span className="truncate">{f}</span>
              </DropdownMenuItem>
            ))}
```

「GPU 主机已有」项改为：

```tsx
                {(gpuFiles.data?.files ?? []).map((f) => (
                  <DropdownMenuItem key={`gpu-${f}`} onSelect={() => onChange(f)}>
                    <FileThumb src={comfyInputFileUrl(f)} />
                    <span className="truncate">{f}</span>
                  </DropdownMenuItem>
                ))}
```

- [ ] **Step 5: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（web 无渲染测试，主要防 import 残留/类型错）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/components/image-multi-pick.tsx apps/web/src/pages/batch-new.tsx apps/web/src/components/image-value-control.tsx
git commit -m "feat(web): 抽取 ImageMultiPick 共享组件,文件选择列表带缩略图

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 批量图片 tab 双来源 + 声明式派生 jobs

**Files:**
- Modify: `apps/web/src/pages/batch-new.tsx`（重写 ImagesEntry）
- Modify: `README.md`（特性清单补一句）

**Interfaces:**
- Consumes: Task 5 的 `ImageMultiPick`；既有 `parseCap` / `findDimPair` / `fitSource` / `computeLockedDim` / `SizeMode`
- Produces: ImagesEntry 行为——selected+shared+尺寸设置任一变化自动重算 jobs；探测中 jobs 为空

- [ ] **Step 1: 重写 ImagesEntry**

`apps/web/src/pages/batch-new.tsx`：

顶部 import 调整：react-query 行改为 `import { useMutation, useQueries, useQuery } from '@tanstack/react-query'`（Task 5 已删 `useQueryClient`）；react 行确保含 `useMemo`（既有）。

整个 `ImagesEntry` 函数替换为：

```tsx
function ImagesEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const imageParams = template.params.filter((p) => p.type === 'image')
  const otherParams = template.params.filter((p) => p.type !== 'image')
  const [imageKey, setImageKey] = useState(imageParams[0]?.key ?? '')
  const [shared, setShared] = useState<ParamValues>({})
  const [selected, setSelected] = useState<string[]>([])
  const [dimsWarning, setDimsWarning] = useState('')

  // findDimPair 每渲染返回新对象,memo 化避免派生 effect 每渲染重跑
  const dimPair = useMemo(() => findDimPair(template.params), [template.params])
  const [sizeMode, setSizeMode] = useState<SizeMode>('default')
  const [driver, setDriver] = useState<'width' | 'height'>('width')
  const [driverValue, setDriverValue] = useState('')
  const [capText, setCapText] = useState('')

  const n = Number(driverValue)
  const ratioInvalid = sizeMode === 'ratio' && (!driverValue || Number.isNaN(n) || n <= 0)
  const needDims = sizeMode !== 'default' && !!dimPair && !ratioInvalid

  const dimQueries = useQueries({
    queries: selected.map((name) => ({
      queryKey: ['image-dims', name],
      enabled: needDims,
      queryFn: () =>
        api<{ width: number; height: number }>(
          `/comfy/image-dims?name=${encodeURIComponent(name)}`,
        ),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })
  const settled = dimQueries.every((q) => q.isSuccess || q.isError)
  // useQueries 每渲染返回新数组,不能直接进 effect 依赖;结果压成字符串键,内容不变不重算
  const dimsKey = JSON.stringify(
    dimQueries.map((q) =>
      q.isSuccess ? [q.data.width, q.data.height] : q.isError ? 'err' : 'pending',
    ),
  )
  const probing = needDims && selected.length > 0 && !settled

  useEffect(() => {
    if (selected.length === 0 || !imageKey) {
      onChange([])
      return
    }
    if (sizeMode === 'default' || !dimPair) {
      setDimsWarning('')
      onChange(selected.map((s) => ({ ...shared, [imageKey]: s })))
      return
    }
    if (ratioInvalid || !settled) {
      onChange([])
      return
    }
    let failed = 0
    const jobs = selected.map((s, i) => {
      const q = dimQueries[i]!
      const base: ParamValues = { ...shared, [imageKey]: s }
      delete base[dimPair.width.key]
      delete base[dimPair.height.key]
      if (q.isSuccess) {
        const d =
          sizeMode === 'ratio'
            ? computeLockedDim(q.data, driver, n)
            : fitSource(q.data, parseCap(capText))
        return { ...base, [dimPair.width.key]: d.width, [dimPair.height.key]: d.height }
      }
      failed++
      return base // 宽高留空 → 提交时用模板默认值
    })
    setDimsWarning(failed > 0 ? `${failed} 张图未能获取尺寸，已用模板默认宽高` : '')
    onChange(jobs)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimQueries 的内容变化已由 dimsKey 表达
  }, [selected, shared, imageKey, sizeMode, driver, driverValue, capText, dimsKey, settled, ratioInvalid, dimPair, onChange])

  if (imageParams.length === 0) {
    return <p className="text-sm text-muted-foreground">该模板没有 image 类型参数</p>
  }

  return (
    <div className="space-y-4">
      {imageParams.length > 1 && (
        <div className="space-y-1">
          <Label>图片填充到哪个参数</Label>
          <Select value={imageKey} onValueChange={setImageKey}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {imageParams.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {dimPair && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Label>输出尺寸</Label>
            <Select value={sizeMode} onValueChange={(v) => setSizeMode(v as SizeMode)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">模板默认</SelectItem>
                <SelectItem value="ratio">锁定比例（填一边）</SelectItem>
                <SelectItem value="source">跟随源图</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {sizeMode === 'ratio' && (
            <div className="flex items-center gap-2">
              <Select value={driver} onValueChange={(v) => setDriver(v as 'width' | 'height')}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="width">按宽定高</SelectItem>
                  <SelectItem value="height">按高定宽</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="w-32"
                placeholder={String(
                  (driver === 'width' ? dimPair.width : dimPair.height).default ?? '',
                )}
                value={driverValue}
                onChange={(e) => setDriverValue(e.target.value)}
              />
              <Input className="w-40" disabled placeholder="另一维自动（按源图比例）" value="" readOnly />
            </div>
          )}
          {sizeMode === 'source' && (
            <div className="flex items-center gap-2">
              <Input
                className="w-56"
                type="number"
                min={8}
                placeholder="最长边上限（留空=与源图一致）"
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
              />
              <Input className="w-40" disabled placeholder="宽高自动（跟随源图）" value="" readOnly />
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        {otherParams
          .filter(
            (p) =>
              !(
                sizeMode !== 'default' &&
                dimPair &&
                (p.key === dimPair.width.key || p.key === dimPair.height.key)
              ),
          )
          .map((p) => (
            <div key={p.key} className="space-y-1">
              <Label>{p.key}（所有任务共享）</Label>
              {p.type === 'enum' ? (
                <EnumValueSelect
                  param={p}
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
            </div>
          ))}
      </div>
      <div className="space-y-1">
        <Label>图片（勾选已有或上传本机，选中即生成任务）</Label>
        <ImageMultiPick value={selected} onChange={setSelected} />
      </div>
      {ratioInvalid && (
        <p className="text-sm text-destructive">锁定比例后需先填写有效的宽或高数值</p>
      )}
      {probing && <p className="text-sm text-muted-foreground">探测尺寸中…</p>}
      {dimsWarning && <p className="text-sm text-muted-foreground">⚠ {dimsWarning}</p>}
    </div>
  )
}
```

（原 `uploading`/`error`/`onFiles` 与裸 `<Input type="file">` 整体移除——上传由 ImageMultiPick 内部处理。）

- [ ] **Step 2: README 特性清单补一句**

`README.md` 特性清单（现第 38 行附近，输出尺寸三模式那条之后）追加一条 bullet：

```markdown
- 批量图片可勾选服务端/GPU 主机已有文件（带缩略图预览），上传按内容去重（同图不重复存储/传输）
```

- [ ] **Step 3: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/batch-new.tsx README.md
git commit -m "feat(web): 批量图片 tab 双来源选择,jobs 声明式派生

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（PR 描述用）

1. 参数很多的模板在 Templates 列表不出现横向滚动，`+N` 悬停能看到全部参数
2. 批量图片 tab 能勾选「GPU 主机已有」文件生成任务（不经过上传）
3. 同一张图重复上传，返回同名且 uploads 目录不新增文件
4. 双来源列表和表格下拉里能看到缩略图；坏文件不破版式
5. 批量图片 tab：上传后修改共享参数，预览 jobs 跟着变；多次上传/勾选累积而非覆盖
6. 尺寸三态在批量图片 tab 仍按 PR #7 语义工作；探测中提交按钮隐藏、显示「探测尺寸中…」
