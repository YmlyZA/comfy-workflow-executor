import { useComfyStatus } from '@/hooks/use-comfy-status'

/** 主机离线且页面存在未完成任务时的提示横幅(executor 本就离线等待,这里只是可视化) */
export function OfflineBanner({ hasActiveWork }: { hasActiveWork: boolean }) {
  const status = useComfyStatus()
  if (!status || status.online || !hasActiveWork) return null
  return (
    <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 px-4 py-2 text-sm">
      GPU 主机离线，任务将在主机恢复后自动继续。
    </div>
  )
}
