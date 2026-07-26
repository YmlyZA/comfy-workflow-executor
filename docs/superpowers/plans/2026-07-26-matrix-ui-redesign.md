# 矩阵组合 UI 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 矩阵 tab 从「全参数 textarea 网格」重写为「共享参数 + 显式变化轴」，jobs 实时派生并带组合数软上限。

**Architecture:** 纯前端。新组件文件 `matrix-entry.tsx`（MatrixEntry + 轴卡片 + 值编辑器）；`EnumValueSelect` 抽到独立文件供三处共用；batch-new.tsx 删除旧矩阵组件。`expandMatrix` 与服务端零改动。规格见 `docs/superpowers/specs/2026-07-26-matrix-ui-redesign-design.md`。

**Tech Stack:** React 19 + react-query + shadcn/ui + Tailwind v4（`field-sizing-content` 可用）；复用 PR ① 的 `ImageMultiPick`。

## Global Constraints

- web 约定**不写渲染测试**，UI 文案用中文
- 不新增依赖，不改动 `packages/shared`（`expandMatrix` 原样复用）
- 测试命令：根目录 `pnpm typecheck && pnpm test`
- 提交信息结尾加 trailer：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 当前分支 `feat/matrix-ui-redesign`，直接在其上提交

---

### Task 1: 抽取 EnumValueSelect 到独立文件

**Files:**
- Create: `apps/web/src/components/enum-value-select.tsx`
- Modify: `apps/web/src/pages/batch-new.tsx`（删除本地 `EnumValueSelect`/`optionsErrorText`，改为 import）

**Interfaces:**
- Produces: `EnumValueSelect({ param: ParamDef, value: string, onChange: (v: string) => void })` 与 `optionsErrorText(error: unknown, suffix: string): string`，从 `@/components/enum-value-select` 导出（Task 2 的 matrix-entry 依赖）
- Consumes: 无

- [ ] **Step 1: 新建组件文件**

新建 `apps/web/src/components/enum-value-select.tsx`，内容为 batch-new.tsx 中现有 `optionsErrorText` 与 `EnumValueSelect` 两个定义的**原样搬移**（连同各自 JSDoc 注释），加上它们需要的 import，并把两者都加 `export`：

```tsx
import type { ParamDef } from '@cwe/shared'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useInputOptions } from '@/hooks/use-input-options'

/** input-options 失败时的降级提示:优先用服务器返回的错误(离线 503 / 已非枚举 404 文案不同) */
export function optionsErrorText(error: unknown, suffix: string): string {
  const msg = error instanceof Error ? error.message : ''
  try {
    const parsed = JSON.parse(msg) as { error?: string }
    if (parsed.error) return `${parsed.error},${suffix}`
  } catch {
    // 非 JSON 报错(网络异常等)走默认文案
  }
  return `ComfyUI 离线,${suffix}`
}

/** enum 参数单选:可选值来自服务器;离线/失败降级为文本输入 */
export function EnumValueSelect({
  param,
  value,
  onChange,
}: {
  param: ParamDef
  value: string
  onChange: (v: string) => void
}) {
  const { data, isError, error } = useInputOptions(param)
  if (!data || isError) {
    return (
      <Input
        className="h-8"
        placeholder={isError ? optionsErrorText(error, '手动输入') : String(param.default ?? '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="h-8">
        <SelectValue placeholder={String(param.default ?? '选择…')} />
      </SelectTrigger>
      <SelectContent>
        {data.options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

- [ ] **Step 2: batch-new.tsx 切换到 import**

`apps/web/src/pages/batch-new.tsx`：

- 删除文件内的 `optionsErrorText` 与 `EnumValueSelect` 两个定义（连同 JSDoc）
- import 区加：`import { EnumValueSelect } from '@/components/enum-value-select'`
- **暂不**删除 `useInputOptions` 的 import——旧 `EnumAxisPick` 本任务还在用它（Task 3 删）

- [ ] **Step 3: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（纯搬移，无行为变化）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/enum-value-select.tsx apps/web/src/pages/batch-new.tsx
git commit -m "refactor(web): EnumValueSelect 抽为共享组件

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 新建 matrix-entry.tsx（共享参数 + 显式变化轴）

**Files:**
- Create: `apps/web/src/components/matrix-entry.tsx`

**Interfaces:**
- Consumes: Task 1 的 `EnumValueSelect`/`optionsErrorText`；既有 `ImageMultiPick`、`ImageValueControl`、`useInputOptions`、`expandMatrix`、`TemplateDto`
- Produces: `MatrixEntry({ template: TemplateDto, onChange: (jobs: ParamValues[]) => void })` 具名导出（Task 3 的 batch-new 依赖）；内部组件不导出

- [ ] **Step 1: 写组件**

新建 `apps/web/src/components/matrix-entry.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react'
import { expandMatrix, type ParamDef, type ParamValues } from '@cwe/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { EnumValueSelect, optionsErrorText } from '@/components/enum-value-select'
import { ImageMultiPick } from '@/components/image-multi-pick'
import { ImageValueControl } from '@/components/image-value-control'
import { useInputOptions } from '@/hooks/use-input-options'
import type { TemplateDto } from '@/pages/templates'

