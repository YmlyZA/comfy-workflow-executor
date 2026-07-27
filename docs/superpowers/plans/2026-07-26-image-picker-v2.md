# 图片选择器 v2 实现计划（七期 ④）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端 sharp 缩略图端点 + 统一弹窗图片选择器（Tab 双来源/网格/过滤/客户端分页/点选+框选），多选与单选两入口共用。

**Architecture:** 新增 `GET /api/thumbs`（sharp 缩放 192px webp + 磁盘缓存）；前端 `FileThumb` 抽独立文件并加「缩略图→原图→隐藏」回退链；新组件 `ImagePickerDialog`（single/multi 两模式）替换 `ImageMultiPick` 的内嵌列表与 `ImageValueControl` 的下拉菜单。spec：`docs/superpowers/specs/2026-07-26-image-picker-v2-design.md`。

**Tech Stack:** Hono + sharp（服务端）；React 19 + shadcn Dialog/Tabs + Tailwind v4（前端）；vitest。

## Global Constraints

- 分支 `feat/image-picker-v2` 已建，直接在其上工作；**禁止 push / 建 PR**（控制器统一做）
- server/shared 的相对导入必须带 `.js` 后缀（ESM）
- **不改** `pnpm-workspace.yaml`（sharp ≥0.33 走预编译二进制，无 postinstall 构建脚本；若安装后 pnpm 提示 ignored build scripts 需上报而不是自行放行）
- web 包惯例：**不写渲染测试**，验证 = `pnpm typecheck` + 既有测试全绿
- 测试命令：`pnpm --filter @cwe/server test -- thumbs`（单文件）、`pnpm test`（根，全量，当前 182 通过）、`pnpm typecheck`
- 提交信息结尾加 trailer：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 现有端点 `/api/uploads/:name`、`/api/comfy/input-image` 保留不动（回退链用）

---

### Task 1: 服务端 thumbs 端点（sharp + 磁盘缓存 + 守卫）

**Files:**
- Modify: `apps/server/package.json`（加 sharp 依赖）
- Create: `apps/server/src/routes/thumbs.ts`
- Modify: `apps/server/src/app.ts`（挂载路由）
- Test: `apps/server/test/thumbs.test.ts`

**Interfaces:**
- Consumes: `AppDeps`（`../app.js`）、`deps.comfy.getInputImage(name: string): Promise<ArrayBuffer | null>`（已存在）、`deps.config.dataDir`
- Produces: `GET /api/thumbs?source=uploads|comfy&name=<文件名>` → 200 `image/webp`（192px 最长边、不放大）；400 source/name 非法；404 源不存在；415 非图片；503 GPU 离线。缓存写 `dataDir/thumbs/<source>/<encodeURIComponent(name)>.webp`

- [ ] **Step 1: 安装 sharp**

```bash
pnpm --filter @cwe/server add sharp
```

预期：安装成功、无 "ignored build scripts" 警告（sharp 走 `@img/sharp-*` 预编译 optional deps）。如出现该警告，停下上报。

- [ ] **Step 2: 写失败测试**

创建 `apps/server/test/thumbs.test.ts`：

