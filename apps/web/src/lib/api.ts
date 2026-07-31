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
  if (!res.ok) throw new Error(await res.text())
  return res.json() as Promise<T>
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
  if (!res.ok) throw new Error(await res.text())
}

/** GPU 主机管理接口类型与函数 */

export interface HostDto {
  id: number
  name: string
  url: string
  note: string | null
  active: number
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

export const createHost = (input: { name: string; url: string; note?: string }) =>
  api<{ host: HostDto }>('/hosts', { method: 'POST', body: JSON.stringify(input) })

export const updateHost = (id: number, patch: { name?: string; url?: string; note?: string }) =>
  api<{ host: HostDto }>(`/hosts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })

export const deleteHost = (id: number) => api<{ ok: true }>(`/hosts/${id}`, { method: 'DELETE' })

export const activateHost = (id: number, mode: 'wait' | 'interrupt') =>
  api<{ host: HostDto }>(`/hosts/${id}/activate`, { method: 'POST', body: JSON.stringify({ mode }) })

export const testHost = (id: number) =>
  api<HostTestResult>(`/hosts/${id}/test`, { method: 'POST', body: JSON.stringify({}) })

export const fetchHostStats = () => api<HostStatsDto>('/hosts/current/stats')

export const fetchHealth = () => api<HealthDto>('/health')
