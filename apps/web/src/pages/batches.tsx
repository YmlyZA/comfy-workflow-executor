import { useQueryClient, useQuery } from '@tanstack/react-query'
import type { ColumnDef, Row, Table as TanstackTable } from '@tanstack/react-table'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
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
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable, SortableHeader, selectColumn } from '@/components/data-table/data-table'
import { OfflineBanner } from '@/components/offline-banner'
import { useEvents } from '@/hooks/use-events'
import { useCweStatus } from '@/hooks/use-cwe-status'
import { api } from '@/lib/api'
import { cn, formatUtcDateTime } from '@/lib/utils'
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

export const statusVariant: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  pending: 'secondary',
  running: 'default',
  completed: 'success',
  canceled: 'outline',
  succeeded: 'success',
  failed: 'destructive',
}

/** running 状态 Badge 前置脉冲圆点,与 statusVariant 配套使用 */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariant[status]}>
      {status === 'running' && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </Badge>
  )
}

/** 小屏卡片:整卡 Link 覆盖跳详情,Checkbox 提到 z-10 之上避免触发跳转 */
function BatchCard({ row }: { row: Row<BatchSummaryDto> }) {
  const b = row.original
  const done = b.succeeded + b.failed
  return (
    <div className={cn('relative rounded-md border p-3', row.getIsSelected() && 'border-primary')}>
      <Link to={`/batches/${b.id}`} className="absolute inset-0" aria-label={b.name} />
      <div className="flex items-center gap-2">
        <span className="relative z-10 flex items-center">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            aria-label="选择"
          />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
        <StatusBadge status={b.status} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Progress className="flex-1" value={(done / Math.max(b.total, 1)) * 100} />
        <span className="text-xs whitespace-nowrap">
          {done}/{b.total}
          {b.failed > 0 && <span className="ml-1 text-destructive">({b.failed} 失败)</span>}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{b.templateName}</span>
        <span className="whitespace-nowrap">{formatUtcDateTime(b.createdAt)}</span>
      </div>
    </div>
  )
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
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
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
    cell: ({ row }) => formatUtcDateTime(row.original.createdAt),
  },
]

export default function BatchesPage() {
  useEvents()
  const { data: batches = [], isPending } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })
  const templateNames = [...new Set(batches.map((b) => b.templateName))]

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
        <h1 className="text-xl font-semibold">Batches</h1>
        <Button asChild>
          <Link to="/batches/new">New Batch</Link>
        </Button>
      </div>
      <OfflineBanner hasActiveWork={batches.some((b) => b.status === 'running' || b.status === 'pending')} />
      <DataTable
        columns={columns}
        data={batches}
        getRowId={(b) => String(b.id)}
        searchPlaceholder="搜索 batch 名称…"
        emptyText="还没有 batch"
        toolbarSlot={(table) => <BatchFilters table={table} templateNames={templateNames} />}
        bulkSlot={(table) => <BatchesBulkActions table={table} />}
        renderCard={(row) => <BatchCard row={row} />}
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
}: {
  table: TanstackTable<BatchSummaryDto>
}) {
  const qc = useQueryClient()
  const [purge, setPurge] = useState(false)
  const [purgeGpu, setPurgeGpu] = useState(false)
  const cwe = useCweStatus()
  const cweInstalled = cwe.data?.installed === true
  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original)
  const actions = batchBulkActions(selected)
  // 批量请求在途时禁用按钮,防重复点击重复执行
  const [busy, setBusy] = useState(false)

  async function run(
    action: string,
    filter: (b: BatchSummaryDto) => boolean,
    fn: (b: BatchSummaryDto) => Promise<unknown>,
    extra?: () => string,
  ) {
    if (busy) return
    setBusy(true)
    try {
      await runInner()
    } finally {
      setBusy(false)
    }

    async function runInner() {
      const targets = selected.filter(filter)
      const r = await runBulk(targets, (b) => b.name, fn)
      const mappedFailed = r.failed.map((f) => ({
        ...f,
        message: f.message === 'batch is running' ? '运行中，先取消再删' : f.message,
      }))
      const msg = summarizeBulk(action, { ok: r.ok, failed: mappedFailed })
      const suffix = extra?.()
      // 全部失败(没有任何一项成功)才算操作失败;混合结果仍视为完成,附注放进 description
      if (r.ok === 0 && mappedFailed.length > 0) {
        toast.error(msg)
      } else {
        toast.success(msg, suffix ? { description: suffix } : undefined)
      }
      table.resetRowSelection()
      void qc.invalidateQueries({ queryKey: ['batches'] })
    }
  }

  if (selected.length === 0) return null
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !actions.cancel}
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
        disabled={busy || !actions.retry}
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
      <AlertDialog onOpenChange={(open) => { if (!open) { setPurge(false); setPurgeGpu(false) } }}>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="destructive" disabled={busy || !actions.del}>
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
          <div className="flex items-center gap-2">
            <Checkbox
              id="purge-gpu"
              checked={purgeGpu}
              disabled={!cweInstalled}
              onCheckedChange={(v) => setPurgeGpu(!!v)}
            />
            <Label htmlFor="purge-gpu" className={cweInstalled ? '' : 'text-muted-foreground'}>
              同时删除 GPU 主机上的输出文件
              {cweInstalled ? '' : '（需在 GPU 主机安装 cwe 扩展）'}
            </Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const purgeFailures: string[] = []
                const gpuFailures: string[] = []
                const gpuSkips: string[] = []
                const gpuMisses: string[] = []
                void run(
                  '删除',
                  () => true,
                  async (b) => {
                    const qs = new URLSearchParams()
                    if (purge) qs.set('purgeOutputs', '1')
                    if (purgeGpu) qs.set('purgeGpu', '1')
                    const q = qs.toString()
                    const res = await api<{
                      ok: true
                      purgeFailed?: boolean
                      gpuPurgeFailed?: boolean
                      gpuSkipped?: number
                      gpuMissing?: number
                    }>(`/batches/${b.id}${q ? `?${q}` : ''}`, { method: 'DELETE' })
                    if (res.purgeFailed) purgeFailures.push(b.name)
                    if (res.gpuPurgeFailed) gpuFailures.push(b.name)
                    if (res.gpuSkipped) gpuSkips.push(b.name)
                    if (res.gpuMissing) gpuMisses.push(`${b.name}(${res.gpuMissing})`)
                  },
                  () => {
                    const parts: string[] = []
                    if (purgeFailures.length > 0)
                      parts.push(`${purgeFailures.join('、')} 记录已删，但输出目录清理失败`)
                    if (gpuFailures.length > 0) parts.push(`${gpuFailures.join('、')} GPU 侧清理失败`)
                    if (gpuSkips.length > 0)
                      parts.push(`${gpuSkips.join('、')} GPU 侧引用缺失已跳过（旧批次）`)
                    if (gpuMisses.length > 0)
                      parts.push(
                        `${gpuMisses.join('、')} 部分 GPU 侧文件未找到（可能已被清理或主机已删除记录）`,
                      )
                    return parts.length > 0 ? parts.join('；') : ''
                  },
                )
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
