# 输出尺寸三态模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「锁定源图比例」二态升级为三态输出尺寸模式（模板默认 / 锁定比例 / 跟随源图），「跟随源图」直接采用源图尺寸并支持可选最长边上限。

**Architecture:** shared 新增纯函数 `fitSource`（round8 + 可选等比缩限）；前端 batch-new.tsx 的 ImagesEntry 与 TableEntry 把 lockRatio checkbox 替换为三态 Select，「跟随源图」在批量 tab 生成时逐图计算、在表格模式选图即自动填两格。服务端零改动（复用 GET /api/comfy/image-dims）。

**Tech Stack:** TypeScript strict + ESM（shared 内相对导入带 `.js` 后缀）、vitest、React 19 + react-query + shadcn/ui。

**Spec:** `docs/superpowers/specs/2026-07-25-output-size-modes-design.md`

## Global Constraints

- 不新增任何依赖
- 不改服务端代码、不加服务端测试
- web 包沿用无渲染测试约定（不写 React 组件测试）
- `round8(n) = max(8, round(n/8)*8)`（已存在，勿改）
- 上限取整偏差：fitSource 结果最长边允许比 maxEdge 大 ≤4px（round8 就近取整所致），不做二次夹取
- `maxEdge <= 0` 或未提供 → 视为无上限（不抛错）；source 宽或高 ≤0 → 抛错
- 三态文案：「模板默认」「锁定比例」「跟随源图」；上限输入 placeholder「最长边上限（留空=与源图一致）」
- commit 尾行：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 全量验证命令：`pnpm test`（根目录，= pnpm -r test）与 `pnpm typecheck`

---

### Task 1: shared fitSource 纯函数

**Files:**
- Modify: `packages/shared/src/dims.ts`（文件全文 25 行，追加到末尾）
- Test: `packages/shared/test/dims.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: 已有 `round8`、`ImageDims`（同文件）
- Produces: `fitSource(source: ImageDims, maxEdge?: number): ImageDims` — 经 `packages/shared/src/index.ts` 的 `export * from './dims.js'` 自动导出为 `@cwe/shared` 成员，Task 2/3 直接 `import { fitSource } from '@cwe/shared'`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/dims.test.ts` 末尾追加（import 行改为 `import { computeLockedDim, fitSource, round8 } from '../src/dims.js'`）：

```ts
describe('fitSource', () => {
  it('无上限:两维就近取整到 8', () => {
    expect(fitSource({ width: 2050, height: 1365 })).toEqual({ width: 2048, height: 1368 })
  })
  it('恰好等于上限不缩放', () => {
    expect(fitSource({ width: 1024, height: 768 }, 1024)).toEqual({ width: 1024, height: 768 })
  })
  it('超限横图等比缩到上限', () => {
    expect(fitSource({ width: 4000, height: 3000 }, 1024)).toEqual({ width: 1024, height: 768 })
  })
  it('超限竖图等比缩到上限', () => {
    expect(fitSource({ width: 3000, height: 4000 }, 1024)).toEqual({ width: 768, height: 1024 })
  })
  it('方图超限', () => {
    expect(fitSource({ width: 2048, height: 2048 }, 512)).toEqual({ width: 512, height: 512 })
  })
  it('极端长宽比:计算维下限 8', () => {
    expect(fitSource({ width: 4096, height: 16 }, 1024)).toEqual({ width: 1024, height: 8 })
  })
  it('上限非 8 倍数:允许 ≤4px 溢出', () => {
    expect(fitSource({ width: 2060, height: 2060 }, 1030)).toEqual({ width: 1032, height: 1032 })
  })
  it('maxEdge 非正视为未提供', () => {
    expect(fitSource({ width: 100, height: 50 }, 0)).toEqual({ width: 104, height: 48 })
    expect(fitSource({ width: 100, height: 50 }, -5)).toEqual({ width: 104, height: 48 })
  })
  it('源图尺寸非正数抛错', () => {
    expect(() => fitSource({ width: 0, height: 100 })).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/shared test`
Expected: FAIL — `fitSource` 未导出（`does not provide an export named 'fitSource'` 或同类报错）

