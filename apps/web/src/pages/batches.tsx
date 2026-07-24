import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { BatchStatus } from '@cwe/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useEvents } from '@/hooks/use-events'
import { api } from '@/lib/api'

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

export default function BatchesPage() {
  useEvents()
  const { data: batches = [] } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Batches</h1>
        <Button asChild>
          <Link to="/batches/new">New Batch</Link>
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>模板</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>进度</TableHead>
            <TableHead>创建时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((b) => (
            <TableRow key={b.id}>
              <TableCell>
                <Link to={`/batches/${b.id}`} className="font-medium hover:underline">
                  {b.name}
                </Link>
              </TableCell>
              <TableCell>{b.templateName}</TableCell>
              <TableCell>
                <Badge variant={statusVariant[b.status]}>{b.status}</Badge>
              </TableCell>
              <TableCell>
                {b.succeeded + b.failed}/{b.total}
                {b.failed > 0 && <span className="ml-1 text-destructive">({b.failed} 失败)</span>}
              </TableCell>
              <TableCell>{b.createdAt}</TableCell>
            </TableRow>
          ))}
          {batches.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                还没有 batch
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
