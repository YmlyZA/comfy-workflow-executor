import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { fetchHosts, getToken, type HostDto } from '@/lib/api'

/**
 * 全站主机列表(含在线态)。
 *
 * 单一数据源:列表本身带 online,SSE 的 comfy-status 按 hostId 局部改写其中一项。
 * 不另存一份在线映射——两份缓存必然会有对不齐的时候。
 */
export function useHosts(): HostDto[] | undefined {
  const { data } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
    staleTime: Infinity,
    refetchInterval: 60_000, // SSE 断线兜底
  })
  return data?.hosts
}

/** 只在常驻组件(HostStatus)挂一次:独占一条 SSE,把主机相关事件写回查询缓存 */
export function useHostFeed(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)

    es.addEventListener('comfy-status', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { online: boolean; hostId: number }
      qc.setQueryData<{ hosts: HostDto[] }>(['hosts'], (prev) =>
        prev
          ? { hosts: prev.hosts.map((h) => (h.id === d.hostId ? { ...h, online: d.online } : h)) }
          : prev,
      )
      // 主机或在线状态变化 → cwe 扩展安装状态需重探(不同主机装没装扩展不同)
      void qc.invalidateQueries({ queryKey: ['cwe-status'] })
    })

    es.addEventListener('host-disabled', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { hostName: string | null; reason: string | null }
      toast.error(`主机「${d.hostName ?? '未知'}」已自动停用调度`, { description: d.reason ?? undefined })
      void qc.invalidateQueries({ queryKey: ['hosts'] })
    })

    es.addEventListener('host-idle', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { hostName: string | null; idleMinutes: number }
      toast.warning(`租用主机「${d.hostName ?? '未知'}」已空闲 ${d.idleMinutes} 分钟`, {
        description: '仍在计费中，考虑下线',
      })
    })

    es.onerror = () => console.warn('SSE connection error — browser will retry')
    return () => es.close()
  }, [qc])
}
