# 预览详情「对比原图」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** batch 详情页 Lightbox 中加入悬停跟随的原图/生成图对比模式（图片编辑类工作流专用）。

**Architecture:** 纯前端三件套——`lib/image-params.ts` 纯函数（判定可对比的 image 参数与解析文件名）、`components/image-compare.tsx` 自实现对比组件（两图叠放 + clip-path 悬停裁切 + 双源回退）、`pages/batch-detail.tsx` 的 Lightbox 接入（开关按钮 / 多图切换 / 翻页重置）。服务端零改动。

**Tech Stack:** React 19 + TypeScript + Tailwind v4 + Vitest（仅纯函数）；零新依赖。

## Global Constraints

- 不引入任何新 npm 依赖（spec「明确不做」：不引入 react-compare-slider 等）。
- 服务端零改动。
- web 包不写组件渲染测试，只测纯函数；交互验收走 PR 手动清单。
- 提交信息尾部：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 分割线左侧=原图、右侧=生成图；悬停跟随（无按住/拖动交互）。
- 原图双源回退顺序：`uploadFileUrl(name)` → `comfyInputFileUrl(name)` → 降级提示「原图不可用（可能已被清理或在其他主机）」。
- 工作分支：`feat/image-compare`（已存在，spec 提交 0b69bd5）。

---

### Task 1: image 参数纯函数 `imageParamsOf` / `imageParamValue`

**Files:**
- Create: `apps/web/src/lib/image-params.ts`
- Test: `apps/web/src/lib/image-params.test.ts`

**Interfaces:**
- Consumes: `ParamDef`, `ParamValues`（来自 `@cwe/shared`）
- Produces:
  - `imageParamsOf(defs: ParamDef[], values: ParamValues): ParamDef[]` — 过滤出 `type === 'image'` 且解析值（`values[key] ?? default`）为非空字符串的参数定义，保持原顺序
  - `imageParamValue(def: ParamDef, values: ParamValues): string` — 解析实际文件名（非字符串返回 `''`）

- [ ] **Step 1: 写失败测试**

`apps/web/src/lib/image-params.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { ParamDef } from '@cwe/shared'
import { imageParamsOf, imageParamValue } from './image-params'

const def = (over: Partial<ParamDef>): ParamDef => ({
  key: 'img',
  label: '图',
  nodeId: '1',
  inputName: 'image',
  type: 'image',
  ...over,
})

describe('imageParamsOf', () => {
  it('无 image 类型参数返回空', () => {
    expect(imageParamsOf([def({ type: 'text' })], { img: 'a.png' })).toEqual([])
  })

  it('值为空串不算可对比', () => {
    expect(imageParamsOf([def({})], { img: '' })).toEqual([])
  })

  it('值缺失回退 default', () => {
    const d = def({ default: 'd.png' })
    expect(imageParamsOf([d], {})).toEqual([d])
  })

  it('数字值不算可对比', () => {
    expect(imageParamsOf([def({})], { img: 5 })).toEqual([])
  })

  it('多个 image 参数保持模板顺序', () => {
    const a = def({ key: 'a' })
    const b = def({ key: 'b' })
    const seed = def({ key: 's', type: 'seed' })
    expect(imageParamsOf([a, seed, b], { a: '1.png', b: '2.png', s: 42 })).toEqual([a, b])
  })
})

describe('imageParamValue', () => {
  it('优先取 params 值,缺失回退 default', () => {
    expect(imageParamValue(def({ default: 'd.png' }), { img: 'x.png' })).toBe('x.png')
    expect(imageParamValue(def({ default: 'd.png' }), {})).toBe('d.png')
  })

  it('非字符串返回空串', () => {
    expect(imageParamValue(def({}), { img: 3 })).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/web test`
Expected: FAIL — `Failed to resolve import "./image-params"`

- [ ] **Step 3: 最小实现**

`apps/web/src/lib/image-params.ts`：

```ts
import type { ParamDef, ParamValues } from '@cwe/shared'

/** 解析 image 参数实际值:job 值缺失回退模板 default(与执行器取值逻辑一致);非字符串返回空串 */
export function imageParamValue(def: ParamDef, values: ParamValues): string {
  const v = values[def.key] ?? def.default
  return typeof v === 'string' ? v : ''
}

/** 过滤出可对比的 image 参数(解析值为非空字符串),保持模板定义顺序 */
export function imageParamsOf(defs: ParamDef[], values: ParamValues): ParamDef[] {
  return defs.filter((p) => p.type === 'image' && imageParamValue(p, values) !== '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/web test`
