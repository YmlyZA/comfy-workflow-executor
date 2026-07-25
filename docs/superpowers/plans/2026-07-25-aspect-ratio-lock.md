# 锁定源图长宽比 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建批次时可锁定输入图片的长宽比——表格模式行内填一维自动算另一维；批量图片 tab 每张图按各自比例计算。

**Architecture:** shared 新增 `computeLockedDim` 纯函数（比例计算+8 倍数取整）；服务端 `ComfyClient.getInputImage`（代理 ComfyUI /view）+ `GET /api/comfy/image-dims`（uploads 本地读取→GPU 侧拉取的存在性回退，image-size 解析）；前端 `useImageDims` hook + TableEntry 表级锁定开关/行级 DimCell 自动填 + ImagesEntry 锁定块（按宽定高/按高定宽）逐图计算。

**Tech Stack:** 现有栈 + 新依赖 `image-size`（server，纯 JS）。

**Spec:** `docs/superpowers/specs/2026-07-25-aspect-ratio-lock-design.md`

## Global Constraints

- ESM + TS strict；测试 vitest 离线；pnpm 11（不改 pnpm-workspace.yaml，不设 minimum-release-age）
- 取整规则（已裁决）：计算维 `round8(n)=max(8, round(n/8)*8)`；驱动侧用户输入原样保留
- image-dims 判定顺序与执行器一致：`..`/绝对路径跳过本地 → uploads 存在读本地 → comfy 配置了走 getInputImage（fetch 抛错→503，返回 null→404）→ comfy 未配置→503
- 维度参数识别：`type==='number'` 且 `inputName==='width'/'height'` 的第一对，凑不齐不渲染锁定控件
- 中文 UI 文案；commit message 英文，trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 每任务完成后对应包测试 + `tsc --noEmit` 全绿才 commit
- 实现细节澄清（对 spec 的一处收敛）：spec 提到表格模式"防抖 500ms"，实现用 react-query 按文件名缓存（`['image-dims', name]`）替代——每个图片名最多请求一次，键入时用缓存同步计算，无需防抖。效果等同且更简单。

---

### Task 1: shared — computeLockedDim 纯函数

**Files:**
- Create: `packages/shared/src/dims.ts`
- Modify: `packages/shared/src/index.ts`（加一行 export）
- Test: `packages/shared/test/dims.test.ts`

**Interfaces:**
- Produces: `ImageDims = { width: number; height: number }`；`round8(n: number): number`；`computeLockedDim(source: ImageDims, driver: 'width' | 'height', value: number): ImageDims`——Task 3/4 从 `@cwe/shared` import

- [ ] **Step 1: 写失败测试**

`packages/shared/test/dims.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { computeLockedDim, round8 } from '../src/dims.js'

describe('round8', () => {
  it('就近取整到 8 的倍数', () => {
    expect(round8(680)).toBe(680)
    expect(round8(682.5)).toBe(680)
    expect(round8(684)).toBe(688)
  })
  it('下限 8', () => {
    expect(round8(1)).toBe(8)
    expect(round8(0)).toBe(8)
  })
})

describe('computeLockedDim', () => {
  it('按宽定高:横图', () => {
    expect(computeLockedDim({ width: 2048, height: 1365 }, 'width', 1024)).toEqual({
      width: 1024,
      height: 680,
    })
  })
  it('按高定宽:竖图', () => {
    expect(computeLockedDim({ width: 768, height: 1024 }, 'height', 512)).toEqual({
      width: 384,
      height: 512,
    })
  })
  it('方图两个方向一致', () => {
    expect(computeLockedDim({ width: 512, height: 512 }, 'width', 1024)).toEqual({
      width: 1024,
      height: 1024,
    })
  })
  it('驱动侧不取整,计算维取整', () => {
    const r = computeLockedDim({ width: 1000, height: 500 }, 'width', 1001)
    expect(r.width).toBe(1001)
    expect(r.height).toBe(round8(500.5))
  })
  it('极端比例计算维不低于 8', () => {
    expect(computeLockedDim({ width: 4096, height: 64 }, 'width', 64).height).toBe(8)
  })
  it('源图尺寸非正数抛错', () => {
    expect(() => computeLockedDim({ width: 0, height: 100 }, 'width', 512)).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/shared exec vitest run test/dims.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 dims.ts + 导出**

`packages/shared/src/dims.ts`：

```ts
export interface ImageDims {
  width: number
  height: number
}

