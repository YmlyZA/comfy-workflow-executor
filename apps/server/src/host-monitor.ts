import type { EventEmitter } from 'node:events'
import type { ComfyClient } from './comfy/client.js'
import type { Db } from './db/index.js'
import { listHosts } from './db/repo.js'

export interface HostMonitor {
  stop(): void
  /** 各主机最近一次探测结果;未探测过的主机不在其中 */
  snapshot(): Record<number, boolean>
}

/**
 * 周期探测**全部**主机(含未启用的,便于用户判断能否启用),逐台翻转时经
 * deps.events 广播 comfy-status(SSE 透传)。
 *
 * 快照是前端的初始态来源:comfy-status 只在翻转时广播,新连上的客户端没有
 * 全量事件可回放,靠 GET /api/hosts 读这份缓存对齐。
 */
export function startHostMonitor(
  deps: { db: Db; events: EventEmitter; comfyFactory: (url: string) => ComfyClient },
  intervalMs = 5000,
): HostMonitor {
  const online = new Map<number, boolean>()
  // 按 URL 缓存 client,避免每轮为每台主机重建
  const clients = new Map<string, ComfyClient>()
  let probing = false

  const clientFor = (url: string): ComfyClient => {
    let c = clients.get(url)
    if (!c) {
      c = deps.comfyFactory(url)
      clients.set(url, c)
    }
    return c
  }

  const tick = async () => {
    if (probing) return
    probing = true
    try {
      const hosts = listHosts(deps.db)
      const live = new Set(hosts.map((h) => h.id))
      for (const id of [...online.keys()]) if (!live.has(id)) online.delete(id)
      await Promise.all(
        hosts.map(async (host) => {
          let up = false
          try {
            up = await clientFor(host.url).isUp()
          } catch {
            up = false
          }
          if (online.get(host.id) !== up) {
            online.set(host.id, up)
            deps.events.emit('event', {
              type: 'comfy-status',
              online: up,
              hostId: host.id,
              hostName: host.name,
            })
          }
        }),
      )
    } finally {
      probing = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return {
    stop: () => clearInterval(timer),
    snapshot: () => Object.fromEntries(online),
  }
}
