import { useQueryClient, useQuery } from '@tanstack/react-query'
import type { ColumnDef, Table as TanstackTable } from '@tanstack/react-table'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { BatchStatus } from '@cwe/shared'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DataTable, SortableHeader, selectColumn } from '@/components/data-table/data-table'
import { useEvents } from '@/hooks/use-events'
import { api } from '@/lib/api'
import { batchBulkActions, runBulk, summarizeBulk } from '@/lib/bulk'

export interface BatchSummaryDto {
  id: number
  templateId: number
  name: string
  status: BatchStatus
  createdAt: string
  templateName: string
  total: number
  succeeded: number
  failed: number
}

export const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'default',
  completed: 'secondary',
  canceled: 'outline',
  succeeded: 'secondary',
  failed: 'destructive',
}

const STATUSES: BatchStatus[] = ['pending', 'running', 'completed', 'canceled']

const columns: ColumnDef<BatchSummaryDto, any>[] = [
  selectColumn<BatchSummaryDto>(),
  {
    accessorKey: 'name',
    meta: { title: '名称' },
    header: ({ column }) => <SortableHeader column={column}>名称</SortableHeader>,
    cell: ({ row }) => (
      <Link to={`/batches/${row.original.id}`} className="font-medium hover:underline">
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: 'templateName',
    meta: { title: '模板' },
    header: '模板',
    filterFn: 'equals',
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    accessorKey: 'status',
    meta: { title: '状态' },
    header: '状态',
    cell: ({ row }) => <Badge variant={statusVariant[row.original.status]}>{row.original.status}</Badge>,
    filterFn: (row, id, value: string[]) =>
      value.length === 0 || value.includes(String(row.getValue(id))),
    enableSorting: false,
    enableGlobalFilter: false,
  },
  {
    id: 'progress',
    meta: { title: '进度' },
    header: '进度',
    cell: ({ row }) => (
      <span>
        {row.original.succeeded + row.original.failed}/{row.original.total}
        {row.original.failed > 0 && (
          <span className="ml-1 text-destructive">({row.original.failed} 失败)</span>
        )}
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
]

export default function BatchesPage() {
  useEvents()
  const [banner, setBanner] = useState('')
  const { data: batches = [] } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })
  const templateNames = [...new Set(batches.map((b) => b.templateName))]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Batches</h1>
        <Button asChild>
          <Link to="/batches/new">New Batch</Link>
        </Button>
      </div>
      {banner && <p className="text-sm text-muted-foreground">{banner}</p>}
      <DataTable
        columns={columns}
        data={batches}
        getRowId={(b) => String(b.id)}
        searchPlaceholder="搜索 batch 名称…"
        emptyText="还没有 batch"
        toolbarSlot={(table) => <BatchFilters table={table} templateNames={templateNames} />}
        bulkSlot={(table) => <BatchesBulkActions table={table} onDone={setBanner} />}
      />
    </div>
  )
}

function BatchFilters({
  table,
  templateNames,
}: {
  table: TanstackTable<BatchSummaryDto>
  templateNames: string[]
}) {
  const statusFilter = (table.getColumn('status')?.getFilterValue() as string[] | undefined) ?? []
  const templateFilter = (table.getColumn('templateName')?.getFilterValue() as string) ?? ''
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8">
            状态{statusFilter.length > 0 ? `(${statusFilter.length})` : ''}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {STATUSES.map((s) => (
            <DropdownMenuCheckboxItem
              key={s}
              checked={statusFilter.includes(s)}
              onCheckedChange={(v) => {
                const next = v ? [...statusFilter, s] : statusFilter.filter((x) => x !== s)
                table.getColumn('status')?.setFilterValue(next.length > 0 ? next : undefined)
              }}
            >
              {s}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select
        value={templateFilter || '__all__'}
        onValueChange={(v) =>
          table.getColumn('templateName')?.setFilterValue(v === '__all__' ? undefined : v)
        }
      >
        <SelectTrigger size="sm" className="w-40">
          <SelectValue placeholder="全部模板" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部模板</SelectItem>
          {templateNames.map((n) => (
            <SelectItem key={n} value={n}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}

function BatchesBulkActions({
  table,
  onDone,
}: {
  table: TanstackTable<BatchSummaryDto>
  onDone: (msg: string) => void
}) {
  const qc = useQueryClient()
  const [purge, setPurge] = useState(false)
  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original)
  const actions = batchBulkActions(selected)

  async function run(action: string, filter: (b: BatchSummaryDto) => boolean, fn: (b: BatchSummaryDto) => Promise<unknown>) {
    const targets = selected.filter(filter)
    const r = await runBulk(targets, (b) => b.name, fn)
    onDone(summarizeBulk(action, r))
    table.resetRowSelection()
    void qc.invalidateQueries({ queryKey: ['batches'] })
  }

  if (selected.length === 0) return null
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!actions.cancel}
        onClick={() =>
          run(
            '取消',
            (b) => b.status === 'pending' || b.status === 'running',
            (b) => api(`/batches/${b.id}/cancel`, { method: 'POST' }),
          )
        }
      >
        取消所选
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!actions.retry}
        onClick={() =>
          run(
            '重试',
            (b) => b.failed > 0,
            (b) => api(`/batches/${b.id}/retry-failed`, { method: 'POST' }),
          )
        }
      >
        重试失败
      </Button>
      <AlertDialog onOpenChange={(open) => { if (!open) setPurge(false) }}>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="destructive" disabled={!actions.del}>
            删除所选（{selected.length}）
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {selected.length} 个 batch？</AlertDialogTitle>
            <AlertDialogDescription>
              运行中的 batch 会被跳过（先取消再删）。默认只删除记录，输出文件保留在磁盘。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2">
            <Checkbox id="purge" checked={purge} onCheckedChange={(v) => setPurge(!!v)} />
            <Label htmlFor="purge">同时删除输出文件（结果画廊将被清空，不可恢复）</Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(
                  '删除',
                  () => true,
                  (b) =>
                    api(`/batches/${b.id}${purge ? '?purgeOutputs=1' : ''}`, { method: 'DELETE' }),
                )
              }
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