/** 就近取整到 8 的倍数,下限 8(SD 系 latent 约束) */
export function round8(n: number): number {
  return Math.max(8, Math.round(n / 8) * 8)
}

/** 按源图比例由一维算另一维;驱动侧原样保留,计算维取整到 8 */
export function computeLockedDim(
  source: ImageDims,
  driver: 'width' | 'height',
  value: number,
): ImageDims {
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('source dims must be positive')
  }
  if (driver === 'width') {
    return { width: value, height: round8((value * source.height) / source.width) }
  }
  return { width: round8((value * source.width) / source.height), height: value }
}
```

`packages/shared/src/index.ts` 追加：

```ts
export * from './dims.js'
```

- [ ] **Step 4: 全绿验证**

Run: `pnpm --filter @cwe/shared test && pnpm --filter @cwe/shared exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): computeLockedDim aspect-ratio helper with 8px rounding"
```

---

### Task 2: server — getInputImage + GET /api/comfy/image-dims

**Files:**
- Modify: `apps/server/src/comfy/client.ts`（接口 + 实现加 getInputImage）
- Modify: `apps/server/test/fake-comfy.ts`（inputImages 成员 + getInputImage）
- Modify: `apps/server/src/routes/comfy.ts`（GET /image-dims）
- Modify: `apps/server/package.json`（image-size 依赖）
- Test: `apps/server/test/comfy-routes.test.ts`

**Interfaces:**
- Consumes: `deps.config.dataDir`、现有 comfy 路由结构
- Produces: `ComfyClient.getInputImage(name: string): Promise<ArrayBuffer | null>`；`FakeComfy.inputImages: Record<string, Buffer>`；`GET /api/comfy/image-dims?name=` → 200 `{width,height}` / 400 缺参 / 404 不存在或解析失败 / 503 离线——Task 3/4 前端消费

- [ ] **Step 1: 安装依赖**

```bash
pnpm --filter @cwe/server add image-size
```

- [ ] **Step 2: 写失败测试**

`apps/server/test/comfy-routes.test.ts` 追加（导入区并入 `mkdirSync, mkdtempSync, writeFileSync` from 'node:fs'、`tmpdir` from 'node:os'、`join` from 'node:path'、`createDb` from '../src/db/index.js'——已有的不重复）：

```ts
/** 1×1 透明 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('GET /api/comfy/image-dims', () => {
  it('缺 name 返回 400', async () => {
    expect((await app.request('/api/comfy/image-dims', { headers: H })).status).toBe(400)
  })

  it('本地 uploads 文件解析尺寸', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-dims-'))
    mkdirSync(join(dataDir, 'uploads'), { recursive: true })
    writeFileSync(join(dataDir, 'uploads', 'pic.png'), PNG_1X1)
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: createDb(':memory:'), comfy, events: new EventEmitter(),
    })
    const res = await localApp.request('/api/comfy/image-dims?name=pic.png', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ width: 1, height: 1 })
  })

  it('本地没有时走 GPU 侧文件', async () => {
    comfy.inputImages['gpu.png'] = PNG_1X1
    const res = await app.request('/api/comfy/image-dims?name=gpu.png', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ width: 1, height: 1 })
  })

  it('两边都没有返回 404', async () => {
    expect((await app.request('/api/comfy/image-dims?name=nope.png', { headers: H })).status).toBe(404)
  })

  it('解析失败返回 404', async () => {
    comfy.inputImages['bad.png'] = Buffer.from('not an image')
    expect((await app.request('/api/comfy/image-dims?name=bad.png', { headers: H })).status).toBe(404)
  })

  it('本地没有且 comfy 未配置返回 503', async () => {
    const res = await makeApp(false).request('/api/comfy/image-dims?name=x.png', { headers: H })
    expect(res.status).toBe(503)
  })

  it('getInputImage 抛错(离线)返回 503', async () => {
    comfy.getInputImage = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect((await app.request('/api/comfy/image-dims?name=x.png', { headers: H })).status).toBe(503)
  })
})
```

说明：`app`（beforeEach 用默认 DATA_DIR './data' 构建）下 uploads 目录通常不存在，GPU 路径用例天然走 getInputImage；若本机恰好存在 `./data/uploads` 也不影响（测试用的文件名不存在其中）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/comfy-routes.test.ts`
Expected: 新增用例 FAIL（404 路由不存在 / FakeComfy 无 inputImages 编译错）

- [ ] **Step 4: 实现**

`apps/server/src/comfy/client.ts` — 接口加（getObjectInfo 声明之后）：

```ts
  /** 拉取 ComfyUI input 目录图片字节;404 返回 null。name 支持 sub/name.png 子目录写法 */
  getInputImage(name: string): Promise<ArrayBuffer | null>