- [ ] **Step 3: 实现**

在 `packages/shared/src/dims.ts` 末尾追加：

```ts
/** 跟随源图:两维就近取整到 8;超过最长边上限时先等比缩到上限(取整后允许 ≤4px 溢出) */
export function fitSource(source: ImageDims, maxEdge?: number): ImageDims {
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('source dims must be positive')
  }
  const longest = Math.max(source.width, source.height)
  const scale = maxEdge && maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1
  return { width: round8(source.width * scale), height: round8(source.height * scale) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/shared test`
Expected: PASS（全部，含原有 round8/computeLockedDim 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/dims.ts packages/shared/test/dims.test.ts
git commit -m "feat(shared): fitSource — follow-source dims with optional max-edge cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 批量图片 tab 三态模式（ImagesEntry）

**Files:**
- Modify: `apps/web/src/pages/batch-new.tsx`（ImagesEntry 函数约 342-512 行，及文件级辅助定义区约 514-531 行）

**Interfaces:**
- Consumes: Task 1 的 `fitSource`（`import { fitSource } from '@cwe/shared'`，并入现有 `computeLockedDim, expandMatrix` 那行 import）
- Produces: 文件级 `type SizeMode = 'default' | 'ratio' | 'source'` 与 `parseCap(text: string): number | undefined` —— Task 3 的 TableEntry 直接复用这两个定义，勿在 Task 3 重复声明

- [ ] **Step 1: 文件级定义**

在 `findDimPair` 函数（`/** 第一对 inputName 为 width/height 的 number 参数;凑不齐返回 null */` 注释处）上方添加：

```tsx
/** 输出尺寸模式:模板默认 / 锁定比例(填一边) / 跟随源图(可选最长边上限) */
type SizeMode = 'default' | 'ratio' | 'source'

/** 最长边上限解析:空/非法/非正视为未填 */
function parseCap(text: string): number | undefined {
  const n = Number(text)
  return text.trim() !== '' && !Number.isNaN(n) && n > 0 ? n : undefined
}
```

同时把文件顶部 `import { computeLockedDim, expandMatrix, type ParamValues } from '@cwe/shared'` 改为 `import { computeLockedDim, expandMatrix, fitSource, type ParamValues } from '@cwe/shared'`。

- [ ] **Step 2: ImagesEntry 状态替换**

把 ImagesEntry 内：

```tsx
  const [lockRatio, setLockRatio] = useState(false)
  const [driver, setDriver] = useState<'width' | 'height'>('width')
  const [driverValue, setDriverValue] = useState('')
  const [dimsWarning, setDimsWarning] = useState('')
```

替换为：

```tsx
  const [sizeMode, setSizeMode] = useState<SizeMode>('default')
  const [driver, setDriver] = useState<'width' | 'height'>('width')
  const [driverValue, setDriverValue] = useState('')
  const [capText, setCapText] = useState('')
  const [dimsWarning, setDimsWarning] = useState('')
```

- [ ] **Step 3: onFiles 分支改造**

onFiles 内两处改动。校验行：

```tsx
      const n = Number(driverValue)
      if (sizeMode === 'ratio' && dimPair && (!driverValue || Number.isNaN(n) || n <= 0)) {
        setError('锁定比例后需先填写有效的宽或高数值')
        return
      }
```

探测分支：把 `if (lockRatio && dimPair) {` 改为 `if (sizeMode !== 'default' && dimPair) {`，并在其内 `let failed = 0` 之前加一行 `const cap = parseCap(capText)`，把 fulfilled 分支：

```tsx
          if (r.status === 'fulfilled') {
            const d = computeLockedDim(r.value, driver, n)
            return { ...base, [dimPair.width.key]: d.width, [dimPair.height.key]: d.height }
          }
```

改为：

```tsx
          if (r.status === 'fulfilled') {
            const d =
              sizeMode === 'ratio' ? computeLockedDim(r.value, driver, n) : fitSource(r.value, cap)
            return { ...base, [dimPair.width.key]: d.width, [dimPair.height.key]: d.height }
          }
```

其余（failed 计数、横幅文案、else 普通分支）不动。

- [ ] **Step 4: 控件区替换**

