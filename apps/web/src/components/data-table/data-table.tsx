import * as React from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table as TanstackTable,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useMediaQuery } from '@/hooks/use-media-query'
import { DataTablePagination } from './data-table-pagination'
import { DataTableToolbar } from './data-table-toolbar'
import { DndDisabledContext, SortableRow } from './sortable-rows'

export function SortableHeader<TData>({
  column,
  children,
}: {
  column: Column<TData, unknown>
  children: React.ReactNode
}) {
  const dir = column.getIsSorted()
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-8"
      onClick={() => column.toggleSorting(dir === 'asc')}
    >
      {children}
      {dir === 'asc' ? (
        <ArrowUpIcon className="ml-1 size-3.5" />
      ) : dir === 'desc' ? (
        <ArrowDownIcon className="ml-1 size-3.5" />
      ) : (
        <ArrowUpDownIcon className="ml-1 size-3.5" />
      )}
    </Button>
  )
}

/** 勾选列:表头全选作用于过滤后的全部行(跨页) */
export function selectColumn<TData>(): ColumnDef<TData> {
  return {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && 'indeterminate')
        }
        onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
        aria-label="全选"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
        aria-label="选择行"
      />
    ),
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
  }
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[]
  data: TData[]
  getRowId: (row: TData) => string
  searchPlaceholder?: string
  emptyText?: string
  toolbarSlot?: (table: TanstackTable<TData>) => React.ReactNode
  bulkSlot?: (table: TanstackTable<TData>) => React.ReactNode
  /** 提供时,小屏(<md)下用卡片列表替换表格主体;筛选/排序/选择/分页照常生效 */
  renderCard?: (row: Row<TData>) => React.ReactNode
  /** 提供即启用行拖拽(仅在无排序/搜索/过滤时可拖);onReorder 收到过滤前完整 id 新顺序 */
  reorder?: { onReorder: (ids: string[]) => void }
}

export function DataTable<TData>({
  columns,
  data,
  getRowId,
  searchPlaceholder,
  emptyText = '暂无数据',
  toolbarSlot,
  bulkSlot,
  renderCard,
  reorder,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, columnFilters, globalFilter, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  })

  const dndDisabled =
    sorting.length > 0 || columnFilters.length > 0 || globalFilter.trim() !== ''

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor))

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = data.map(getRowId)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    reorder?.onReorder(arrayMove(ids, from, to))
  }

  const rows = table.getRowModel().rows

  const isMobile = useMediaQuery('(max-width: 767px)')
  const asCards = renderCard !== undefined && isMobile

  const tableEl = (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((h) => (
              <TableHead key={h.id}>
                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
              {emptyText}
            </TableCell>
          </TableRow>
        ) : reorder ? (
          rows.map((row) => <SortableRow key={row.id} row={row} />)
        ) : (
          rows.map((row) => (
            <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-3">
      <DataTableToolbar
        table={table}
        searchPlaceholder={searchPlaceholder}
        toolbarSlot={toolbarSlot}
        bulkSlot={bulkSlot}
      />
      {asCards ? (
        rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <React.Fragment key={row.id}>{renderCard!(row)}</React.Fragment>
            ))}
          </div>
        )
      ) : reorder ? (
        <DndDisabledContext.Provider value={dndDisabled}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              {tableEl}
            </SortableContext>
          </DndContext>
        </DndDisabledContext.Provider>
      ) : (
        tableEl
      )}
      <DataTablePagination table={table} />
    </div>
  )
}