```

实现对象加（getObjectInfo 实现之后）：

```ts
    async getInputImage(name) {
      const idx = name.lastIndexOf('/')
      const qs = new URLSearchParams({
        filename: idx >= 0 ? name.slice(idx + 1) : name,
        subfolder: idx >= 0 ? name.slice(0, idx) : '',
        type: 'input',
      })
      const res = await fetch(`${http}/view?${qs}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`view failed: ${res.status}`)
      return res.arrayBuffer()
    },
```

`apps/server/test/fake-comfy.ts` — `objectInfo` 成员附近加：

```ts
  inputImages: Record<string, Buffer> = {}
```

方法区加（getObjectInfo 之后）：

```ts
  async getInputImage(name: string): Promise<ArrayBuffer | null> {
    const buf = this.inputImages[name]
    return buf ? (Uint8Array.from(buf).buffer as ArrayBuffer) : null
  }
```

`apps/server/src/routes/comfy.ts` — 导入区并入：`import { existsSync } from 'node:fs'`、`import { readFile } from 'node:fs/promises'`、`import { isAbsolute, join } from 'node:path'`、`import { imageSize } from 'image-size'`。`app.get('/input-files', ...)` 之后加：

```ts
  /** 图片尺寸探测:uploads 本地优先,回退 GPU 侧;与执行器存在性回退同语义 */
  app.get('/image-dims', async (c) => {
    const name = c.req.query('name') ?? ''
    if (!name) return c.json({ error: '缺少 name 参数' }, 400)
    let bytes: Uint8Array | null = null
    const local = join(deps.config.dataDir, 'uploads', name)
    if (!name.includes('..') && !isAbsolute(name) && existsSync(local)) {
      bytes = await readFile(local)
    } else if (deps.comfy) {
      try {
        const buf = await deps.comfy.getInputImage(name)
        if (buf) bytes = new Uint8Array(buf)
      } catch {
        return c.json({ error: 'ComfyUI 离线,无法探测 GPU 侧图片尺寸' }, 503)
      }
    } else {
      return c.json({ error: 'ComfyUI 离线,无法探测 GPU 侧图片尺寸' }, 503)
    }
    if (!bytes) return c.json({ error: '图片不存在' }, 404)
    try {
      const dims = imageSize(bytes)
      if (!dims.width || !dims.height) throw new Error('no dims')
      return c.json({ width: dims.width, height: dims.height })
    } catch {
      return c.json({ error: '无法解析图片尺寸' }, 404)
    }
  })
```

注意：`image-size` v2 的命名导出是 `imageSize`；若安装版本的导出形式不同（v1 默认导出），按实际版本调整导入并在报告记录。

- [ ] **Step 5: 全绿验证**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): image-dims probe endpoint with local-then-comfyui fallback"
```

---

### Task 3: web — useImageDims + 表格模式锁定

**Files:**
- Create: `apps/web/src/hooks/use-image-dims.ts`
- Modify: `apps/web/src/pages/batch-new.tsx`（findDimPair/DimCell/dimsErrorText + TableEntry 接入）

**Interfaces:**
- Consumes: Task 1 `computeLockedDim`（`@cwe/shared`）；Task 2 端点
- Produces: `useImageDims(name: string | undefined)`（Task 4 复用）；`findDimPair(params: ParamDef[]): { width: ParamDef; height: ParamDef } | null` 与 `dimsErrorText(error: unknown): string`（batch-new.tsx 内共享，Task 4 复用）

- [ ] **Step 1: 创建 use-image-dims.ts**

```ts
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** 图片尺寸探测(uploads 本地或 GPU 侧);name 为空不请求,按文件名缓存 5 分钟 */
export function useImageDims(name: string | undefined) {
  return useQuery({
    queryKey: ['image-dims', name],
    enabled: !!name,
    queryFn: () =>
      api<{ width: number; height: number }>(`/comfy/image-dims?name=${encodeURIComponent(name!)}`),
    staleTime: 5 * 60_000,
    retry: false,
  })
}
```

- [ ] **Step 2: batch-new.tsx 加共享辅助**

导入区并入：`computeLockedDim` 加入 `@cwe/shared` 导入（现有 `import { expandMatrix, type ParamValues } from '@cwe/shared'` 改为 `import { computeLockedDim, expandMatrix, type ParamValues } from '@cwe/shared'`）；新行 `import { useImageDims } from '@/hooks/use-image-dims'`。

文件顶部（组件外，`rowId` 等辅助附近）加：

```ts
/** 第一对 inputName 为 width/height 的 number 参数;凑不齐返回 null */
function findDimPair(params: ParamDef[]): { width: ParamDef; height: ParamDef } | null {
  const width = params.find((p) => p.type === 'number' && p.inputName === 'width')
  const height = params.find((p) => p.type === 'number' && p.inputName === 'height')
  return width && height ? { width, height } : null
}

/** image-dims 失败提示:优先服务器错误文案 */
function dimsErrorText(error: unknown): string {
  const msg = error instanceof Error ? error.message : ''
  try {
    const parsed = JSON.parse(msg) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    // 非 JSON 报错走默认文案
  }
  return '无法获取源图尺寸'
}
```

文件末尾追加 DimCell 组件：

```tsx
/** 锁定比例时的宽/高单元格:编辑本格后按该行图片实际比例自动填另一格 */
function DimCell({
  p,
  otherKey,
  driver,
  imageName,
  locked,
  value,
  onPatch,
}: {
  p: ParamDef
  otherKey: string
  driver: 'width' | 'height'
  imageName: string
  locked: boolean
  value: string
  onPatch: (patch: Record<string, string | number>) => void
}) {
  const dims = useImageDims(locked && imageName ? imageName : undefined)
  const failed = locked && !!imageName && dims.isError
  return (
    <div className="space-y-1">
      <Input
        className="h-8"
        placeholder={String(p.default ?? '')}
        value={value}
        onChange={(e) => {
          const raw = e.target.value
          const n = Number(raw)
          if (locked && dims.data && raw !== '' && !Number.isNaN(n) && n > 0) {
            const computed = computeLockedDim(dims.data, driver, n)
            onPatch({
              [p.key]: raw,
              [otherKey]: driver === 'width' ? computed.height : computed.width,
            })
          } else {
            onPatch({ [p.key]: raw })
          }
        }}
      />
      {failed && <p className="text-xs text-muted-foreground">{dimsErrorText(dims.error)}</p>}
    </div>
  )
}
```

- [ ] **Step 3: TableEntry 接入**

TableEntry 组件体开头（现有 state 之后）加：

```tsx
  const dimPair = findDimPair(template.params)
  const imageParam = template.params.find((p) => p.type === 'image')
  const [lockRatio, setLockRatio] = useState(false)
```

返回的 JSX 中 `<Table>` 之前加开关（仅当两者都在）：

```tsx
      {dimPair && imageParam && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={lockRatio}
            onChange={(e) => setLockRatio(e.target.checked)}
          />
          锁定源图比例（填 {dimPair.width.key} 或 {dimPair.height.key} 自动按该行图片比例算另一个）
        </label>
      )}
