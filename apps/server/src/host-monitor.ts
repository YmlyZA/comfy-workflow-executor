import type { AppDeps } from './app.js'
import { getActiveHost } from './db/repo.js'

/** 周期探测当前主机在线状态,翻转时经 deps.events 广播 comfy-status(SSE 透传)。
 * 与 executor 的离线退避探测并存:双份轻量 isUp 可接受。 */
export function startHostMonitor(
  deps: Pick<AppDeps, 'db' | 'comfy' | 'events'>,
  intervalMs = 5000,
): () => void {
  let last: boolean | null = null
  let probing = false
  const tick = async () => {
    if (probing) return
    probing = true
    try {
      const online = deps.comfy ? await deps.comfy.isUp() : false
      if (online !== last) {
        last = online
        const host = getActiveHost(deps.db)
        deps.events.emit('event', {
          type: 'comfy-status',
          online,
          hostId: host?.id ?? null,
          hostName: host?.name ?? null,
        })
      }
    } finally {
      probing = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return () => clearInterval(timer)
}
