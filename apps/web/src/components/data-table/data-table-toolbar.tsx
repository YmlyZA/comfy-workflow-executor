import type { ReactNode } from 'react'
import type { Table as TanstackTable } from '@tanstack/react-table'
import { Settings2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

/** 全选勾选框:表格模式在表头,卡片模式(无表头)在工具栏,两处语义必须一致 */
export function SelectAllCheckbox<TData>({ table }: { table: TanstackTable<TData> }) {
  return (
    <Checkbox
      checked={table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && 'indeterminate')}
      onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
      aria-label="全选"
    />
  )
}

export function DataTableViewOptions<TData>({ table }: { table: TanstackTable<TData> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Settings2Icon className="mr-1 size-4" />列
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {table
          .getAllColumns()
          .filter((c) => c.getCanHide())
          .map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              onCheckedChange={(v) => column.toggleVisibility(!!v)}
            >
              {(column.columnDef.meta as { title?: string } | undefined)?.title ?? column.id}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DataTableToolbar<TData>({
  table,
  searchPlaceholder,
  toolbarSlot,
  bulkSlot,
  asCards,
}: {
  table: TanstackTable<TData>
  searchPlaceholder?: string
  toolbarSlot?: (table: TanstackTable<TData>) => ReactNode
  bulkSlot?: (table: TanstackTable<TData>) => ReactNode
  /** 卡片模式:无表头,故全选移到工具栏;列显隐对卡片无意义,隐藏「列」按钮 */
  asCards?: boolean
}) {
  const selected = table.getFilteredSelectedRowModel().rows.length
  const selectable = asCards && table.getAllColumns().some((c) => c.id === 'select')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder={searchPlaceholder ?? '搜索…'}
        value={(table.getState().globalFilter as string) ?? ''}
        onChange={(e) => table.setGlobalFilter(e.target.value)}
        className="h-8 w-56"
      />
      {toolbarSlot?.(table)}
      <div className="ml-auto flex items-center gap-2">
        {selectable && (
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
            <SelectAllCheckbox table={table} />
            全选
          </label>
        )}
        {selected > 0 && <span className="text-sm text-muted-foreground">已选 {selected} 项</span>}
        {bulkSlot?.(table)}
        {!asCards && <DataTableViewOptions table={table} />}
      </div>
    </div>
  )
}
