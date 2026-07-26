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
