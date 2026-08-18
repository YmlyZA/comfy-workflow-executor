import { Link } from 'react-router-dom'
import { useHosts } from '@/hooks/use-comfy-status'
import { hasUsableHost } from '@/lib/hosts'

/** 没有任何「参与调度且在线」的主机、且页面存在未完成任务时的提示横幅 */
export function OfflineBanner({ hasActiveWork }: { hasActiveWork: boolean }) {
  const hosts = useHosts()
  if (!hosts || !hasActiveWork || hasUsableHost(hosts)) return null
  const noneConfigured = hosts.length === 0
  const allDisabled = hosts.length > 0 && hosts.every((h) => h.enabled !== 1)
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
      {noneConfigured ? (
        <>
          尚未配置任何 GPU 主机。
          <Link to="/hosts" className="ml-1 underline">
            前往配置
          </Link>
        </>
      ) : allDisabled ? (
        <>
          所有主机均已停用调度，任务无人执行。
          <Link to="/hosts" className="ml-1 underline">
            前往主机管理
          </Link>
        </>
      ) : (
        '当前没有在线的调度主机，任务将在主机恢复后自动继续。'
      )}
    </div>
  )
}
