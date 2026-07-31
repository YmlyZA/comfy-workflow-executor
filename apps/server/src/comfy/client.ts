import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket from 'ws'

export interface OutputRef {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyHistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] }
  outputs?: Record<string, Record<string, unknown>>
}

export interface ComfyWsEvent {
  type: string
  data?: any
}

export interface SystemStats {
  system?: { os?: string; comfyui_version?: string; python_version?: string }
  devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>
}

/** GET /object_info 返回的节点定义(仅声明本项目用到的 input 部分) */
export type ObjectInfoMap = Record<
  string,
  { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }
>

export interface ComfyClient {
  isUp(): Promise<boolean>
  interrupt(): Promise<void>
  uploadImage(filePath: string): Promise<string>
  submit(prompt: Record<string, any>, clientId: string): Promise<string>
  getHistory(promptId: string): Promise<ComfyHistoryEntry | null>
  /** prompt ids currently queued or executing */
  getQueuedIds(): Promise<Set<string>>
  downloadOutput(ref: OutputRef, destPath: string): Promise<void>
  /** 全量节点定义,体积较大,调用方应走 ObjectInfoCache */
  getObjectInfo(): Promise<ObjectInfoMap>
  /** 拉取 ComfyUI input 目录图片字节;404 返回 null。name 支持 sub/name.png 子目录写法 */
  getInputImage(name: string): Promise<ArrayBuffer | null>
  /** cwe 扩展是否安装(GET /cwe/ping);离线/404/异常均 false */
  cwePing(): Promise<boolean>
  /** 删除 GPU 侧 output 文件;扩展缺失/离线抛错,由调用方兜 gpuPurgeFailed */
  cweDeleteOutputFiles(
    refs: Array<{ filename: string; subfolder: string }>,
  ): Promise<{ deleted: number; missing: number; failed: string[] }>
  /** 返回断开函数。连接失败时静默重试由调用方负责。 */
  connectEvents(clientId: string, onEvent: (e: ComfyWsEvent) => void): () => void
  /** 系统统计信息:OS/ComfyUI 版本/设备(GPU)状态 */
  getSystemStats(): Promise<SystemStats>
  /** 当前队列计数(running/pending) */
  getQueueCounts(): Promise<{ running: number; pending: number }>
}

export function extractOutputRefs(entry: ComfyHistoryEntry): OutputRef[] {
  const refs: OutputRef[] = []
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as any).filename === 'string' &&
          (item as any).type === 'output'
        ) {
          refs.push({
            filename: (item as any).filename,
            subfolder: (item as any).subfolder ?? '',
            type: (item as any).type,
          })
        }
      }
    }
  }
  return refs
}

export function createComfyClient(baseUrl: string): ComfyClient {
  const http = baseUrl
  const ws = baseUrl.replace(/^http/, 'ws')

  return {
    async isUp() {
      try {
        const res = await fetch(`${http}/system_stats`, { signal: AbortSignal.timeout(3000) })
        return res.ok
      } catch {
        return false
      }
    },

    async interrupt() {
      await fetch(`${http}/interrupt`, { method: 'POST' })
    },

    async uploadImage(filePath: string) {
      const form = new FormData()
      form.append('image', new Blob([await readFile(filePath)]), basename(filePath))
      form.append('overwrite', 'true')
      const res = await fetch(`${http}/upload/image`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload/image failed: ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { name: string; subfolder?: string }
      return body.subfolder ? `${body.subfolder}/${body.name}` : body.name
    },

    async submit(prompt, clientId) {
      const res = await fetch(`${http}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: clientId }),
      })
      if (!res.ok) throw new Error(`comfyui rejected prompt: ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { prompt_id: string }
      return body.prompt_id
    },

    async getHistory(promptId) {
      const res = await fetch(`${http}/history/${promptId}`)
      if (!res.ok) throw new Error(`history failed: ${res.status}`)
      const body = (await res.json()) as Record<string, ComfyHistoryEntry>
      return body[promptId] ?? null
    },

    async getQueuedIds() {
      const res = await fetch(`${http}/queue`)
      if (!res.ok) throw new Error(`queue failed: ${res.status}`)
      const body = (await res.json()) as {
        queue_running: Array<[number, string, ...unknown[]]>
        queue_pending: Array<[number, string, ...unknown[]]>
      }
      const ids = new Set<string>()
      for (const entry of body.queue_running ?? []) ids.add(entry[1])
      for (const entry of body.queue_pending ?? []) ids.add(entry[1])
      return ids
    },

    async getObjectInfo() {
      const res = await fetch(`${http}/object_info`)
      if (!res.ok) throw new Error(`object_info failed: ${res.status}`)
      return (await res.json()) as ObjectInfoMap
    },

    async getInputImage(name) {
      const idx = name.lastIndexOf('/')
      const qs = new URLSearchParams({
        filename: idx >= 0 ? name.slice(idx + 1) : name,
        subfolder: idx >= 0 ? name.slice(0, idx) : '',
        type: 'input',
      })
      const res = await fetch(`${http}/view?${qs}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`view failed: ${res.status}`)
      return res.arrayBuffer()
    },

    async downloadOutput(ref, destPath) {
      const qs = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder,
        type: ref.type,
      })
      const res = await fetch(`${http}/view?${qs}`)
      if (!res.ok || !res.body) throw new Error(`view failed: ${res.status}`)
      try {
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath))
      } catch (err) {
        await rm(destPath, { force: true })
        throw err
      }
    },

    async cwePing() {
      try {
        const res = await fetch(`${http}/cwe/ping`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) return false
        const body = (await res.json()) as { ok?: boolean }
        return body.ok === true
      } catch {
        return false
      }
    },

    async cweDeleteOutputFiles(refs) {
      const res = await fetch(`${http}/cwe/delete-output-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: refs }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`cwe delete failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as { deleted: number; missing: number; failed: string[] }
    },

    connectEvents(clientId, onEvent) {
      let closed = false
      let socket: WebSocket | null = null
      const connect = () => {
        if (closed) return
        socket = new WebSocket(`${ws}/ws?clientId=${clientId}`)
        socket.on('message', (raw, isBinary) => {
          if (isBinary) return // 忽略 preview 二进制帧
          try {
            onEvent(JSON.parse(raw.toString()))
          } catch {
            /* 忽略无法解析的帧 */
          }
        })
        const retry = () => {
          if (!closed) setTimeout(connect, 5000)
        }
        socket.on('close', retry)
        socket.on('error', () => socket?.close())
      }
      connect()
      return () => {
        closed = true
        socket?.close()
      }
    },

    async getSystemStats() {
      const res = await fetch(`${http}/system_stats`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`system_stats failed: ${res.status}`)
      return (await res.json()) as SystemStats
    },

    async getQueueCounts() {
      const res = await fetch(`${http}/queue`)
      if (!res.ok) throw new Error(`queue failed: ${res.status}`)
      const body = (await res.json()) as {
        queue_running: unknown[]
        queue_pending: unknown[]
      }
      return { running: body.queue_running?.length ?? 0, pending: body.queue_pending?.length ?? 0 }
    },
  }
}