```

单元格三元链中，在 `p.type === 'enum'` 分支之前插入 DimCell 分支（image 分支之后）：

```tsx
                  ) : lockRatio && dimPair && imageParam && (p.key === dimPair.width.key || p.key === dimPair.height.key) ? (
                    <DimCell
                      p={p}
                      otherKey={p.key === dimPair.width.key ? dimPair.height.key : dimPair.width.key}
                      driver={p.key === dimPair.width.key ? 'width' : 'height'}
                      imageName={String(row[imageParam.key] ?? imageParam.default ?? '')}
                      locked={lockRatio}
                      value={String(row[p.key] ?? '')}
                      onPatch={(patch) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r))
                        update(next)
                      }}
                    />
```

（完整三元顺序：image → DimCell（锁定时的宽/高）→ enum → 默认 Input；enum 与默认分支保持原样。）

- [ ] **Step 4: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): aspect-ratio lock with per-row autofill in table entry"
```

---

### Task 4: web — 批量图片 tab 锁定

**Files:**
- Modify: `apps/web/src/pages/batch-new.tsx`（ImagesEntry）

**Interfaces:**
- Consumes: Task 1 `computeLockedDim`；Task 3 `findDimPair`；Task 2 端点（直接 api 调用做并发探测，不走 hook——生成动作是一次性的）