Expected: PASS（新增 7 条全绿，原有测试不受影响）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/image-params.ts apps/web/src/lib/image-params.test.ts
git commit -m "feat(web): image 参数对比判定纯函数

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ImageCompare 对比组件

**Files:**
- Create: `apps/web/src/components/image-compare.tsx`

**Interfaces:**
- Consumes: 无（自包含，仅 React）
- Produces: `ImageCompare({ beforeCandidates: string[]; afterSrc: string; afterAlt: string })` — 悬停跟随对比组件；`beforeCandidates` 依序回退，全失败降级为仅生成图 + 提示行

- [ ] **Step 1: 实现组件**

`apps/web/src/components/image-compare.tsx`：

```tsx
import { useEffect, useState } from 'react'

/**
 * 悬停跟随的原图/生成图对比:分割线跟随指针 X,线左原图、线右生成图。
 * beforeCandidates 依序回退(uploads → comfy input);全部失败隐藏叠加层,仅显示生成图+提示。
 */
export function ImageCompare({
  beforeCandidates,
  afterSrc,
  afterAlt,
}: {
  beforeCandidates: string[]
  afterSrc: string
  afterAlt: string
}) {
  const [pos, setPos] = useState(50)
  const [beforeIdx, setBeforeIdx] = useState(0)
  // join 出稳定 key:候选列表内容变化(切 job/切参数)时重置回退阶段与分割位置
  const candKey = beforeCandidates.join('\n')
  useEffect(() => {
    setBeforeIdx(0)
    setPos(50)
  }, [candKey])
  const beforeSrc = beforeIdx < beforeCandidates.length ? beforeCandidates[beforeIdx] : null

  return (
    <div className="space-y-1">
      <div
        className="relative cursor-crosshair select-none"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setPos(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)))
        }}
        onPointerLeave={() => setPos(50)}
      >
        <img
          src={afterSrc}
          alt={afterAlt}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
        {beforeSrc && (
          <>
            <img
              src={beforeSrc}
              alt="原图"
              draggable={false}
              className="absolute inset-0 size-full rounded-md object-contain"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              onError={() => setBeforeIdx((i) => i + 1)}
            />
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-primary"
              style={{ left: `${pos}%` }}
            />
            <span className="pointer-events-none absolute top-1 left-1 rounded bg-background/70 px-1.5 py-0.5 text-xs">
              原图
            </span>
            <span className="pointer-events-none absolute top-1 right-1 rounded bg-background/70 px-1.5 py-0.5 text-xs">
              生成图
            </span>
          </>
        )}
      </div>
      {!beforeSrc && (
        <p className="text-xs text-muted-foreground">原图不可用（可能已被清理或在其他主机）</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @cwe/web typecheck`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/image-compare.tsx
git commit -m "feat(web): ImageCompare 悬停跟随对比组件

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Lightbox 接入

**Files:**
- Modify: `apps/web/src/pages/batch-detail.tsx`（`Lightbox` 组件 275-352 行及父组件调用处 260-270 行）

**Interfaces:**
- Consumes: Task 1 的 `imageParamsOf` / `imageParamValue`；Task 2 的 `ImageCompare`；现有 `uploadFileUrl` / `comfyInputFileUrl`（`@/lib/api`）、`ParamDef`（`@cwe/shared`）
- Produces: `Lightbox` 新增 prop `imageParamDefs: ParamDef[]`（父组件传 `template.params.filter((p) => p.type === 'image')`）

- [ ] **Step 1: 改造 Lightbox**

`batch-detail.tsx` 新增 imports：

```tsx
import { useEffect, useState } from 'react'   // 原本只 import useState,补 useEffect
import type { BatchStatus, JobStatus, ParamDef, ParamValues } from '@cwe/shared'  // 补 ParamDef
import { api, comfyInputFileUrl, downloadUrl, errorMessage, outputUrl, uploadFileUrl } from '@/lib/api'  // 补两个 URL 函数
import { ImageCompare } from '@/components/image-compare'
import { imageParamsOf, imageParamValue } from '@/lib/image-params'
```

