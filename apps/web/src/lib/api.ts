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
