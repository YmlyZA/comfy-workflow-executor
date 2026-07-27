import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DicesIcon } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useState } from 'react'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  nav: { prevId: number | null; nextId: number | null }
}

export default function BatchDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [lightbox, setLightbox] = useState<number | null>(null)
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

  const [rerollMsg, setRerollMsg] = useState('')
  const reroll = useMutation({
    mutationFn: (jobId: number) =>
      api<{ jobId: number; sortOrder: number }>(`/batches/${id}/jobs/${jobId}/reroll`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      setRerollMsg(`已追加 #${r.sortOrder}`)
      void qc.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e) => {
      // api() 抛的是响应原文,可能是 {"error":"..."} JSON,取其中文案
      const raw = e instanceof Error ? e.message : ''
      try {
        setRerollMsg((JSON.parse(raw) as { error?: string }).error ?? '重roll失败')
      } catch {
        setRerollMsg(raw || '重roll失败')
      }
    },
  })

  if (!data) return null
  const { batch, template, jobs } = data
  const done = jobs.filter((j) => ['succeeded', 'failed', 'canceled'].includes(j.status)).length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const gallery = jobs.filter((j) => j.status === 'succeeded').flatMap((j) => (j.outputs ?? []).map((o) => ({ job: j, output: o })))
  const hasSeed = template.params.some((p) => p.type === 'seed')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={data.nav.prevId === null}
              onClick={() => navigate(`/batches/${data.nav.prevId}`)}
            >
              ← 更早
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.nav.nextId === null}
              onClick={() => navigate(`/batches/${data.nav.nextId}`)}
            >
              更新 →
            </Button>
          </span>
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
            <Link to={`/batches/new?from=${batch.id}`}>以此新建</Link>
          </Button>
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
          <h2 className="mb-3 font-medium">
            结果画廊（{gallery.length}）
            {rerollMsg && <span className="ml-2 text-xs text-muted-foreground">{rerollMsg}</span>}
          </h2>
          <div className="grid grid-cols-4 gap-4">
            {gallery.map(({ job, output }, i) => (
              <div key={output.path} className="group relative space-y-1">
                <button
                  type="button"
                  onClick={() => setLightbox(i)}
                  className="w-full space-y-1 text-left"
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
                </button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute top-1 right-1 hidden h-7 px-2 group-hover:flex disabled:pointer-events-auto"
                  disabled={!hasSeed || reroll.isPending}
                  title={hasSeed ? '重roll:同参数换随机 seed 追加一张' : '模板没有 seed 参数'}
                  onClick={() => reroll.mutate(job.id)}
                >
                  <DicesIcon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {lightbox !== null && (
        <Lightbox
          items={gallery}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
          hasSeed={hasSeed}
          rerollPending={reroll.isPending}
          onReroll={(jobId) => reroll.mutate(jobId)}
        />
      )}
    </div>
  )
}

function Lightbox({
  items,
  index,
  onClose,
  onIndex,
  hasSeed,
  rerollPending,
  onReroll,
}: {
  items: Array<{ job: JobDto; output: { path: string; filename: string } }>
  index: number
  onClose: () => void
  onIndex: (i: number) => void
  hasSeed: boolean
  rerollPending: boolean
  onReroll: (jobId: number) => void
}) {
  const cur = items[index]
  if (!cur) return null
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="sm:max-w-4xl"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
          if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1)
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-normal text-muted-foreground">
            {index + 1} / {items.length} · #{cur.job.sortOrder} · {cur.output.filename}
          </DialogTitle>
        </DialogHeader>
        <img
          src={outputUrl(cur.output.path)}
          alt={cur.output.filename}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
        <p className="max-h-20 overflow-y-auto font-mono text-xs text-muted-foreground">
          {JSON.stringify(cur.job.params)}
        </p>
        <DialogFooter className="sm:justify-between">
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={index === 0} onClick={() => onIndex(index - 1)}>
              ←
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={index === items.length - 1}
              onClick={() => onIndex(index + 1)}
            >
              →
            </Button>
          </span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="disabled:pointer-events-auto"
              disabled={!hasSeed || rerollPending}
              title={hasSeed ? '同参数换随机 seed 追加一张' : '模板没有 seed 参数'}
              onClick={() => onReroll(cur.job.id)}
            >
              <DicesIcon className="size-4" />
              重roll
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={outputUrl(cur.output.path)} target="_blank" rel="noreferrer">
                查看原图
              </a>
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