```ts
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
let dataDir: string
let fake: FakeComfy
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret' }

async function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer()
}

async function meta(res: Response) {
  return sharp(Buffer.from(await res.arrayBuffer())).metadata()
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-thumbs-'))
  mkdirSync(join(dataDir, 'uploads'), { recursive: true })
  db = createDb(':memory:')
  fake = new FakeComfy()
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db,
    comfy: fake,
    events: new EventEmitter(),
  })
})

describe('GET /api/thumbs (uploads 源)', () => {
  it('缩放到 192 最长边并输出 webp,带 Cache-Control', async () => {
    writeFileSync(join(dataDir, 'uploads', 'big.png'), await pngBuffer(400, 200))
    const res = await app.request('/api/thumbs?source=uploads&name=big.png', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('max-age=86400')
    const m = await meta(res)
    expect(m.format).toBe('webp')
    expect(m.width).toBe(192)
    expect(m.height).toBe(96)
  })

  it('小图不放大', async () => {
    writeFileSync(join(dataDir, 'uploads', 'small.png'), await pngBuffer(64, 48))
    const res = await app.request('/api/thumbs?source=uploads&name=small.png', { headers: H })
    expect(res.status).toBe(200)
    const m = await meta(res)
    expect(m.width).toBe(64)
    expect(m.height).toBe(48)
  })

  it('磁盘缓存命中:删掉源文件后仍能返回缩略图', async () => {
    writeFileSync(join(dataDir, 'uploads', 'cached.png'), await pngBuffer(100, 100))
    const first = await app.request('/api/thumbs?source=uploads&name=cached.png', { headers: H })
    expect(first.status).toBe(200)
    rmSync(join(dataDir, 'uploads', 'cached.png'))
    const second = await app.request('/api/thumbs?source=uploads&name=cached.png', { headers: H })
    expect(second.status).toBe(200)
    expect(second.headers.get('content-type')).toBe('image/webp')
  })

  it('不存在返回 404', async () => {
    const res = await app.request('/api/thumbs?source=uploads&name=nope.png', { headers: H })
    expect(res.status).toBe(404)
  })

  it('非图片文件返回 415', async () => {
    writeFileSync(join(dataDir, 'uploads', 'text.png'), 'not-an-image')
    const res = await app.request('/api/thumbs?source=uploads&name=text.png', { headers: H })
    expect(res.status).toBe(415)
  })

  it('uploads 不接受带路径分隔符的名字', async () => {
    const res = await app.request(
      `/api/thumbs?source=uploads&name=${encodeURIComponent('a/b.png')}`,
      { headers: H },
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /api/thumbs (comfy 源)', () => {
  it('经 comfy client 拉取并缩放,允许子目录相对名', async () => {
    fake.inputImages['sub/pic.png'] = await pngBuffer(300, 300)
    const res = await app.request(
      `/api/thumbs?source=comfy&name=${encodeURIComponent('sub/pic.png')}`,
      { headers: H },
    )
    expect(res.status).toBe(200)
    const m = await meta(res)
    expect(m.width).toBe(192)
    expect(m.height).toBe(192)
  })

  it('磁盘缓存命中:GPU 侧文件消失后仍能返回', async () => {
    fake.inputImages['gone.png'] = await pngBuffer(50, 50)
    const first = await app.request('/api/thumbs?source=comfy&name=gone.png', { headers: H })
    expect(first.status).toBe(200)
    delete fake.inputImages['gone.png']
    const second = await app.request('/api/thumbs?source=comfy&name=gone.png', { headers: H })
    expect(second.status).toBe(200)
  })

  it('GPU 侧不存在返回 404', async () => {
    const res = await app.request('/api/thumbs?source=comfy&name=nope.png', { headers: H })
    expect(res.status).toBe(404)
  })

  it('comfy 为 null 时返回 503', async () => {
    const offline = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db,
      comfy: null,
      events: new EventEmitter(),
    })
    const res = await offline.request('/api/thumbs?source=comfy&name=x.png', { headers: H })
    expect(res.status).toBe(503)
  })
})

describe('GET /api/thumbs (参数校验)', () => {
  it('source 非法返回 400', async () => {
    const res = await app.request('/api/thumbs?source=outputs&name=x.png', { headers: H })
    expect(res.status).toBe(400)
  })

  it('缺少 name 返回 400', async () => {
    const res = await app.request('/api/thumbs?source=uploads', { headers: H })
    expect(res.status).toBe(400)
  })

  it('.. 穿越返回 400(两种 source)', async () => {
    for (const source of ['uploads', 'comfy']) {
      const res = await app.request(
        `/api/thumbs?source=${source}&name=${encodeURIComponent('../secret.png')}`,
        { headers: H },
      )
      expect(res.status).toBe(400)
    }
  })

  it('comfy 绝对路径返回 400', async () => {
    const res = await app.request(
      `/api/thumbs?source=comfy&name=${encodeURIComponent('/etc/passwd')}`,
      { headers: H },
    )
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- thumbs`
Expected: 绝大多数 FAIL（路由不存在时命中 `app.all('/api/*')` 兜底 404，状态码与期望不符；两个期望 404 的用例会碰巧通过，属正常）

- [ ] **Step 4: 实现路由**

创建 `apps/server/src/routes/thumbs.ts`：

