import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { useHostFeed, useHosts } from '@/hooks/use-comfy-status'
import { fetchHostStats, type HostDto } from '@/lib/api'
import { onlineSummary, referenceHost } from '@/lib/hosts'
import { cn } from '@/lib/utils'
import { useState } from 'react'

/** Header 常驻:参与调度主机的在线聚合;hover 出逐台清单与参考主机详情,点击进主机管理页 */
export function HostStatus() {
  useHostFeed()
  const hosts = useHosts()
  const [open, setOpen] = useState(false)

  const summary = hosts ? onlineSummary(hosts) : null
  // 判断启用主机的探测状态:全未探测->未知; 已探测->按真实情况分类
  const enabledHosts = hosts?.filter((h) => h.enabled === 1) ?? []
  const allUnprobed = enabledHosts.length > 0 && enabledHosts.every((h) => h.online === null)
  const onlineCount = enabledHosts.filter((h) => h.online === true).length

  const color =
    summary == null
      ? 'bg-muted-foreground'
      : allUnprobed
        ? 'bg-muted-foreground'
        : onlineCount === enabledHosts.length
          ? 'bg-success'
          : onlineCount > 0
            ? 'bg-warning'
            : 'bg-destructive animate-pulse'

  const label = allUnprobed ? '尚未连接' : summary ? `${summary.online}/${summary.total} 台在线` : 'GPU 主机'

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to="/hosts" className="flex items-center gap-2 text-sm">
          <span className={cn('inline-flex size-2.5 rounded-full', color)} />
          <span className="text-muted-foreground transition-colors duration-150 hover:text-foreground">
            {label}
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72">
        <HostList hosts={hosts} open={open} />
      </HoverCardContent>
    </HoverCard>
  )
}

function HostList({ hosts, open }: { hosts: HostDto[] | undefined; open: boolean }) {
  const reference = hosts ? referenceHost(hosts) : undefined
  if (!hosts) return <p className="text-sm text-muted-foreground">加载中…</p>
  if (hosts.length === 0) return <p className="text-sm text-muted-foreground">尚未添加主机</p>
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {hosts.map((h) => (
          <li key={h.id} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'inline-flex size-2 shrink-0 rounded-full',
                h.online === true ? 'bg-success' : h.online === false ? 'bg-destructive' : 'bg-muted-foreground',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{h.name}</span>
            {h.active === 1 && <span className="text-xs text-muted-foreground">参考</span>}
            {h.enabled !== 1 && <span className="text-xs text-muted-foreground">未调度</span>}
          </li>
        ))}
      </ul>
      {reference && (
        <div className="border-t pt-2">
          <ReferenceStats enabled={open} online={reference.online} />
        </div>
      )}
    </div>
  )
}

/** 参考主机的详情:显存/队列/扩展 */
function ReferenceStats({ enabled, online }: { enabled: boolean; online: boolean | null }) {
  const { data, isError } = useQuery({
    queryKey: ['host-stats'],
    queryFn: fetchHostStats,
    enabled,
    staleTime: 30_000,
  })
  if (online === false || isError || data?.online === false)
    return <p className="text-sm text-muted-foreground">参考主机离线或不可达</p>
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