- [ ] **Step 1: ImagesEntry 改造**

组件体 state 区（现有 state 之后）加：

```tsx
  const dimPair = findDimPair(template.params)
  const [lockRatio, setLockRatio] = useState(false)
  const [driver, setDriver] = useState<'width' | 'height'>('width')
  const [driverValue, setDriverValue] = useState('')
  const [dimsWarning, setDimsWarning] = useState('')
```

`onFiles` 整体替换为：

```tsx
  async function onFiles(files: FileList) {
    setUploading(true)
    setError('')
    setDimsWarning('')
    try {
      const n = Number(driverValue)
      if (lockRatio && dimPair && (!driverValue || Number.isNaN(n) || n <= 0)) {
        setError('锁定比例后需先填写有效的宽或高数值')
        return
      }
      const form = new FormData()
      for (const f of files) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      if (lockRatio && dimPair) {
        const results = await Promise.allSettled(
          stored.map((s) =>
            api<{ width: number; height: number }>(
              `/comfy/image-dims?name=${encodeURIComponent(s.stored)}`,
            ),
          ),
        )
        let failed = 0
        const jobs = stored.map((s, i) => {
          const r = results[i]!
          const base: ParamValues = { ...shared, [imageKey]: s.stored }
          if (r.status === 'fulfilled') {
            const d = computeLockedDim(r.value, driver, n)
            return { ...base, [dimPair.width.key]: d.width, [dimPair.height.key]: d.height }
          }
          failed++
          return base // 宽高留空 → 提交时用模板默认值
        })
        if (failed > 0) setDimsWarning(`${failed} 张图未能获取尺寸，已用模板默认宽高`)
        onChange(jobs)
      } else {
        onChange(stored.map((s) => ({ ...shared, [imageKey]: s.stored })))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }
```

返回 JSX 中，`otherParams` grid 之前加锁定块（仅当 dimPair 存在）：

