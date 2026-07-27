import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HistoryIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

/** text 参数单值控件:手填 + 历史下拉(回填/单条删除);历史由服务端建批时自动记录 */
export function TextValueControl({
  paramKey,
  value,
  onChange,
  placeholder,
}: {
  paramKey: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const history = useQuery({
    queryKey: ['input-history', paramKey],
    queryFn: () => api<{ values: string[] }>(`/input-history?key=${encodeURIComponent(paramKey)}`),
    staleTime: 30_000,
    enabled: open,
  })

  async function remove(v: string) {
    await api(`/input-history?key=${encodeURIComponent(paramKey)}&value=${encodeURIComponent(v)}`, {
      method: 'DELETE',
    })
    void qc.invalidateQueries({ queryKey: ['input-history', paramKey] })
  }

  const values = history.data?.values ?? []
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 px-2" title="输入历史">
            <HistoryIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
          {values.map((v) => (
            <DropdownMenuItem key={v} onSelect={() => onChange(v)} className="flex items-center gap-2">
              <span className="max-w-72 truncate" title={v}>
                {v}
              </span>
              <button
                type="button"
                className="ml-auto rounded p-0.5 hover:bg-muted"
                title="删除该条历史"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(v)
                }}
              >
                <XIcon className="size-3" />
              </button>
            </DropdownMenuItem>
          ))}
          {values.length === 0 && <DropdownMenuItem disabled>（无历史）</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
