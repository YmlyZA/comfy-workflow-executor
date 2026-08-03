import { Link } from 'react-router-dom'
import { useComfyStatus, useComfyStatusFeed } from '@/hooks/use-comfy-status'
import { cn } from '@/lib/utils'

/** Header 常驻:在线状态点+当前主机名,点击进主机管理页 */
export function HostStatus() {
  useComfyStatusFeed()
  const status = useComfyStatus()
  const color =
    status == null ? 'bg-muted-foreground' : status.online ? 'bg-success' : 'bg-destructive'
  const title = status == null ? '探测中' : status.online ? '在线' : '离线'
  return (
    <Link
      to="/hosts"
      className="flex items-center gap-2 text-sm hover:underline"
      title={`GPU 主机:${title}`}
    >
      <span className={cn('inline-block size-2.5 rounded-full', color)} />
      <span className="text-muted-foreground">{status?.hostName ?? 'GPU 主机'}</span>
    </Link>
  )
}
