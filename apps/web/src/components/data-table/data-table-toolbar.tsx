import type { ReactNode } from 'react'
import type { Table as TanstackTable } from '@tanstack/react-table'
import { Settings2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

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
}: {
  table: TanstackTable<TData>
  searchPlaceholder?: string
  toolbarSlot?: (table: TanstackTable<TData>) => ReactNode
  bulkSlot?: (table: TanstackTable<TData>) => ReactNode
}) {
  const selected = table.getFilteredSelectedRowModel().rows.length
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
        {selected > 0 && <span className="text-sm text-muted-foreground">已选 {selected} 项</span>}
        {bulkSlot?.(table)}
        <DataTableViewOptions table={table} />
      </div>
    </div>
  )
}