```ts
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import type { AppDeps } from '../app.js'

/** 缩略图最长边(px):网格 96px 格子 ×2 DPR */
const THUMB_SIZE = 192

export function thumbRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', async (c) => {
    const source = c.req.query('source') ?? ''
    const name = c.req.query('name') ?? ''
    if (source !== 'uploads' && source !== 'comfy') return c.json({ error: 'source 非法' }, 400)
    if (!name) return c.json({ error: '缺少 name 参数' }, 400)
    // uploads 仅裸文件名;comfy 允许子目录相对名(LoadImage COMBO 会列 subdir/file.png)
    if (name.includes('..') || isAbsolute(name)) return c.json({ error: 'name 非法' }, 400)
    if (source === 'uploads' && basename(name) !== name) return c.json({ error: 'name 非法' }, 400)

    const cacheDir = resolve(deps.config.dataDir, 'thumbs', source)
    // encodeURIComponent 后不含路径分隔符,天然单段;前缀守卫双保险
    const cachePath = resolve(cacheDir, `${encodeURIComponent(name)}.webp`)
    if (!cachePath.startsWith(cacheDir + '/')) return c.json({ error: 'name 非法' }, 400)

    if (existsSync(cachePath)) {
      c.header('Content-Type', 'image/webp')
      c.header('Cache-Control', 'max-age=86400')
      return c.body(await readFile(cachePath))
    }

    let src: Buffer
    if (source === 'uploads') {
      try {
        src = await readFile(join(deps.config.dataDir, 'uploads', name))
      } catch {
        return c.json({ error: '图片不存在' }, 404)
      }
    } else {
      if (!deps.comfy) return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      let buf: ArrayBuffer | null
      try {
        buf = await deps.comfy.getInputImage(name)
      } catch {
        return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      }
      if (!buf) return c.json({ error: '图片不存在' }, 404)
      src = Buffer.from(buf)
    }

    let out: Buffer
    try {
      out = await sharp(src)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer()
    } catch {
      return c.json({ error: '无法解码为图片' }, 415)
    }
    mkdirSync(cacheDir, { recursive: true })
    await writeFile(cachePath, out)
    c.header('Content-Type', 'image/webp')
    c.header('Cache-Control', 'max-age=86400')
    return c.body(out)
  })

  return app
}
```

修改 `apps/server/src/app.ts`：import 区加

```ts
import { thumbRoutes } from './routes/thumbs.js'
```

并在 `app.route('/api/uploads', uploadRoutes(deps))` 之后加一行：

```ts
app.route('/api/thumbs', thumbRoutes(deps))
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- thumbs`
Expected: 14 个测试全 PASS

- [ ] **Step 6: 全量验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净；全量 196 通过（182 + 新增 14）

- [ ] **Step 7: 提交**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/routes/thumbs.ts apps/server/src/app.ts apps/server/test/thumbs.test.ts
git commit -m "feat(server): GET /api/thumbs 缩略图端点(sharp 192px webp+磁盘缓存)"
```

---

### Task 2: FileThumb 抽独立文件 + 回退链 + 现有两处接入缩略图端点

**Files:**
- Create: `apps/web/src/components/file-thumb.tsx`
- Modify: `apps/web/src/lib/api.ts`（加 `thumbUrl`）
- Modify: `apps/web/src/components/image-multi-pick.tsx`（删本地 FileThumb，改用新文件与 thumbUrl）
- Modify: `apps/web/src/components/image-value-control.tsx`（改 import 与 thumbUrl）

**Interfaces:**
- Consumes: `getToken()`（`@/lib/api` 内部）、Task 1 的 `GET /api/thumbs`
- Produces:
  - `thumbUrl(source: 'uploads' | 'comfy', name: string): string`（`@/lib/api`）
  - `FileThumb({ src, fallback, className }: { src: string; fallback?: string; className?: string })`（`@/components/file-thumb`）——默认尺寸 size-8，className 可覆盖尺寸

- [ ] **Step 1: api.ts 加 thumbUrl**

在 `apps/web/src/lib/api.ts` 末尾（`comfyInputFileUrl` 之后）追加：

```ts
export function thumbUrl(source: 'uploads' | 'comfy', name: string): string {
  return `/api/thumbs?source=${source}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken())}`
}
```

- [ ] **Step 2: 创建 file-thumb.tsx**

创建 `apps/web/src/components/file-thumb.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** 缩略图:优先 src(缩略图端点),失败回退 fallback(原图)一次,再失败隐藏但保位,不破版式 */
export function FileThumb({
  src,
  fallback,
  className,
}: {
  src: string
  fallback?: string
  className?: string
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0)
  useEffect(() => setStage(0), [src])
  const cur = stage === 0 ? src : stage === 1 && fallback ? fallback : null
  return (
    <span className={cn('size-8 shrink-0 overflow-hidden rounded', className)}>
      {cur && (
        <img
          src={cur}
          loading="lazy"
          alt=""
          className="size-full object-cover"
          onError={() => setStage((s) => (s === 0 && fallback ? 1 : 2))}
        />
      )}
    </span>
  )
}
```

- [ ] **Step 3: 迁移两处调用**

`apps/web/src/components/image-multi-pick.tsx`：

- 删除文件内的 `FileThumb` 定义（及其 export）与不再用的 `useState` 中仅供它使用的部分（`hidden` 状态在删除的组件里，无需其他改动）
- 顶部加 `import { FileThumb } from '@/components/file-thumb'`，`import` 里从 `@/lib/api` 追加 `thumbUrl`
- `groups` 数组改为携带 source，缩略图传回退链。将

```ts
  const groups: Array<[string, string[], (f: string) => string]> = [
    ['服务端已上传', uploads.data?.files ?? [], uploadFileUrl],
  ]
  if (!gpuFiles.isError && !gpuFiles.isLoading) {
    groups.push(['GPU 主机已有', gpuFiles.data?.files ?? [], comfyInputFileUrl])
  }
