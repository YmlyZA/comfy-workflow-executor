import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { flexRender, type Row } from '@tanstack/react-table'
import { GripVerticalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TableCell, TableRow } from '@/components/ui/table'

/** 列排序/搜索/过滤激活时置 true,由 DataTable 提供 */
export const DndDisabledContext = React.createContext(false)

export function DragHandle({ id }: { id: string }) {
  const disabled = React.useContext(DndDisabledContext)
  const { attributes, listeners } = useSortable({ id, disabled })
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      title={disabled ? '排序或过滤激活时不可拖拽' : '拖拽调整顺序'}
      className="size-7 cursor-grab p-0 text-muted-foreground"
      {...attributes}
      {...(disabled ? {} : listeners)}
    >
      <GripVerticalIcon className="size-4" />
    </Button>
  )
}

export function SortableRow<TData>({ row }: { row: Row<TData> }) {
  const { setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  return (
    <TableRow
      ref={setNodeRef}
      data-state={row.getIsSelected() && 'selected'}
      className={isDragging ? 'relative z-10 opacity-80' : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
      ))}
    </TableRow>
  )
}
