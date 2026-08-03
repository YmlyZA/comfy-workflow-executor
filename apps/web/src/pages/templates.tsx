import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, Table as TanstackTable } from '@tanstack/react-table'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import type { ParamDef } from '@cwe/shared'
import { MoreHorizontalIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable, SortableHeader, selectColumn } from '@/components/data-table/data-table'
import { DragHandle } from '@/components/data-table/sortable-rows'
import { api } from '@/lib/api'
import { formatUtcDateTime } from '@/lib/utils'
import { apiErrorText, runBulk, summarizeBulk } from '@/lib/bulk'

export interface TemplateDto {
  id: number
  name: string
  comfyJson: Record<string, any>
  params: ParamDef[]
  createdAt: string
  sortOrder: number
}

const columns: ColumnDef<TemplateDto, any>[] = [
  {
    id: 'drag',
    header: '',
    cell: ({ row }) => <DragHandle id={row.id} />,
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  },
  selectColumn<TemplateDto>(),
  {
    accessorKey: 'name',
    meta: { title: '名称' },
    header: ({ column }) => <SortableHeader column={column}>名称</SortableHeader>,
    cell: ({ row }) => (
      <span className="block max-w-48 truncate font-medium" title={row.original.name}>
        {row.original.name}
      </span>
    ),
  },
  {
    id: 'params',
    meta: { title: '参数' },
    header: '参数',
    cell: ({ row }) => {
      const params = row.original.params
      const rest = params.length - 3
      return (
        <span
          className="flex items-center gap-1 whitespace-nowrap"
          title={params.map((p) => `${p.key}:${p.type}`).join(', ')}
        >
          {params.slice(0, 3).map((p) => (
            <Badge key={p.key} variant="secondary" className="max-w-28">
              <span className="min-w-0 truncate">
                {p.key}:{p.type}
              </span>
            </Badge>
          ))}
          {rest > 0 && <Badge variant="outline">+{rest}</Badge>}
        </span>
      )
    },
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    accessorKey: 'createdAt',
    meta: { title: '创建时间' },
    header: ({ column }) => <SortableHeader column={column}>创建时间</SortableHeader>,
    enableGlobalFilter: false,
    cell: ({ row }) => formatUtcDateTime(row.original.createdAt),
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => <RowActions t={row.original} />,
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  },
]

export default function TemplatesPage() {
  const qc = useQueryClient()
  const { data: templates = [], isPending } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
  })

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) =>
      api('/templates/order', { method: 'PATCH', body: JSON.stringify({ ids }) }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['templates'] })
      const prev = qc.getQueryData<TemplateDto[]>(['templates'])
      if (prev) {
        const byId = new Map(prev.map((t) => [t.id, t]))
        qc.setQueryData(
          ['templates'],
          ids.map((id) => byId.get(id)).filter((t): t is TemplateDto => !!t),
        )
      }
      return { prev }
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(['templates'], ctx.prev)
      toast.error(`排序保存失败：${apiErrorText(e)}`)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  if (isPending)
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Templates</h1>
        <Button asChild>
          <Link to="/templates/new">导入 Workflow</Link>
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={templates}
        getRowId={(t) => String(t.id)}
        searchPlaceholder="搜索模板名称…"
        emptyText="还没有模板——先导入 workflow（支持 UI/API JSON 或 PNG）"
        reorder={{ onReorder: (ids) => reorderMut.mutate(ids.map(Number)) }}
        bulkSlot={(table) => <TemplatesBulkDelete table={table} />}
      />
    </div>
  )
}

function TemplatesBulkDelete({
  table,
}: {
  table: TanstackTable<TemplateDto>
}) {
  const qc = useQueryClient()
  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original)
  if (selected.length === 0) return null
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          删除所选（{selected.length}）
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除 {selected.length} 个模板？</AlertDialogTitle>
          <AlertDialogDescription>
            已有 batch 的模板会被跳过并在结果中列出。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              const r = await runBulk(
                selected,
                (t) => t.name,
                (t) => api(`/templates/${t.id}`, { method: 'DELETE' }),
              )
              const msg = summarizeBulk('删除', r)
              // 全部失败(没有任何一项成功)才算操作失败;混合结果仍视为完成
              if (r.ok === 0 && r.failed.length > 0) toast.error(msg)
              else toast.success(msg)
              table.resetRowSelection()
              void qc.invalidateQueries({ queryKey: ['templates'] })
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RowActions({ t }: { t: TemplateDto }) {
  const [renameOpen, setRenameOpen] = useState(false)
  return (
    <span className="flex items-center justify-end gap-1 whitespace-nowrap">
      <Button asChild size="sm" variant="outline">
        <Link to={`/batches/new?template=${t.id}`}>新建 Batch</Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="px-2" aria-label="更多操作">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>重命名</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/templates/new?from=${t.id}`}>重选参数</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog t={t} open={renameOpen} onOpenChange={setRenameOpen} />
    </span>
  )
}

function RenameDialog({
  t,
  open,
  onOpenChange,
}: {
  t: TemplateDto
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(t.name)
  const [error, setError] = useState('')
  // 每次打开回到当前名并清错(列表刷新后重开也拿到最新名)
  useEffect(() => {
    if (open) {
      setName(t.name)
      setError('')
    }
  }, [open, t.name])
  const rename = useMutation({
    mutationFn: (next: string) =>
      api(`/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ name: next }) }),
    onSuccess: () => {
      toast.success('已重命名')
      void qc.invalidateQueries({ queryKey: ['templates'] })
      onOpenChange(false)
    },
    onError: (e) => setError(apiErrorText(e)),
  })
  const trimmed = name.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名模板</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !rename.isPending) rename.mutate(trimmed)
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!trimmed || rename.isPending} onClick={() => rename.mutate(trimmed)}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