```

改为

```ts
  const groups: Array<['uploads' | 'comfy', string, string[], (f: string) => string]> = [
    ['uploads', '服务端已上传', uploads.data?.files ?? [], uploadFileUrl],
  ]
  if (!gpuFiles.isError && !gpuFiles.isLoading) {
    groups.push(['comfy', 'GPU 主机已有', gpuFiles.data?.files ?? [], comfyInputFileUrl])
  }
  const listed = new Set(groups.flatMap(([, , files]) => files))
```

（原 `const listed = new Set(groups.flatMap(([, files]) => files))` 行删除，解构位置随元组变化调整；`groups.map(([label, files, urlOf]) => …)` 改为 `groups.map(([source, label, files, urlOf]) => …)`，`key={label}` 不变。）

- 组内缩略图 `<FileThumb src={urlOf(f)} />` 改为 `<FileThumb src={thumbUrl(source, f)} fallback={urlOf(f)} />`
- 孤儿组 `<FileThumb src={uploadFileUrl(f)} />` 改为 `<FileThumb src={thumbUrl('uploads', f)} fallback={uploadFileUrl(f)} />`

`apps/web/src/components/image-value-control.tsx`：

- `import { FileThumb } from '@/components/image-multi-pick'` 改为 `import { FileThumb } from '@/components/file-thumb'`；从 `@/lib/api` 追加 `thumbUrl`
- 服务端组 `<FileThumb src={uploadFileUrl(f)} />` 改为 `<FileThumb src={thumbUrl('uploads', f)} fallback={uploadFileUrl(f)} />`
- GPU 组 `<FileThumb src={comfyInputFileUrl(f)} />` 改为 `<FileThumb src={thumbUrl('comfy', f)} fallback={comfyInputFileUrl(f)} />`

- [ ] **Step 4: 验证**

Run: `grep -rn "from '@/components/image-multi-pick'" apps/web/src` —— 确认无人再从 image-multi-pick import `FileThumb`
Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净、196 通过

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/file-thumb.tsx apps/web/src/lib/api.ts apps/web/src/components/image-multi-pick.tsx apps/web/src/components/image-value-control.tsx
git commit -m "feat(web): FileThumb 独立组件+缩略图端点接入(原图回退链)"
```

---

### Task 3: ImagePickerDialog 基础（Tab/网格/过滤/分页/点选/上传/孤儿/footer）

**Files:**
- Create: `apps/web/src/components/image-picker-dialog.tsx`

**Interfaces:**
- Consumes: Task 2 的 `FileThumb`、`thumbUrl`；已有 `useUploadFiles`、`useComfyInputFiles`、`api`、`uploadFileUrl`、`comfyInputFileUrl`；shadcn `Dialog/DialogContent/DialogHeader/DialogTitle/DialogFooter`、`Tabs/TabsList/TabsTrigger`、`Button`、`Input`
- Produces:

