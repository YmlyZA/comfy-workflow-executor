import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { useComfyStatus, useComfyStatusFeed } from '@/hooks/use-comfy-status'
import { fetchHostStats } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Header 常驻:在线状态点+当前主机名;hover 出详情卡,点击进主机管理页 */
export function HostStatus() {
  useComfyStatusFeed()
  const status = useComfyStatus()
  const [open, setOpen] = useState(false)
  // 离线→在线翻转的一瞬,绿灯外圈 ping 一次(600ms 后移除)
  const [justOnline, setJustOnline] = useState(false)
  const prevOnline = useRef<boolean | null>(null)
  useEffect(() => {
    if (prevOnline.current === false && status?.online) {
      setJustOnline(true)
      const t = setTimeout(() => setJustOnline(false), 600)
      return () => clearTimeout(t)
    }
    prevOnline.current = status?.online ?? null
  }, [status?.online])
  useEffect(() => {
    prevOnline.current = status?.online ?? null
  })

  const color =
    status == null
      ? 'bg-muted-foreground'
      : status.online
        ? 'bg-success'
        : 'bg-destructive animate-pulse'

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to="/hosts" className="flex items-center gap-2 text-sm">
          <span className="relative flex size-2.5">
            {justOnline && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
            )}
            <span className={cn('relative inline-flex size-2.5 rounded-full', color)} />
          </span>
          <span className="text-muted-foreground transition-colors duration-150 hover:text-foreground">
            {status?.hostName ?? 'GPU 主机'}
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="end">
        <HostStatsCard enabled={open} online={status?.online ?? null} />
      </HoverCardContent>
    </HoverCard>
  )
}

function HostStatsCard({ enabled, online }: { enabled: boolean; online: boolean | null }) {
  const { data, isError } = useQuery({
    queryKey: ['host-stats'],
    queryFn: fetchHostStats,
    enabled,
    staleTime: 30_000,
  })
  if (online === false || isError || data?.online === false)
    return <p className="text-sm text-muted-foreground">主机离线或不可达</p>
  if (!data) return <p className="text-sm text-muted-foreground">加载中…</p>
  const used =
    data.vramTotalMB != null && data.vramFreeMB != null ? data.vramTotalMB - data.vramFreeMB : null
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{data.gpuName ?? '未知 GPU'}</p>
      {used != null && data.vramTotalMB != null && (
        <div className="space-y-1">
          <Progress value={(used / data.vramTotalMB) * 100} />
          <p className="text-xs text-muted-foreground">
            显存 {(used / 1024).toFixed(1)} / {(data.vramTotalMB / 1024).toFixed(1)} GB
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        ComfyUI {data.comfyuiVersion ?? '?'} · 队列 {data.queueRunning ?? 0} 跑 /{' '}
        {data.queuePending ?? 0} 等 · cwe {data.cwe ? '✓' : '✗'}
      </p>
    </div>
  )
}