把 `{dimPair && (` 开始的整个 rounded-md border 块（checkbox + lockRatio 条件区）替换为：

```tsx
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
```

- [ ] **Step 5: 共享参数过滤条件**

otherParams 的 `.filter(` 内条件：

```tsx
              !(
                lockRatio &&
                dimPair &&
                (p.key === dimPair.width.key || p.key === dimPair.height.key)
              ),
```

改为：

```tsx
              !(
                sizeMode !== 'default' &&
                dimPair &&
                (p.key === dimPair.width.key || p.key === dimPair.height.key)
              ),
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全部 PASS（注意：此步 TableEntry 仍引用 `lockRatio` 于自身作用域内，未被本 task 触碰，不会报错——TableEntry 的 lockRatio 是它自己的 useState）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/batch-new.tsx
git commit -m "feat(web): tri-mode output size in images tab (default/ratio/follow-source)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 表格模式三态 + 选图自动填 + README

**Files:**
- Create: `apps/web/src/hooks/use-debounced-value.ts`
- Modify: `apps/web/src/pages/batch-new.tsx`（TableEntry 函数约 137-280 行；文件末尾追加 SourceDimCell 组件）
- Modify: `README.md`（第 38 行）

**Interfaces:**
- Consumes: Task 1 `fitSource`（import 已由 Task 2 加好）；Task 2 的 `SizeMode`、`parseCap`（文件级定义，直接用）；已有 `useImageDims`、`dimsErrorText`、`DimCell`
- Produces: `useDebouncedValue<T>(value: T, delayMs?: number): T`；`SourceDimCell` 组件（仅本文件内使用）

- [ ] **Step 1: 防抖 hook**

创建 `apps/web/src/hooks/use-debounced-value.ts`：

```ts
import { useEffect, useState } from 'react'

/** 值防抖:delayMs 内无新值才更新返回值(手填文件名时避免逐键触发探测) */
export function useDebouncedValue<T>(value: T, delayMs = 500): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
```

- [ ] **Step 2: batch-new.tsx imports**

- react import 行 `import { useMemo, useRef, useState } from 'react'` 改为 `import { useEffect, useMemo, useRef, useState } from 'react'`
- 在 `import { useImageDims } from '@/hooks/use-image-dims'` 旁添加 `import { useDebouncedValue } from '@/hooks/use-debounced-value'`

- [ ] **Step 3: TableEntry 状态与控件**

把 `const [lockRatio, setLockRatio] = useState(false)` 替换为：

```tsx
  const [sizeMode, setSizeMode] = useState<SizeMode>('default')
  const [capText, setCapText] = useState('')
```

把 checkbox 块：

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

替换为：

```tsx
      {dimPair && imageParam && (
        <div className="flex items-center gap-2 text-sm">
          <Label>输出尺寸</Label>
          <Select value={sizeMode} onValueChange={(v) => setSizeMode(v as SizeMode)}>
            <SelectTrigger className="h-8 w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">模板默认</SelectItem>
              <SelectItem value="ratio">锁定比例（填一边自动算另一边）</SelectItem>
              <SelectItem value="source">跟随源图（选图自动填宽高）</SelectItem>
            </SelectContent>
          </Select>
          {sizeMode === 'source' && (
            <Input
              className="h-8 w-56"
              type="number"
              min={8}
              placeholder="最长边上限（留空=与源图一致）"
              value={capText}
              onChange={(e) => setCapText(e.target.value)}
            />
          )}
        </div>
      )}
```

- [ ] **Step 4: 单元格分支**

单元格 ternary 中 ratio 分支条件 `lockRatio && dimPair && imageParam && (p.key === dimPair.width.key || p.key === dimPair.height.key)` 改为 `sizeMode === 'ratio' && dimPair && imageParam && (p.key === dimPair.width.key || p.key === dimPair.height.key)`，其内 `locked={lockRatio}` 改为 `locked={sizeMode === 'ratio'}`。

在该 ratio 分支之后、`p.type === 'enum'` 分支之前插入 source 分支（只接管宽格；高格走默认 Input 分支，保持可手改）：

```tsx
                  ) : sizeMode === 'source' && dimPair && imageParam && p.key === dimPair.width.key ? (
                    <SourceDimCell
                      p={p}
                      heightKey={dimPair.height.key}
                      imageName={String(row[imageParam.key] ?? imageParam.default ?? '')}
                      cap={parseCap(capText)}
                      value={String(row[p.key] ?? '')}
                      onPatch={(patch) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r))
                        update(next)
                      }}
                    />