父组件调用处（`<Lightbox ...>`）加一行 prop：

```tsx
imageParamDefs={template.params.filter((p) => p.type === 'image')}
```

`Lightbox` 签名加 `imageParamDefs: ParamDef[]`，组件体改为：

```tsx
function Lightbox({ items, index, onClose, onIndex, hasSeed, rerollPending, onReroll, imageParamDefs }: {
  /* 原有 props 不变 */
  imageParamDefs: ParamDef[]
}) {
  const [compare, setCompare] = useState(false)
  const [compareKey, setCompareKey] = useState<string | null>(null)
  const cur = items[index]
  const imgParams = cur ? imageParamsOf(imageParamDefs, cur.job.params) : []
  const hasCompare = imgParams.length > 0
  // 翻页:重置参数选择;翻到无 image 输入的 job 自动退出对比模式
  useEffect(() => {
    setCompareKey(null)
    if (!hasCompare) setCompare(false)
  }, [index, hasCompare])
  if (!cur) return null
  const activeDef = imgParams.find((p) => p.key === compareKey) ?? imgParams[0]
  const comparing = compare && activeDef !== undefined
  ...
}
```

注意 hooks 必须在 `if (!cur) return null` **之前**（现状是先 `const cur` 后提前 return，hooks 加在两者之间）。

大图区域替换：

```tsx
{comparing ? (
  <ImageCompare
    beforeCandidates={[
      uploadFileUrl(imageParamValue(activeDef, cur.job.params)),
      comfyInputFileUrl(imageParamValue(activeDef, cur.job.params)),
    ]}
    afterSrc={outputUrl(cur.output.path)}
    afterAlt={cur.output.filename}
  />
) : (
  <img
    src={outputUrl(cur.output.path)}
    alt={cur.output.filename}
    className="max-h-[70vh] w-full rounded-md object-contain"
  />
)}
```

多图切换器：`comparing && imgParams.length > 1` 时，紧跟大图区域之后、params JSON 之前插入：

```tsx
{comparing && imgParams.length > 1 && (
  <span className="flex gap-1">
    {imgParams.map((p) => (
      <Button
        key={p.key}
        size="sm"
        variant={p.key === activeDef.key ? 'secondary' : 'ghost'}
        onClick={() => setCompareKey(p.key)}
      >
        {p.label}
      </Button>
    ))}
  </span>
)}
```

footer 左侧按钮组（← → 所在 `<span>`）追加开关按钮：

```tsx
{hasCompare && (
  <Button
    size="sm"
    variant={compare ? 'secondary' : 'outline'}
    onClick={() => setCompare((v) => !v)}
  >
    对比原图
  </Button>
)}
```

- [ ] **Step 2: 全量验证**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿（web 22+7=29，server 249，shared 30）；typecheck 3/3

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/pages/batch-detail.tsx
git commit -m "feat(web): Lightbox 接入对比原图模式

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: 手动验收清单（记入 PR 描述）**

1. [ ] 无 image 参数的模板：Lightbox 不出现「对比原图」按钮
2. [ ] 有 image 输入：开启对比后悬停跟随，线左原图/线右生成图，移出回弹 50%
3. [ ] 本地 uploads 原图正常显示；引用 GPU input 文件名时回退代理源
4. [ ] 两源都 404：显示「原图不可用」提示，生成图正常
5. [ ] 多 image 参数：切换按钮出现且高亮正确
6. [ ] 翻页到无 image job 自动退出对比；翻回需重新开启
7. [ ] 明暗两主题下分割线（primary 色）与角标可读
8. [ ] 尺寸不一致的原图/生成图不破版式

---

## Self-Review 记录

- Spec 覆盖：触发条件/组件/双源回退/多图切换/Lightbox 改造/测试 → Task 1/2/3 齐；「明确不做」无需任务。
- 占位符：无。
- 类型一致性：`imageParamsOf(defs, values)`、`imageParamValue(def, values)`、`ImageCompare` props 三处签名在 Task 1/2/3 间一致；`imageParamDefs` prop 命名与 spec 一致。
- 修正：hooks 顺序问题（`if (!cur) return null` 早退在 hooks 之前会违反 rules-of-hooks）已在 Task 3 显式注明 hooks 提前。
