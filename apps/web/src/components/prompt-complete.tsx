import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { fetchPrompts, type PromptRow } from '@/lib/prompts'
import { cn } from '@/lib/utils'

/** 光标前最近的 $ 且到光标间无空白 → 捕获态 {start, frag};否则 null */
function deriveCapture(value: string, caret: number): { start: number; frag: string } | null {
  const before = value.slice(0, caret)
  const dollar = before.lastIndexOf('$')
  if (dollar === -1) return null
  const frag = before.slice(dollar + 1)
  if (/\s/.test(frag)) return null
  return { start: dollar, frag }
}

function usePromptComplete(value: string, onChange: (v: string) => void) {
  const [caret, setCaret] = useState<number | null>(null)
  const [closed, setClosed] = useState(false)
  const [hi, setHi] = useState(0)
  const capture = !closed && caret != null ? deriveCapture(value, caret) : null
  const open = capture != null
  const query = useQuery({
    queryKey: ['prompts'],
    queryFn: fetchPrompts,
    staleTime: 30_000,
    enabled: open,
  })
  const matches = capture
    ? (query.data?.prompts ?? []).filter((p) =>
        p.key.toLowerCase().includes(capture.frag.toLowerCase()),
      )
    : []
  const highlighted = Math.min(hi, Math.max(matches.length - 1, 0))

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setCaret(e.target.selectionStart)
    setClosed(false)
    setHi(0)
    onChange(e.target.value)
  }

  function pick(p: PromptRow) {
    if (!capture || caret == null) return
    onChange(value.slice(0, capture.start) + p.content + value.slice(caret))
    setClosed(true)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosed(true)
      return
    }
    if (matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi(Math.min(highlighted + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi(Math.max(highlighted - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(matches[highlighted]!)
    }
  }

  const dropdown = open ? (
    <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full min-w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {matches.map((p, i) => (
        <button
          key={p.id}
          type="button"
          className={cn(
            'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm',
            i === highlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(p)}
        >
          <span className="font-mono text-xs">{p.key}</span>
          <span className="max-w-full truncate text-xs text-muted-foreground">{p.content}</span>
        </button>
      ))}
      {matches.length === 0 && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">（无匹配）</div>
      )}
    </div>
  ) : null

  return { handleChange, handleKeyDown, handleBlur: () => setClosed(true), dropdown }
}

/** 带 $key 补全的 text 单值输入框;onChange 收字符串 */
export function PromptCompleteInput({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}) {
  const c = usePromptComplete(value, onChange)
  return (
    <div className="relative flex-1">
      <Input
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={c.handleChange}
        onKeyDown={c.handleKeyDown}
        onBlur={c.handleBlur}
      />
      {c.dropdown}
    </div>
  )
}

/** 带 $key 补全的多行输入;onChange 收字符串 */
export function PromptCompleteTextarea({
  value,
  onChange,
  className,
  rows,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  rows?: number
}) {
  const c = usePromptComplete(value, onChange)
  return (
    <div className="relative flex-1">
      <Textarea
        className={className}
        rows={rows}
        value={value}
        onChange={c.handleChange}
        onKeyDown={c.handleKeyDown}
        onBlur={c.handleBlur}
      />
      {c.dropdown}
    </div>
  )
}