```tsx
      {dimPair && (
        <div className="space-y-2 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={lockRatio}
              onChange={(e) => setLockRatio(e.target.checked)}
            />
            锁定源图比例（每张图按各自比例计算另一维）
          </label>
          {lockRatio && (
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
        </div>
      )}
```

`otherParams` grid 的渲染列表改为（锁定时隐藏宽高两个共享输入，避免与锁定块冲突）：

```tsx
        {otherParams
          .filter(
            (p) =>
              !(
                lockRatio &&
                dimPair &&
                (p.key === dimPair.width.key || p.key === dimPair.height.key)
              ),
          )
          .map((p) => (
```

（map 内部内容不变。）

JSX 末尾 error 提示旁加：

```tsx
      {dimsWarning && <p className="text-sm text-muted-foreground">⚠ {dimsWarning}</p>}
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @cwe/web exec tsc --noEmit && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/batch-new.tsx
git commit -m "feat(web): per-image aspect-ratio lock in batch images entry"
```

---

### Task 5: README + 全仓验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README**

「使用流程」第 3 条末尾追加一句（保留现有内容）：

```markdown
含图片输入且模板有 width/height 参数时，可「锁定源图比例」——表格模式填一维自动算另一维，批量图片模式每张图按各自比例计算（就近取整到 8 的倍数）
```

- [ ] **Step 2: 全仓验证**

Run: `pnpm -r test && pnpm -r typecheck && pnpm --filter @cwe/web build && pnpm --filter @cwe/server build`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: aspect-ratio lock in usage flow"
```

---

## 手动验收清单（合并前人工过一遍）

- [ ] 表格模式：选图后开锁定，填宽 → 高按该行图片比例自动填（8 倍数）；改高 → 宽重算；换图后再编辑取新图比例
- [ ] 行图片为空/文件名不存在时编辑宽高：不自动填，行内提示
- [ ] 批量图片：锁定+按宽定高填 1024，上传横竖不同的图 → 各任务高不同且符合比例
- [ ] ComfyUI 断开且值为 GPU 侧文件名：提示离线、不阻塞其他输入
- [ ] 端到端出图：输出尺寸与输入图等比不变形

## Self-Review 记录

- Spec 覆盖：§1.1 getInputImage（subfolder 拆分/404→null）→ Task 2；§1.2 image-dims 四路径判定+image-size → Task 2（测试覆盖 400/本地/GPU/404/解析失败/未配置 503/抛错 503）；§1.3 computeLockedDim+round8+驱动侧不取整+非正数抛错 → Task 1；§1.4 第一对识别 → Task 3 findDimPair；§2.1 useImageDims → Task 3；§2.2 表级开关+行级 DimCell+失败行内提示+手动可改 → Task 3（手动改计算格走默认 Input 逻辑?——计算格也是 DimCell,手动编辑它时它成为驱动侧重算另一格,符合"手动值生效/驱动可覆盖"语义）；§2.3 锁定块+driver Select+禁用自动框+逐图并发探测+失败用默认值+汇总横幅 → Task 4；§2.4 错误表逐条（404/503 文案经 dimsErrorText 取服务器错误、<8 下限在 round8、无对不渲染）；§3 测试策略对应 Task 1/2；§4 边界未越（矩阵未动/只第一对/无预设/无服务端缓存）。
- 类型一致性：`computeLockedDim` 签名 Task 1 定义、Task 3/4 使用一致；`ImageDims` 与端点响应 `{width,height}` 同形；`findDimPair`/`dimsErrorText` 在 Task 3 定义、Task 4 使用（同文件）；`FakeComfy.inputImages` 名称与 Task 2 测试一致；`useImageDims` queryKey 与 Global Constraints 澄清一致。
- 占位符扫描：无；代码完整。
- 已知实现选择：防抖以 react-query 缓存替代（Global Constraints 已记录）；表格模式两个宽高格在锁定时都是 DimCell（对称驱动），比 spec"最后编辑侧驱动"的描述更简单且行为一致。
