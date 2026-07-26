import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** cwe 扩展探测:未装/离线 installed:false,GPU 清理勾选框据此禁用 */
export function useCweStatus() {
  return useQuery({
    queryKey: ['cwe-status'],
    queryFn: () => api<{ installed: boolean }>('/comfy/cwe-status'),
    staleTime: 30_000,
    retry: false,
  })
}