```ts
export type PickSource = 'uploads' | 'comfy'
export function ImagePickerDialog(props: {
  mode: 'single' | 'multi'
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string[]          // multi=已选列表;single=[当前值] 或 []
  onConfirm: (next: string[]) => void
}): JSX.Element
```

multi：弹窗内维护草稿，「确定」才调 `onConfirm(draft)` 并关闭；「取消」/关闭丢弃改动。single：点击卡片即 `onConfirm([name])` 并关闭。

- [ ] **Step 1: 实现组件**

创建 `apps/web/src/components/image-picker-dialog.tsx`（完整文件）：

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileThumb } from '@/components/file-thumb'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { useUploadFiles } from '@/hooks/use-upload-files'
import { api, comfyInputFileUrl, thumbUrl, uploadFileUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 60

export type PickSource = 'uploads' | 'comfy'

/** 统一图片选择弹窗:Tab 双来源+网格+过滤+客户端分页;multi 确定才提交,single 点击即提交 */
export function ImagePickerDialog({
  mode,
  open,
  onOpenChange,
  value,
  onConfirm,
}: {
  mode: 'single' | 'multi'
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string[]
  onConfirm: (next: string[]) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'multi' ? '选择图片(可多选)' : '选择图片'}</DialogTitle>
        </DialogHeader>
        {/* open 时才挂载,状态随每次打开重置 */}
        {open && (
          <PickerBody mode={mode} value={value} onConfirm={onConfirm} close={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PickerBody({
  mode,
  value,
  onConfirm,
  close,
}: {
  mode: 'single' | 'multi'
  value: string[]
  onConfirm: (next: string[]) => void
  close: () => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string[]>(value)
  const [tab, setTab] = useState<PickSource>('uploads')
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()

  const uploadList = uploads.data?.files ?? []
  const gpuList = gpuFiles.data?.files ?? []
  const files = tab === 'uploads' ? uploadList : gpuList
  const filtered = useMemo(() => files.filter((f) => f.includes(filter)), [files, filter])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const cur = Math.min(page, pageCount - 1)
  const shown = filtered.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE)
  const chosen = new Set(draft)
  const listed = new Set([...uploadList, ...gpuList])
  const orphans = draft.filter((f) => !listed.has(f))

  function pick(name: string) {
    if (mode === 'single') {
      onConfirm([name])
      close()
      return
    }
    setDraft((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]))
  }

  async function onFiles(list: FileList) {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      for (const f of list) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
      const names = [...new Set(stored.map((s) => s.stored))]
      if (mode === 'single') {
        if (names[0]) {
          onConfirm([names[0]])
          close()
        }
        return
      }
      setDraft((prev) => [...prev, ...names.filter((n) => !prev.includes(n))])
      setTab('uploads')
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as PickSource)
            setPage(0)
          }}
        >
          <TabsList>
            <TabsTrigger value="uploads">服务端已上传</TabsTrigger>
            <TabsTrigger
              value="comfy"
              disabled={gpuFiles.isError}
              title={gpuFiles.isError ? 'ComfyUI 离线,GPU 文件列表不可用' : undefined}
            >
              GPU 主机已有
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          className="h-8 w-40"
          placeholder="过滤文件名…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setPage(0)
          }}
        />
        <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
          上传本机图片
        </Button>
        {uploading && <span className="text-xs text-muted-foreground">上传中…</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      <div className="relative flex max-h-80 min-h-40 select-none flex-wrap content-start gap-2 overflow-y-auto rounded-md border p-2">
        {shown.map((f) => (
          <GridCard key={f} name={f} source={tab} selected={chosen.has(f)} onPick={() => pick(f)} />
        ))}
        {shown.length === 0 && <p className="text-xs text-muted-foreground">（无匹配文件）</p>}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={cur === 0} onClick={() => setPage(cur - 1)}>
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {cur + 1} / {pageCount}
          </span>
          <Button size="sm" variant="outline" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>
            下一页
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">共 {filtered.length} 个文件</span>
      </div>
      {mode === 'multi' && (
        <>
          {orphans.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">其他已选：</span>
              {orphans.map((f) => (
                <span key={f} className="flex items-center gap-1 rounded-md border px-1 py-0.5 text-xs">
                  <span className="max-w-32 truncate" title={f}>
                    {f}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted"
                    onClick={() => setDraft((prev) => prev.filter((v) => v !== f))}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-sm text-muted-foreground">已选 {draft.length} 张</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraft([])}>
                清空
              </Button>
              <Button variant="outline" size="sm" onClick={close}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onConfirm(draft)
                  close()
                }}
              >
                确定
              </Button>
            </div>
          </DialogFooter>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple={mode === 'multi'}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** 网格卡片;data-name 供框选命中检测(Task 4)使用 */
function GridCard({
  name,
  source,
  selected,
  onPick,
}: {
  name: string
  source: PickSource
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      data-name={name}
      onClick={onPick}
      className={cn(
        'relative flex w-24 flex-col items-center gap-1 rounded-md border p-1',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      {selected && (
        <CheckIcon className="absolute top-1 right-1 z-10 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />
      )}
      <FileThumb
        className="size-20"
        src={thumbUrl(source, name)}
        fallback={source === 'uploads' ? uploadFileUrl(name) : comfyInputFileUrl(name)}
      />
      <span className="w-full truncate text-center text-xs" title={name}>
        {name}
      </span>
    </button>
  )
}
```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净、196 通过（新组件暂无调用方，webpack/vite tree 中存在即可编译）

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/image-picker-dialog.tsx
git commit -m "feat(web): ImagePickerDialog 统一图片选择弹窗(Tab/网格/过滤/分页/点选/上传)"
```

---

### Task 4: 拖拽框选（marquee 加选）

**Files:**
- Modify: `apps/web/src/components/image-picker-dialog.tsx`

**Interfaces:**
- Consumes: Task 3 的 `PickerBody`（网格容器、`GridCard` 的 `data-name` 属性、`setDraft`）
- Produces: multi 模式下,在网格空白处按下左键拖出矩形,pointerup 时与矩形相交的卡片**批量加选**（不取消已选）；拖动小于 4px 视为点击不触发框选。overlay 用直接 DOM 样式更新,拖动过程零 setState。

- [ ] **Step 1: 实现框选**

修改 `apps/web/src/components/image-picker-dialog.tsx` 的 `PickerBody`：

在 `const fileRef = useRef<HTMLInputElement>(null)` 之后加：

```tsx
  const gridRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
```

在 `onFiles` 函数之后加三个 handler：

```tsx
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (mode !== 'multi' || e.button !== 0) return
    // 落在卡片上是点选,不启动框选
    if ((e.target as HTMLElement).closest('[data-name]')) return
    dragStart.current = { x: e.clientX, y: e.clientY }
    gridRef.current?.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current || !overlayRef.current || !gridRef.current) return
    const host = gridRef.current.getBoundingClientRect()
    // 拖动过程只改 overlay 样式,不 setState
    Object.assign(overlayRef.current.style, {
      display: 'block',
      left: `${Math.min(dragStart.current.x, e.clientX) - host.left}px`,
      top: `${Math.min(dragStart.current.y, e.clientY) - host.top + gridRef.current.scrollTop}px`,
      width: `${Math.abs(e.clientX - dragStart.current.x)}px`,
      height: `${Math.abs(e.clientY - dragStart.current.y)}px`,
    })
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current
    dragStart.current = null
    if (overlayRef.current) overlayRef.current.style.display = 'none'
    if (!start || !gridRef.current) return
    const x1 = Math.min(start.x, e.clientX)
    const x2 = Math.max(start.x, e.clientX)
    const y1 = Math.min(start.y, e.clientY)
    const y2 = Math.max(start.y, e.clientY)
    if (x2 - x1 < 4 && y2 - y1 < 4) return // 视为点击
    const hit: string[] = []
    for (const el of gridRef.current.querySelectorAll<HTMLElement>('[data-name]')) {
      const r = el.getBoundingClientRect()
      if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1 && el.dataset.name) {
        hit.push(el.dataset.name)
      }
    }
    if (hit.length) setDraft((prev) => [...prev, ...hit.filter((n) => !prev.includes(n))])
  }
```

网格容器 div 加上 ref 与事件（原 `<div className="relative flex max-h-80 …">` 改为）：

```tsx
      <div
        ref={gridRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="relative flex max-h-80 min-h-40 select-none flex-wrap content-start gap-2 overflow-y-auto rounded-md border p-2"
      >
        <div
          ref={overlayRef}
          className="pointer-events-none absolute z-10 hidden border border-primary bg-primary/10"
        />
```

（其余子元素不变。overlay 的 top 计入 `scrollTop`,使矩形随内容滚动定位正确;拖动中途滚动的边缘情况接受偏差。）

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净、196 通过

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/image-picker-dialog.tsx
git commit -m "feat(web): ImagePickerDialog 拖拽框选批量加选"
```

---

### Task 5: 两入口改造（ImageMultiPick 瘦身 + ImageValueControl 换弹窗）

**Files:**
- Modify: `apps/web/src/components/image-multi-pick.tsx`（整文件重写）
- Modify: `apps/web/src/components/image-value-control.tsx`（整文件重写）

**Interfaces:**
- Consumes: Task 3/4 的 `ImagePickerDialog`、Task 2 的 `FileThumb`/`thumbUrl`
- Produces: 两组件对外 props **不变**——`ImageMultiPick({ value: string[], onChange })`、`ImageValueControl({ value: string, onChange, placeholder? })`。调用方（`matrix-entry.tsx`、`batch-new.tsx`、表格 tab）零改动。

- [ ] **Step 1: 重写 image-multi-pick.tsx**

整文件替换为：

```tsx
import { XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileThumb } from '@/components/file-thumb'
import { ImagePickerDialog } from '@/components/image-picker-dialog'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { comfyInputFileUrl, thumbUrl, uploadFileUrl } from '@/lib/api'

/** image 多选:已选缩略图 chip 行 + 弹窗选择;value 顺序即选中顺序 */
export function ImageMultiPick({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const gpuFiles = useComfyInputFiles()
  const gpuSet = new Set(gpuFiles.data?.files ?? [])
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((f) => {
            const source = gpuSet.has(f) ? 'comfy' : 'uploads'
            return (
              <span key={f} className="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1 text-xs">
                <FileThumb
                  className="size-6"
                  src={thumbUrl(source, f)}
                  fallback={source === 'uploads' ? uploadFileUrl(f) : comfyInputFileUrl(f)}
                />
                <span className="max-w-32 truncate" title={f}>
                  {f}
                </span>
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={() => onChange(value.filter((v) => v !== f))}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        选择图片…
      </Button>
      <ImagePickerDialog mode="multi" open={open} onOpenChange={setOpen} value={value} onConfirm={onChange} />
    </div>
  )
}
```

（旧的内嵌 checkbox 列表、内联上传、孤儿组逻辑全部删除——上传与孤儿显示已由弹窗承担。）

- [ ] **Step 2: 重写 image-value-control.tsx**

整文件替换为：

```tsx
import { ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ImagePickerDialog } from '@/components/image-picker-dialog'
import { Input } from '@/components/ui/input'

/** image 参数单值控件:手填 + 弹窗选择(弹窗内含上传) */
export function ImageValueControl({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        title="选择图片"
        onClick={() => setOpen(true)}
      >
        <ImageIcon className="size-4" />
      </Button>
      <ImagePickerDialog
        mode="single"
        open={open}
        onOpenChange={setOpen}
        value={value ? [value] : []}
        onConfirm={(next) => onChange(next[0] ?? '')}
      />
    </div>
  )
}
```

- [ ] **Step 3: 清理检查**

Run: `grep -rn "DropdownMenu" apps/web/src/components/image-value-control.tsx; grep -rn "useUploadFiles\|type=\"checkbox\"" apps/web/src/components/image-multi-pick.tsx`
Expected: 均无输出（旧依赖清干净）

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 干净、196 通过

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/image-multi-pick.tsx apps/web/src/components/image-value-control.tsx
git commit -m "feat(web): 两处 image 入口接入统一弹窗选择器"
```

---

## 手动验收清单（放 PR 描述,用户执行）

1. 双 tab 切换正常；GPU 离线（断隧道）时「GPU 主机已有」tab 禁用并有提示
2. 文件名过滤实时生效；>60 张时分页、翻页正常
3. multi：点选切换、空白处拖拽框选批量加选（不取消已选）、清空/取消/确定语义正确
4. single（表格行内）：点击卡片即选中并关闭；手填 Input 不受影响
5. 弹窗内上传：multi 自动追加选中并切到服务端 tab；single 直接选中关闭
6. 孤儿 chip：GPU 断开后,已选 GPU 文件在弹窗底部「其他已选」可见、可移除
7. 缩略图走 /api/thumbs webp（网络面板确认）,明显变快；非图片文件缩略图回退→隐藏不破版式