/** 组合数软上限:超过则不生成 jobs */
const MAX_COMBOS = 1000

/** 矩阵组合:共享参数(单值) + 显式变化轴(值列表);jobs 实时派生 */
export function MatrixEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const [shared, setShared] = useState<ParamValues>({})
  const [axes, setAxes] = useState<Record<string, string[]>>({})

  const axisKeys = Object.keys(axes)
  const sharedParams = template.params.filter((p) => !(p.key in axes))

  function promote(key: string) {
    setAxes((prev) => ({ ...prev, [key]: [] }))
    setShared((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }
  function demote(key: string) {
    setAxes((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // 轴值解析:number/seed 转数字滤 NaN,其余 trim 滤空串
  const parsed = useMemo(() => {
    const out: Record<string, Array<string | number>> = {}
    for (const p of template.params) {
      const raw = axes[p.key]
      if (!raw) continue
      out[p.key] =
        p.type === 'number' || p.type === 'seed'
          ? raw.map(Number).filter((n) => !Number.isNaN(n))
          : raw.map((v) => v.trim()).filter(Boolean)
    }
    return out
  }, [axes, template.params])

  const activeAxes = Object.values(parsed).filter((v) => v.length > 0)
  const count = activeAxes.length === 0 ? 0 : activeAxes.reduce((acc, v) => acc * v.length, 1)

  useEffect(() => {
    if (count === 0 || count > MAX_COMBOS) {
      onChange([])
      return
    }
    const base: ParamValues = {}
    for (const [k, v] of Object.entries(shared)) {
      if (v !== '') base[k] = v
    }
    onChange(expandMatrix(parsed).map((combo) => ({ ...base, ...combo })))
  }, [parsed, shared, count, onChange])

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">共享参数（所有任务相同，留空用模板默认）</p>
        {sharedParams.length === 0 ? (
          <p className="text-sm text-muted-foreground">（全部参数已提升为变化轴）</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {sharedParams.map((p) => (
              <div key={p.key} className="space-y-1">
                <Label>{p.key}</Label>
                {p.type === 'enum' ? (
                  <EnumValueSelect
                    param={p}
                    value={String(shared[p.key] ?? '')}
                    onChange={(v) => setShared((prev) => ({ ...prev, [p.key]: v }))}
                  />
                ) : p.type === 'image' ? (
                  <ImageValueControl
                    value={String(shared[p.key] ?? '')}
                    placeholder={String(p.default ?? '')}
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
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">变化轴</p>
          <AddAxisSelect params={sharedParams} onAdd={promote} />
        </div>
        {axisKeys.length === 0 && (
          <p className="text-sm text-muted-foreground">
            还没有变化轴——添加 1-3 个要变化的参数，其余保持共享
          </p>
        )}
        {axisKeys.map((key) => {
          const p = template.params.find((x) => x.key === key)
          if (!p) return null
          return (
            <AxisCard
              key={key}
              param={p}
              values={axes[key] ?? []}
              onChange={(vals) => setAxes((prev) => ({ ...prev, [key]: vals }))}
              onRemove={() => demote(key)}
            />
          )
        })}
      </div>

      <p className={`text-sm ${count > MAX_COMBOS ? 'text-destructive' : 'text-muted-foreground'}`}>
        {count > MAX_COMBOS
          ? `组合数 ${count} 超过上限 ${MAX_COMBOS}，请减少轴值`
          : `共 ${count} 个任务`}
      </p>
    </div>
  )
}

/** 添加变化轴:选中即提升;全部提升后禁用 */
function AddAxisSelect({ params, onAdd }: { params: ParamDef[]; onAdd: (key: string) => void }) {
  return (
    <Select value="" onValueChange={(v) => v && onAdd(v)} disabled={params.length === 0}>
      <SelectTrigger size="sm" className="w-44">
        <SelectValue placeholder="+ 添加变化轴" />
      </SelectTrigger>
      <SelectContent>
        {params.map((p) => (
          <SelectItem key={p.key} value={p.key}>
            {p.key}（{p.type}）
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 单个变化轴卡片:按参数类型给不同的多值编辑器 */
function AxisCard({
  param,
  values,
  onChange,
  onRemove,
}: {
  param: ParamDef
  values: string[]
  onChange: (values: string[]) => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {param.key}
          <span className="ml-1 text-xs text-muted-foreground">
            （{param.type}，{values.length} 个值）
          </span>
        </p>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          移除
        </Button>
      </div>
      {param.type === 'image' ? (
        <ImageMultiPick value={values} onChange={onChange} />
      ) : param.type === 'enum' ? (
        <EnumAxisChecklist param={param} values={values} onChange={onChange} />
      ) : (
        <ValueList values={values} multiline={param.type === 'text'} onChange={onChange} />
      )}
      {param.type === 'seed' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([
              ...values,
              ...Array.from({ length: 5 }, () => String(Math.floor(Math.random() * 2 ** 31))),
            ])
          }
        >
          ＋随机×5
        </Button>
      )}
    </div>
  )
}

/** 值列表:每值一行可单独编辑/删除;text 用自适应高度 textarea,数字用窄 Input */
function ValueList({
  values,
  multiline,
  onChange,
}: {
  values: string[]
  multiline: boolean
  onChange: (values: string[]) => void
}) {
  function setAt(i: number, v: string) {
    onChange(values.map((x, j) => (j === i ? v : x)))
  }
  return (
    <div className="space-y-2">
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-2">
          {multiline ? (
            <Textarea
              rows={2}
              className="field-sizing-content min-h-0"
              value={v}
              onChange={(e) => setAt(i, e.target.value)}
            />
          ) : (
            <Input className="h-8 w-40" value={v} onChange={(e) => setAt(i, e.target.value)} />
          )}
          <Button size="sm" variant="ghost" onClick={() => onChange(values.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => onChange([...values, ''])}>
        + 加一个值
      </Button>
    </div>
  )
}

/** enum 轴:勾选列表;离线/失败降级为值列表手填 */
function EnumAxisChecklist({
  param,
  values,
  onChange,
}: {
  param: ParamDef
  values: string[]
  onChange: (values: string[]) => void
}) {
  const { data, isError, error } = useInputOptions(param)
  if (!data || isError) {
    return (
      <div className="space-y-1">
        {isError && (
          <p className="text-xs text-muted-foreground">{optionsErrorText(error, '手动输入值')}</p>
        )}
        <ValueList values={values} multiline={false} onChange={onChange} />
      </div>
    )
  }
  const chosen = new Set(values)
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
      {data.options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.has(o)}
            onChange={(e) => {
              if (e.target.checked) onChange([...values, o])
              else onChange(values.filter((v) => v !== o))
            }}
          />
          <span className="truncate" title={o}>
            {o}
          </span>
        </label>
      ))}
    </div>
  )
}
```

要点（实现时勿改动）：

- 派生 effect 的依赖是 `[parsed, shared, count, onChange]`——`parsed` 已 useMemo（axes/template.params 不变则引用稳定）、`shared`/`axes` 是 state、`onChange` 是父级 `setJobs`（稳定），不会形成 onChange→重渲染→再触发 的循环
- `count === 0`（无有值轴）与超上限都 `onChange([])`——提交按钮消失
- ValueList 用索引 key：值是完全受控的纯字符串，行内无内部状态/副作用，删行位移无隐患（与表格模式 SourceDimCell 的历史问题不同类）

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS（组件暂无消费者，仅验证类型；Task 3 接线）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/matrix-entry.tsx
git commit -m "feat(web): 矩阵组合重写为共享参数+显式变化轴(新组件,暂未接线)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: batch-new 接线新 MatrixEntry，删除旧组件

**Files:**
- Modify: `apps/web/src/pages/batch-new.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 的 `MatrixEntry`（`@/components/matrix-entry`）
- Produces: 无（终端接线）

- [ ] **Step 1: 接线与删除**

`apps/web/src/pages/batch-new.tsx`：

1. import 区加：`import { MatrixEntry } from '@/components/matrix-entry'`
2. 删除文件内旧 `MatrixEntry` 函数、`EnumAxisPick` 函数、`ImageAxisPick` 函数（连同各自 JSDoc）
3. 清理因此不再使用的 import——逐个确认文件内无其他使用处后删除：
   - `expandMatrix`（`@cwe/shared` 具名导入里去掉，`computeLockedDim`/`fitSource` 等保留）
   - `useInputOptions`（旧 EnumAxisPick 独占）
   - `ImageMultiPick`——注意 **ImagesEntry 仍在用，保留**
   - `Textarea`——TableEntry 的 CSV 粘贴仍在用，保留
4. `<TabsContent value="matrix">` 内的 `<MatrixEntry template={template} onChange={setJobs} />` 用法不变（新组件同名同 props）

- [ ] **Step 2: README 更新矩阵描述**

`README.md` 第 38 行那条「三种方式」说明中，「矩阵组合」后追加一句（插在「批量图片」之前的合适位置，保持整段通顺）：

```
矩阵组合采用「共享参数+变化轴」结构：默认参数为共享单值，显式添加变化轴后给多值（文本值列表支持长 prompt、enum 勾选、图片双来源多选、seed 一键随机×5），组合数实时显示、上限 1000。
```

- [ ] **Step 3: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（重点防 import 残留）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/batch-new.tsx README.md
git commit -m "feat(web): 矩阵 tab 接入新 MatrixEntry,删除旧全参数网格实现

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（PR 描述用）

1. prompt 轴 3 个值（含逗号与换行的长 prompt）× seed 轴「＋随机×5」→ 实时显示「共 15 个任务」，预览组合正确
2. 共享参数修改实时反映到所有组合；留空共享参数不出现在预览（用模板默认）
3. enum 轴勾选、image 轴双来源勾选（带缩略图）生效；ComfyUI 离线时 enum 轴降级为手填值列表
4. 移除轴 → 参数回到共享区；再次提升 → 轴值为空重新开始
5. 组合数超 1000 → 红字提示、提交按钮消失；降回上限内恢复
6. 三个 tab 互切不残留状态
7. 全部参数提升为轴后「+ 添加变化轴」禁用
