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
import { PromptCompleteTextarea } from '@/components/prompt-complete'
import { EnumValueSelect, optionsErrorText } from '@/components/enum-value-select'
import { ImageMultiPick } from '@/components/image-multi-pick'
import { TextValueControl } from '@/components/text-value-control'
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
          ? raw.filter((s) => s.trim() !== '').map(Number).filter((n) => !Number.isNaN(n))
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
            <PromptCompleteTextarea
              rows={2}
              className="field-sizing-content min-h-0"
              value={v}
              onChange={(nv) => setAt(i, nv)}
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
