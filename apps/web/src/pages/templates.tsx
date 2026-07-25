import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, Table as TanstackTable } from '@tanstack/react-table'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ParamDef } from '@cwe/shared'
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
import { DataTable, SortableHeader, selectColumn } from '@/components/data-table/data-table'
import { DragHandle } from '@/components/data-table/sortable-rows'
import { api } from '@/lib/api'
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
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    id: 'params',
    meta: { title: '参数' },
    header: '参数',
    cell: ({ row }) => (
      <span className="space-x-1">
        {row.original.params.map((p) => (
          <Badge key={p.key} variant="secondary">
            {p.key}:{p.type}
          </Badge>
        ))}
      </span>
    ),
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    accessorKey: 'createdAt',
    meta: { title: '创建时间' },
    header: ({ column }) => <SortableHeader column={column}>创建时间</SortableHeader>,
    enableGlobalFilter: false,
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <span className="text-right">
        <Button asChild size="sm" variant="outline">
          <Link to={`/batches/new?template=${row.original.id}`}>新建 Batch</Link>
        </Button>
      </span>
    ),
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  },
]

export default function TemplatesPage() {
  const qc = useQueryClient()
  const [banner, setBanner] = useState('')
  const { data: templates = [] } = useQuery({
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
      setBanner(`排序保存失败：${apiErrorText(e)}`)
    },
    onSuccess: () => setBanner(''),
    onSettled: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Templates</h1>
        <Button asChild>
          <Link to="/templates/new">导入 Workflow</Link>
        </Button>
      </div>
      {banner && <p className="text-sm text-destructive">{banner}</p>}
      <DataTable
        columns={columns}
        data={templates}
        getRowId={(t) => String(t.id)}
        searchPlaceholder="搜索模板名称…"
        emptyText="还没有模板——先导入 workflow（支持 UI/API JSON 或 PNG）"
        reorder={{ onReorder: (ids) => reorderMut.mutate(ids.map(Number)) }}
        bulkSlot={(table) => (
          <TemplatesBulkDelete table={table} onDone={setBanner} />
        )}
      />
    </div>
  )
}

function TemplatesBulkDelete({
  table,
  onDone,
}: {
  table: TanstackTable<TemplateDto>
  onDone: (msg: string) => void
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
              onDone(summarizeBulk('删除', r))
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
