import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DicesIcon } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { BatchStatus, JobStatus, ParamDef, ParamValues } from '@cwe/shared'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
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
import { ImageCompare } from '@/components/image-compare'
import { OfflineBanner } from '@/components/offline-banner'
import { useEvents } from '@/hooks/use-events'
import { api, comfyInputFileUrl, downloadUrl, errorMessage, outputUrl, uploadFileUrl } from '@/lib/api'
import { imageParamsOf, imageParamValue } from '@/lib/image-params'
import { StatusBadge } from '@/pages/batches'
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
  hostId: number | null
}

export interface BatchDetailDto {
  batch: { id: number; name: string; status: BatchStatus; createdAt: string }
  template: TemplateDto
  jobs: JobDto[]
  nav: { prevId: number | null; nextId: number | null }
  hostNames: Record<number, string>
}

export default function BatchDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [lightbox, setLightbox] = useState<number | null>(null)
  const qc = useQueryClient()
  const progress = useEvents()
  const { data, isPending, error } = useQuery({
    queryKey: ['batches', id],
    queryFn: () => api<BatchDetailDto>(`/batches/${id}`),
    // 404(batch 不存在)没有重试的意义;禁用默认的 3 次退避重试,失败即刻显示错误态
    retry: false,
  })

  const act = useMutation({
    mutationFn: (action: 'cancel' | 'retry-failed') =>
      api(`/batches/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['batches'] })
    },
    // 竞态兜底:点击瞬间 batch 已结束会收到 409,提示并刷新到真实状态
    onError: (e) => {
      toast.error(errorMessage(e))
      void qc.invalidateQueries({ queryKey: ['batches'] })
    },
  })

  const reroll = useMutation({
    mutationFn: (jobId: number) =>
      api<{ jobId: number; sortOrder: number }>(`/batches/${id}/jobs/${jobId}/reroll`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      toast.success(`已追加 #${r.sortOrder}`)
      void qc.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e) => toast.error(errorMessage(e, '重roll失败')),
  })

  if (isPending)
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-2 w-full" />
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square w-full" />
          ))}
        </div>
      </div>
    )
  if (error || !data)
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">
          加载失败：{errorMessage(error, 'batch 不存在或已删除')}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/batches">返回列表</Link>
        </Button>
      </div>
    )
  const { batch, template, jobs } = data
  const done = jobs.filter((j) => ['succeeded', 'failed', 'canceled'].includes(j.status)).length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const gallery = jobs.filter((j) => j.status === 'succeeded').flatMap((j) => (j.outputs ?? []).map((o) => ({ job: j, output: o })))
  const hasSeed = template.params.some((p) => p.type === 'seed')

  return (
    <div className="space-y-6">
      {/* 小屏固定分行(导航/名称+状态/模板/操作),避免 flex-wrap 随名字长短产生机型间不一致的断行 */}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div className="flex flex-col gap-1.5 md:min-w-0 md:flex-row md:flex-wrap md:items-center md:gap-x-3 md:gap-y-1">
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
          <span className="flex min-w-0 items-center gap-2 md:gap-3">
            <h1 className="min-w-0 truncate text-xl font-semibold">{batch.name}</h1>
            <StatusBadge status={batch.status} />
          </span>
          <span className="truncate text-sm text-muted-foreground">模板：{template.name}</span>
        </div>
        <div className="flex flex-wrap gap-2">
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

      <OfflineBanner hasActiveWork={['pending', 'running'].includes(batch.status)} />

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
            <TableHead>主机</TableHead>
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
                <StatusBadge status={j.status} />
                {j.status === 'running' && progress[j.id] && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {progress[j.id]!.value}/{progress[j.id]!.max}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {j.hostId != null ? (data.hostNames[j.hostId] ?? '已删除主机') : '—'}
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
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
                    className="aspect-square w-full rounded-md border object-cover opacity-0 transition-[opacity,transform,box-shadow] duration-250 group-hover:scale-[1.02] group-hover:shadow-md"
                    onLoad={(e) => {
                      ;(e.target as HTMLImageElement).classList.remove('opacity-0')
                    }}
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
          imageParamDefs={template.params.filter((p) => p.type === 'image')}
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
  imageParamDefs,
}: {
  items: Array<{ job: JobDto; output: { path: string; filename: string } }>
  index: number
  onClose: () => void
  onIndex: (i: number) => void
  hasSeed: boolean
  rerollPending: boolean
  onReroll: (jobId: number) => void
  imageParamDefs: ParamDef[]
}) {
  const [compare, setCompare] = useState(false)
  const [compareKey, setCompareKey] = useState<string | null>(null)
  // 非对比模式的横向快滑翻页;对比模式下由 ImageCompare 接管指针,天然互斥
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const cur = items[index]
  const imgParams = cur ? imageParamsOf(imageParamDefs, cur.job.params) : []
  const hasCompare = imgParams.length > 0
  // 翻页:重置参数选择;翻到无 image 输入的 job 自动退出对比模式
  useEffect(() => {
    setCompareKey(null)
    if (!hasCompare) setCompare(false)
  }, [index, hasCompare])
  if (!cur) return null
  const activeDef = imgParams.find((p) => p.key === compareKey) ?? imgParams[0]
  const comparing = compare && activeDef !== undefined
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
        {comparing ? (
          <ImageCompare
            key={`${cur.job.id}:${activeDef.key}`}
            beforeCandidates={[
              uploadFileUrl(imageParamValue(activeDef, cur.job.params)),
              comfyInputFileUrl(imageParamValue(activeDef, cur.job.params)),
            ]}
            afterSrc={outputUrl(cur.output.path)}
            afterAlt={cur.output.filename}
          />
        ) : (
          <img
            src={outputUrl(cur.output.path)}
            alt={cur.output.filename}
            draggable={false}
            className="max-h-[70vh] w-full touch-pan-y rounded-md object-contain select-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              swipeStart.current = { x: e.clientX, y: e.clientY }
            }}
            onPointerUp={(e) => {
              const s = swipeStart.current
              swipeStart.current = null
              if (!s) return
              const dx = e.clientX - s.x
              const dy = e.clientY - s.y
              if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return
              if (dx > 0 && index > 0) onIndex(index - 1)
              if (dx < 0 && index < items.length - 1) onIndex(index + 1)
            }}
          />
        )}
        {comparing && imgParams.length > 1 && (
          <span className="flex flex-wrap gap-1">
            {imgParams.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={p.key === activeDef.key ? 'secondary' : 'ghost'}
                onClick={() => setCompareKey(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </span>
        )}
        <p className="max-h-20 overflow-y-auto font-mono text-xs text-muted-foreground">
          {JSON.stringify(cur.job.params)}
        </p>
        <DialogFooter className="sm:justify-between">
          <span className="flex flex-wrap gap-2">
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
            {hasCompare && (
              <Button
                size="sm"
                variant={compare ? 'secondary' : 'outline'}
                onClick={() => setCompare((v) => !v)}
              >
                对比原图
              </Button>
            )}
          </span>
          <span className="flex flex-wrap gap-2">
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
