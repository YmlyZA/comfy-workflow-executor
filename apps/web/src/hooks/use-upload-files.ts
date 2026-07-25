import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** 服务端 uploads 目录清单(最近上传在前) */
export function useUploadFiles() {
  return useQuery({
    queryKey: ['upload-files'],
    queryFn: () => api<{ files: string[] }>('/uploads'),
    staleTime: 30_000,
    retry: false,
  })
}
