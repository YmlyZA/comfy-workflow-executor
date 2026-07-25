import { useQuery } from '@tanstack/react-query'
import type { ParamDef } from '@cwe/shared'
import { api } from '@/lib/api'

/** enum 参数的实时可选值;非 enum 或离线时 query 不启用/报错,由调用方降级 */
export function useInputOptions(param: ParamDef) {
  const ref = param.enumRef
  return useQuery({
    queryKey: ['input-options', ref?.classType, ref?.inputName],
    enabled: param.type === 'enum' && !!ref,
    queryFn: () =>
      api<{ options: string[] }>(
        `/comfy/input-options?classType=${encodeURIComponent(ref!.classType)}&inputName=${encodeURIComponent(ref!.inputName)}`,
      ),
    staleTime: 60_000,
    retry: false,
  })
}
