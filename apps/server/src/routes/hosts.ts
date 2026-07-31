import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { createComfyClient } from '../comfy/client.js'
import * as repo from '../db/repo.js'

const urlSchema = z
  .string()
  .trim()
  .regex(/^https?:\/\//, 'URL 需以 http(s):// 开头')
  .transform((u) => u.replace(/\/+$/, ''))
const createSchema = z.object({
  name: z.string().trim().min(1),
  url: urlSchema,
  note: z.string().nullish(),
})
const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  url: urlSchema.optional(),
  note: z.string().nullish(),
})
const activateSchema = z.object({ mode: z.enum(['wait', 'interrupt']) })

export function hostRoutes(deps: AppDeps) {
  const app = new Hono()

  /** 表已切换后重建连接:换 client、失效节点缓存、重启 executor、广播状态 */
  async function reconnect(host: { id: number; name: string; url: string }): Promise<void> {
    const client = createComfyClient(host.url)
    deps.comfy = client
    deps.objectInfo?.invalidate()
    deps.executor?.resume(deps.db, client)
    const online = await client.isUp()
    deps.events.emit('event', {
      type: 'comfy-status',
      online,
      hostId: host.id,
      hostName: host.name,
    })
  }

  app.get('/', (c) => c.json({ hosts: repo.listHosts(deps.db) }))

  app.post('/', async (c) => {
    const input = createSchema.parse(await c.req.json())
    return c.json({ host: repo.createHost(deps.db, input) }, 201)
  })

  app.get('/current/stats', async (c) => {
    if (!deps.comfy) return c.json({ online: false })
    try {
      const [stats, queue, cwe] = await Promise.all([
        deps.comfy.getSystemStats(),
        deps.comfy.getQueueCounts(),
        deps.comfy.cwePing(),
      ])
      const dev = stats.devices?.[0]
      const mb = (n: number | undefined) => (n != null ? Math.round(n / 1048576) : null)
      return c.json({
        online: true,
        gpuName: dev?.name ?? null,
        vramTotalMB: mb(dev?.vram_total),
        vramFreeMB: mb(dev?.vram_free),
        comfyuiVersion: stats.system?.comfyui_version ?? null,
        pythonVersion: stats.system?.python_version ?? null,
        os: stats.system?.os ?? null,
        queueRunning: queue.running,
        queuePending: queue.pending,
        cwe,
      })
    } catch {
      return c.json({ online: false })
    }
  })

  app.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const patch = patchSchema.parse(await c.req.json())
    const before = repo.getHost(deps.db, id)
    if (!before) return c.json({ error: 'host 不存在' }, 404)
    const urlChanged = patch.url !== undefined && patch.url !== before.url
    // 改 active 主机的 URL = 租用 pod 换地址:等待模式重连
    if (before.active === 1 && urlChanged) await deps.executor?.pause()
    const host = repo.updateHost(deps.db, id, patch)!
    if (before.active === 1 && urlChanged) await reconnect(host)
    return c.json({ host })
  })

  app.delete('/:id', async (c) => {
    const result = repo.deleteHost(deps.db, Number(c.req.param('id')))
    if (result === 'active') return c.json({ error: '当前主机不可删除' }, 409)
    return c.json({ ok: true })
  })

  app.post('/:id/activate', async (c) => {
    const id = Number(c.req.param('id'))
    const { mode } = activateSchema.parse(await c.req.json())
    const target = repo.getHost(deps.db, id)
    if (!target) return c.json({ error: 'host 不存在' }, 404)
    if (target.active === 1) return c.json({ host: target })
    // 先 pause 再切表:否则等待期间 executor 可能认领新 job 并盖上新主机的章
    await deps.executor?.pause(mode === 'interrupt' ? { abandon: true } : undefined)
    const host = repo.activateHost(deps.db, id)!
    await reconnect(host)
    return c.json({ host })
  })

  app.post('/:id/test', async (c) => {
    const host = repo.getHost(deps.db, Number(c.req.param('id')))
    if (!host) return c.json({ error: 'host 不存在' }, 404)
    const probe = createComfyClient(host.url)
    const t0 = Date.now()
    try {
      const stats = await probe.getSystemStats()
      const latencyMs = Date.now() - t0
      const cwe = await probe.cwePing()
      const dev = stats.devices?.[0]
      return c.json({
        reachable: true,
        latencyMs,
        cwe,
        gpuName: dev?.name ?? null,
        vramTotalMB: dev?.vram_total != null ? Math.round(dev.vram_total / 1048576) : null,
      })
    } catch {
      return c.json({ reachable: false })
    }
  })

  return app
}
