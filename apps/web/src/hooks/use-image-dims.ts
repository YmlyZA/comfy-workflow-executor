import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** 图片尺寸探测(uploads 本地或 GPU 侧);name 为空不请求,按文件名缓存 5 分钟 */
export function useImageDims(name: string | undefined) {
  return useQuery({
    queryKey: ['image-dims', name],
    enabled: !!name,
    queryFn: () =>
      api<{ width: number; height: number }>(`/comfy/image-dims?name=${encodeURIComponent(name!)}`),
    staleTime: 5 * 60_000,
    retry: false,
  })
}
