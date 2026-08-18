const TOKEN_KEY = 'cwe_token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
    ...(init.headers as Record<string, string>),
  }
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`/api${path}`, { ...init, headers })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(parseApiError(await res.text()))
  return res.json() as Promise<T>
}

/** 服务端错误响应体是 {error} JSON;提取文案,非 JSON 原样返回 */
function parseApiError(text: string): string {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text
  } catch {
    return text
  }
}

/** 统一错误文案:api() 已解析过的直接取 message,其他兜底 */
export function errorMessage(e: unknown, fallback = '操作失败'): string {
  if (!(e instanceof Error) || !e.message) return fallback
  return parseApiError(e.message)
}

/** <img>/<a> 无法带 header，用 query token */
export function outputUrl(path: string): string {
  return `/api/outputs/${path}?token=${encodeURIComponent(getToken())}`
}

export function downloadUrl(batchId: number): string {
  return `/api/batches/${batchId}/download?token=${encodeURIComponent(getToken())}`
}

export function uploadFileUrl(name: string): string {
  return `/api/uploads/${encodeURIComponent(name)}?token=${encodeURIComponent(getToken())}`
}

export function comfyInputFileUrl(name: string): string {
  return `/api/comfy/input-image?name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken())}`
}

export function thumbUrl(source: 'uploads' | 'comfy', name: string): string {
  return `/api/thumbs?source=${source}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken())}`
}

export function promptsExportUrl(): string {
  return `/api/prompts/export?token=${encodeURIComponent(getToken())}`
}

export function backupExportUrl(): string {
  return `/api/export?token=${encodeURIComponent(getToken())}`
}

/** 导入备份 zip:raw body 上传(不 multipart),后端整体替换数据 */
export async function importBackup(file: File): Promise<void> {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/zip' },
    body: file,
  })
  if (!res.ok) throw new Error(parseApiError(await res.text()))
}

/** GPU 主机管理接口类型与函数 */

export interface HostDto {
  id: number
  name: string
  url: string
  note: string | null
  /** 参考主机(只服务查询),不再决定谁干活 */
  active: number
  /** 参与调度:为 1 才会起 worker */
  enabled: number
  kind: 'resident' | 'rental'
  rentedAt: string | null
  hourlyRate: number | null
  /** 自动停用原因(熔断) */
  disabledReason: string | null
  /** 来自服务端 monitor 缓存;null = 尚未探测过 */
  online: boolean | null
  /** 锁定到该主机的未完成批次数 */
  pinnedBatches: number
  createdAt: string
}

export interface HostTestResult {
  reachable: boolean
  latencyMs?: number
  cwe?: boolean
  gpuName?: string | null
  vramTotalMB?: number | null
}

export interface HostStatsDto {
  online: boolean
  gpuName?: string | null
  vramTotalMB?: number | null
  vramFreeMB?: number | null
  comfyuiVersion?: string | null
  pythonVersion?: string | null
  os?: string | null
  queueRunning?: number
  queuePending?: number
  cwe?: boolean
}

export interface HealthDto {
  ok: boolean
  comfy: boolean
  host: { id: number; name: string } | null
}

export const fetchHosts = () => api<{ hosts: HostDto[] }>('/hosts')

export interface HostWritable {
  name: string
  url: string
  note?: string | null
  kind?: 'resident' | 'rental'
  rentedAt?: string | null
  hourlyRate?: number | null
}

export const createHost = (input: HostWritable) =>
  api<{ host: HostDto }>('/hosts', { method: 'POST', body: JSON.stringify(input) })

/** note 传 null 表示清空备注(传 undefined 会被 JSON 丢键,服务端保留原值) */
export const updateHost = (id: number, patch: Partial<HostWritable> & { enabled?: true }) =>
  api<{ host: HostDto }>(`/hosts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })

export const deleteHost = (id: number) => api<{ ok: true }>(`/hosts/${id}`, { method: 'DELETE' })

/** 设为参考主机。不影响任何 worker,故无需模式选择 */
export const activateHost = (id: number) =>
  api<{ host: HostDto }>(`/hosts/${id}/activate`, { method: 'POST' })

/** 停用调度。wait=等当前任务跑完;interrupt=放弃并重排到其他主机 */
export const disableHost = (id: number, mode: 'wait' | 'interrupt') =>
  api<{ host: HostDto }>(`/hosts/${id}/disable`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })

export const enableHost = (id: number) => updateHost(id, { enabled: true })

export const fetchHostStatsById = (id: number) => api<HostStatsDto>(`/hosts/${id}/stats`)

export const testHost = (id: number) =>
  api<HostTestResult>(`/hosts/${id}/test`, { method: 'POST', body: JSON.stringify({}) })

export const fetchHostStats = () => api<HostStatsDto>('/hosts/current/stats')

export const fetchHealth = () => api<HealthDto>('/health')

/** 存储维护接口类型与函数 */

export interface MaintenanceSummary {
  bak: { count: number; bytes: number }
  thumbs: { count: number; bytes: number }
  orphanOutputs: { count: number; bytes: number }
}

export interface GpuOrphan {
  filename: string
  subfolder: string
  size: number
  mtime: number
}

export type MaintenanceTarget = 'bak' | 'thumbs' | 'orphan-outputs'

export const fetchMaintenanceSummary = () => api<MaintenanceSummary>('/maintenance/summary')

export const cleanMaintenance = (targets: MaintenanceTarget[]) =>
  api<{ results: Record<string, { freedBytes: number; failed: string[] }>}>('/maintenance/clean', {
    method: 'POST',
    body: JSON.stringify({ targets }),
  })

export const fetchGpuOrphans = (hostId?: number) =>
  api<{ host: { id: number; name: string }; orphans: GpuOrphan[]; totalBytes: number }>(
    `/maintenance/gpu-orphans${hostId !== undefined ? `?hostId=${hostId}` : ''}`,
  )

export const cleanGpuOrphans = (
  hostId: number,
  files: Array<{ filename: string; subfolder: string }>,
) =>
  api<{ deleted: number; missing: number; failed: string[]; skippedReferenced?: number }>(
    '/maintenance/gpu-clean',
    {
      method: 'POST',
      body: JSON.stringify({ hostId, files }),
    },
  )

export function comfyOutputThumbUrl(hostId: number, name: string): string {
  return `/api/thumbs?source=comfy-output&hostId=${hostId}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken())}`
}
