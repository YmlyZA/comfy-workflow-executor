import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
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

function usePromptComplete<T extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  onChange: (v: string) => void,
) {
  const elRef = useRef<T>(null)
  const [caret, setCaret] = useState<number | null>(null)
  // Esc 关闭的 token 起点;当当前捕获态的 start 与此相同时保持关闭,直到出现新的 $(不同 start)
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)
  // 失焦关闭;下一次 input 事件即恢复(与 dismissedStart 的“持久关闭”语义不同)
  const [blurClosed, setBlurClosed] = useState(false)
  const [hi, setHi] = useState(0)
  // 展开后待写回的光标位置;value 落地(受控更新)后在 effect 里生效
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  const rawCapture = caret != null ? deriveCapture(value, caret) : null
  const capture =
    rawCapture && !blurClosed && rawCapture.start !== dismissedStart ? rawCapture : null
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

  // 受控组件的 value 更新落地后,把光标精确放到插入内容末尾(而不是浏览器默认的整段末尾)
  useLayoutEffect(() => {
    if (pendingCaret == null) return
    const el = elRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(pendingCaret, pendingCaret)
    }
    setCaret(pendingCaret)
    setPendingCaret(null)
  }, [value, pendingCaret])

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setCaret(e.target.selectionStart)
    setBlurClosed(false)
    setHi(0)
    onChange(e.target.value)
  }

  function pick(p: PromptRow) {
    if (!capture || caret == null) return
    const newValue = value.slice(0, capture.start) + p.content + value.slice(caret)
    const newCaret = capture.start + p.content.length
    // 插入内容里若恰好含 $,预先把它标记为“已关闭”,避免选中后立刻又弹出;
    // 等用户真正敲出新的 $(不同 start)才会重新打开
    const nextCapture = deriveCapture(newValue, newCaret)
    onChange(newValue)
    setDismissedStart(nextCapture ? nextCapture.start : null)
    setPendingCaret(newCaret)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!capture) return
    if (e.key === 'Escape') {
      e.preventDefault()
      setDismissedStart(capture.start)
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

  return {
    ref: elRef,
    handleChange,
    handleKeyDown,
    handleBlur: () => setBlurClosed(true),
    dropdown,
  }
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
  const c = usePromptComplete<HTMLInputElement>(value, onChange)
  return (
    <div className="relative flex-1">
      <Input
        ref={c.ref}
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
  const c = usePromptComplete<HTMLTextAreaElement>(value, onChange)
  return (
    <div className="relative flex-1">
      <Textarea
        ref={c.ref}
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
