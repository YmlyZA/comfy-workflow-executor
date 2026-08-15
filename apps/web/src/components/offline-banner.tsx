import { useHosts } from '@/hooks/use-comfy-status'
import { hasUsableHost } from '@/lib/hosts'

/** 无可用主机且页面存在未完成任务时的提示横幅(executor 本就离线等待,这里只是可视化) */
export function OfflineBanner({ hasActiveWork }: { hasActiveWork: boolean }) {
  const hosts = useHosts()
  if (!hosts || hasUsableHost(hosts) || !hasActiveWork) return null
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
      GPU 主机离线，任务将在主机恢复后自动继续。
    </div>
  )
}
