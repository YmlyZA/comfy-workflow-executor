import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** GPU 主机 input 目录文件清单;离线时 isError,调用方隐藏该组 */
export function useComfyInputFiles() {
  return useQuery({
    queryKey: ['comfy-input-files'],
    queryFn: () => api<{ files: string[] }>('/comfy/input-files'),
    staleTime: 30_000,
    retry: false,
  })
}