```

- [ ] **Step 5: SourceDimCell 组件**

在文件末尾（DimCell 之后）追加：

```tsx
/** 跟随源图模式的宽格:该行图片(或上限)变化后探测尺寸,把宽高两格一起写入;仍可手改 */
function SourceDimCell({
  p,
  heightKey,
  imageName,
  cap,
  value,
  onPatch,
}: {
  p: ParamDef
  heightKey: string
  imageName: string
  cap: number | undefined
  value: string
  onPatch: (patch: Record<string, string | number>) => void
}) {
  const debouncedName = useDebouncedValue(imageName)
  const dims = useImageDims(debouncedName || undefined)
  const patchRef = useRef(onPatch)
  patchRef.current = onPatch
  useEffect(() => {
    if (dims.data) {
      const d = fitSource(dims.data, cap)
      patchRef.current({ [p.key]: d.width, [heightKey]: d.height })
    }
  }, [dims.data, cap, p.key, heightKey])
  const failed = !!imageName && dims.isError
  return (
    <div className="space-y-1">
      <Input
        className="h-8"
        placeholder={String(p.default ?? '')}
        value={value}
        onChange={(e) => onPatch({ [p.key]: e.target.value })}
      />
      {failed && <p className="text-xs text-muted-foreground">{dimsErrorText(dims.error)}</p>}
    </div>
  )
}
```

关键约束（勿改动）：`patchRef` 是防无限循环的核心——`onPatch` 每次渲染都是新闭包，直接放进 effect deps 会导致「填值→重渲→新 onPatch→effect 重跑」死循环；effect deps 只含 `dims.data, cap, p.key, heightKey`，语义正好是「图片尺寸到位或上限变化时覆盖，手改不触发」。

- [ ] **Step 6: README**

`README.md` 第 38 行，把结尾一句：

```
含图片输入且模板有 width/height 参数时，可「锁定源图比例」——表格模式填一维自动算另一维，批量图片模式每张图按各自比例计算（就近取整到 8 的倍数）
```

改为：

```
含图片输入且模板有 width/height 参数时，「输出尺寸」有三种模式：模板默认；锁定比例——填一维按源图比例自动算另一维；跟随源图——宽高直接取源图尺寸（可设最长边上限，超限等比缩小），表格模式选图即自动填充。计算维均就近取整到 8 的倍数
```

- [ ] **Step 7: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/hooks/use-debounced-value.ts apps/web/src/pages/batch-new.tsx README.md
git commit -m "feat(web): follow-source auto-fill in table mode with max-edge cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 已知行为边界（实现时按此为准，不是 bug）

- 表格模式 source 下 CSV 导入：导入行含 image 与宽高值时，探测成功后会用 fitSource 结果**覆盖 CSV 里的宽高**（模式语义优先）；用户想保 CSV 宽高应选「模板默认」模式
- source 模式某行 image 清空后，已填的宽高值保留（不清除）
- 上限输入逐键变化会即时重算（dims 有 react-query 缓存，无网络放大）
- 矩阵模式不支持任何锁定/跟随（现状不变）

## 手动验收清单（合并前用户过一遍）

1. 批量 tab · 跟随源图 · 不填上限：上传 2 张不同尺寸图 → 预览宽高与各源图一致（8 取整）
2. 批量 tab · 跟随源图 · 上限 1024：4000×3000 的图 → 1024×768；小于上限的图原样
3. 表格 · 跟随源图：选图后宽高两格自动出现实际值；换图重新覆盖；改上限触发重算；手改宽格后值保留
4. 表格 · 锁定比例：行为与 PR #6 一致（回归确认）
5. 降级：ComfyUI 离线 + 填 GPU 侧文件名 → 表格行内提示、批量横幅提示，任务用模板默认宽高
