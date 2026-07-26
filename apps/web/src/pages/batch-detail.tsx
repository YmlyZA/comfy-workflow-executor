import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import type { BatchStatus, JobStatus, ParamValues } from '@cwe/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useEvents } from '@/hooks/use-events'
import { api, downloadUrl, outputUrl } from '@/lib/api'
import { statusVariant } from '@/pages/batches'
import type { TemplateDto } from '@/pages/templates'

export interface JobDto {
  id: number
  batchId: number
  sortOrder: number
  params: ParamValues
  status: JobStatus
  error: string | null
  outputs: Array<{ path: string; filename: string }> | null
  comfyPromptId: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface BatchDetailDto {
  batch: { id: number; name: string; status: BatchStatus; createdAt: string }
  template: TemplateDto
  jobs: JobDto[]
}

export default function BatchDetailPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const progress = useEvents()
  const { data } = useQuery({
    queryKey: ['batches', id],
    queryFn: () => api<BatchDetailDto>(`/batches/${id}`),
  })

  const act = useMutation({
    mutationFn: (action: 'cancel' | 'retry-failed') =>
      api(`/batches/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['batches'] }),
  })

  if (!data) return null
  const { batch, template, jobs } = data
  const done = jobs.filter((j) => ['succeeded', 'failed', 'canceled'].includes(j.status)).length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const gallery = jobs.filter((j) => j.status === 'succeeded').flatMap((j) => (j.outputs ?? []).map((o) => ({ job: j, output: o })))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{batch.name}</h1>
          <Badge variant={statusVariant[batch.status]}>{batch.status}</Badge>
          <span className="text-sm text-muted-foreground">模板：{template.name}</span>
        </div>
        <div className="space-x-2">
          {failed > 0 && (
            <Button variant="outline" onClick={() => act.mutate('retry-failed')} disabled={act.isPending}>
              重试失败任务（{failed}）
            </Button>
          )}
          {['pending', 'running'].includes(batch.status) && (
            <Button variant="destructive" onClick={() => act.mutate('cancel')} disabled={act.isPending}>
              取消
            </Button>
          )}
          <Button asChild variant="outline">
            <a href={downloadUrl(batch.id)}>下载 ZIP</a>
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <Progress value={(done / Math.max(jobs.length, 1)) * 100} />
        <p className="text-sm text-muted-foreground">
          {done}/{jobs.length} 完成
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>参数</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>输出 / 错误</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((j) => (
            <TableRow key={j.id}>
              <TableCell>{j.sortOrder}</TableCell>
              <TableCell className="max-w-96 truncate font-mono text-xs">
                {JSON.stringify(j.params)}
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant[j.status]}>{j.status}</Badge>
                {j.status === 'running' && progress[j.id] && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {progress[j.id]!.value}/{progress[j.id]!.max}
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-96 truncate text-xs">
                {j.error ? (
                  <span className="text-destructive">{j.error}</span>
                ) : (
                  (j.outputs ?? []).map((o) => o.filename).join(', ')
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {gallery.length > 0 && (
        <div>
          <h2 className="mb-3 font-medium">结果画廊（{gallery.length}）</h2>
          <div className="grid grid-cols-4 gap-4">
            {gallery.map(({ job, output }) => (
              <a
                key={output.path}
                href={outputUrl(output.path)}
                target="_blank"
                rel="noreferrer"
                className="group space-y-1"
              >
                <img
                  src={outputUrl(output.path)}
                  alt={output.filename}
                  loading="lazy"
                  className="aspect-square w-full rounded-md border object-cover transition group-hover:opacity-80"
                />
                <p className="truncate font-mono text-xs text-muted-foreground">
                  #{job.sortOrder} {JSON.stringify(job.params)}
                </p>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
