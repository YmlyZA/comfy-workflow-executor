import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { fetchHealth, getToken } from '@/lib/api'

export interface ComfyStatus {
  online: boolean
  hostId: number | null
  hostName: string | null
}

/** 全局在线状态:读共享查询缓存;初始来自 /health,SSE 翻转由 useComfyStatusFeed 写入 */
export function useComfyStatus(): ComfyStatus | undefined {
  const { data } = useQuery({
    queryKey: ['comfy-status'],
    queryFn: async (): Promise<ComfyStatus> => {
      const h = await fetchHealth()
      return { online: h.comfy, hostId: h.host?.id ?? null, hostName: h.host?.name ?? null }
    },
    staleTime: Infinity,
    refetchInterval: 60_000, // SSE 断线兜底
  })
  return data
}

/** 只在常驻组件(HostStatus)挂一次:独占一条 SSE,把 comfy-status 写入查询缓存供全站读 */
export function useComfyStatusFeed(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)
    es.addEventListener('comfy-status', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as {
        online: boolean
        hostId: number | null
        hostName: string | null
      }
      qc.setQueryData<ComfyStatus>(['comfy-status'], {
        online: d.online,
        hostId: d.hostId,
        hostName: d.hostName,
      })
      // 主机或在线状态变化 → cwe 扩展安装状态需重探(不同主机装没装扩展不同)
      void qc.invalidateQueries({ queryKey: ['cwe-status'] })
    })
    es.onerror = () => console.warn('SSE connection error — browser will retry')
    return () => es.close()
  }, [qc])
}
