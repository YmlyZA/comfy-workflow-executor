import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { ComfyClient } from '../comfy/client.js'
import { createComfyClient } from '../comfy/client.js'
import * as repo from '../db/repo.js'
import { createAsyncLock, reconnectComfy } from '../host-switch.js'

const urlSchema = z
  .string()
  .trim()
  .regex(/^https?:\/\//, 'URL 需以 http(s):// 开头')
  .transform((u) => u.replace(/\/+$/, ''))
const kindSchema = z.enum(['resident', 'rental'])
const createSchema = z.object({
  name: z.string().trim().min(1),
  url: urlSchema,
  note: z.string().nullish(),
  kind: kindSchema.optional(),
  rentedAt: z.string().nullish(),
  hourlyRate: z.number().positive().nullish(),
})
const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  url: urlSchema.optional(),
  note: z.string().nullish(),
  kind: kindSchema.optional(),
  rentedAt: z.string().nullish(),
  hourlyRate: z.number().positive().nullish(),
  /** 只接受 true:停用需要选模式,必须走 POST /:id/disable */
  enabled: z.literal(true).optional(),
})
const disableSchema = z.object({ mode: z.enum(['wait', 'interrupt']) })

async function probeStats(client: ComfyClient) {
  try {
    const [stats, queue, cweVersion] = await Promise.all([
      client.getSystemStats(),
      client.getQueueCounts(),
      client.cwePing(),
    ])
    const dev = stats.devices?.[0]
    const mb = (n: number | undefined) => (n != null ? Math.round(n / 1048576) : null)
    return {
      online: true,
      gpuName: dev?.name ?? null,
      vramTotalMB: mb(dev?.vram_total),
      vramFreeMB: mb(dev?.vram_free),
      comfyuiVersion: stats.system?.comfyui_version ?? null,
      pythonVersion: stats.system?.python_version ?? null,
      os: stats.system?.os ?? null,
      queueRunning: queue.running,
      queuePending: queue.pending,
      cwe: cweVersion > 0,
    }
  } catch {
    return { online: false }
  }
}

export function hostRoutes(deps: AppDeps) {
  const app = new Hono()
  // 与数据导入共用同一把锁(同一个 deps 对象,谁先建谁负责初始化)
  const lock = (deps.switchLock ??= createAsyncLock())

  /** `/:id` 路径参数:非纯数字返回 null,由调用方回 400 */
  const idParam = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null)

  app.get('/', (c) => {
    const snapshot = deps.hostMonitor?.snapshot() ?? {}
    const hosts = repo.listHosts(deps.db).map((h) => ({
      ...h,
      // 取自 monitor 缓存,不做实时探测;未探测过为 null
      online: snapshot[h.id] ?? null,
      pinnedBatches: repo.countPinnedUnfinishedBatches(deps.db, h.id),
    }))
    return c.json({ hosts })
  })

  app.post('/', async (c) => {
    const input = createSchema.parse(await c.req.json())
    return c.json({ host: repo.createHost(deps.db, input) }, 201)
  })

  app.get('/current/stats', async (c) => {
    if (!deps.comfy) return c.json({ online: false })
    return c.json(await probeStats(deps.comfy))
  })

  app.patch('/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const patch = patchSchema.parse(await c.req.json())
    return await lock.run(async () => {
      const before = repo.getHost(deps.db, id)
      if (!before) return c.json({ error: 'host 不存在' }, 404)
      const { enabled, ...fields } = patch
      const urlChanged = fields.url !== undefined && fields.url !== before.url
      // fields 可能为空({ enabled: true } 单独出现时);drizzle 的 .set({}) 会抛「No values to set」
      if (Object.keys(fields).length > 0 && !repo.updateHost(deps.db, id, fields)) {
        return c.json({ error: 'host 不存在' }, 404)
      }
      if (enabled === true && before.enabled !== 1) repo.setHostEnabled(deps.db, id, true)
      // 改 URL 只重建该主机的 worker,不影响其他 worker
      if (urlChanged) await deps.executor?.restartWorker(id)
      deps.executor?.syncFromDb()
      // 参考主机换了地址,查询用 client 也要跟着换
      if (urlChanged && before.active === 1) {
        await reconnectComfy(deps, repo.getHost(deps.db, id)!)
      }
      return c.json({ host: repo.getHost(deps.db, id)! })
    })
  })

  app.delete('/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    return await lock.run(async () => {
      // 停 worker 再删,避免 worker 拿着已删除主机的 id 继续认领
      await deps.executor?.stopWorker(id)
      const result = repo.deleteHost(deps.db, id)
      if (result === 'active') return c.json({ error: '参考主机不可删除' }, 409)
      return c.json({ ok: true })
    })
  })

  app.post('/:id/activate', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    // 只换参考主机:不 pause 任何 worker,并行任务不中断。
    // spec 说此入口「不再需要进锁」——但仍保留:它与 DELETE 存在竞态(排队期间
    // 目标主机可能被删除,导致把已删除的主机设为参考主机)。锁的成本是零。
    return await lock.run(async () => {
      const target = repo.getHost(deps.db, id)
      if (!target) return c.json({ error: 'host 不存在' }, 404)
      if (target.active === 1) return c.json({ host: target })
      const host = repo.activateHost(deps.db, id)!
      await reconnectComfy(deps, host)
      return c.json({ host })
    })
  })

  app.post('/:id/disable', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const { mode } = disableSchema.parse(await c.req.json())
    return await lock.run(async () => {
      if (!repo.getHost(deps.db, id)) return c.json({ error: 'host 不存在' }, 404)
      repo.setHostEnabled(deps.db, id, false)
      // wait = 等当前任务跑完;interrupt = 放弃并重置回 pending 由其他主机接手
      await deps.executor?.stopWorker(id, mode === 'interrupt' ? { abandon: true } : undefined)
      return c.json({ host: repo.getHost(deps.db, id)! })
    })
  })

  app.get('/:id/stats', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const host = repo.getHost(deps.db, id)
    if (!host) return c.json({ error: 'host 不存在' }, 404)
    return c.json(await probeStats(deps.comfyFactory!(host.url)))
  })

  app.post('/:id/test', async (c) => {
    const host = repo.getHost(deps.db, Number(c.req.param('id')))
    if (!host) return c.json({ error: 'host 不存在' }, 404)
    const probe = createComfyClient(host.url)
    const t0 = Date.now()
    try {
      const stats = await probe.getSystemStats()
      const latencyMs = Date.now() - t0
      const cweVersion = await probe.cwePing()
      const dev = stats.devices?.[0]
      return c.json({
        reachable: true,
        latencyMs,
        cwe: cweVersion > 0,
        gpuName: dev?.name ?? null,
        vramTotalMB: dev?.vram_total != null ? Math.round(dev.vram_total / 1048576) : null,
      })
    } catch {
      return c.json({ reachable: false })
    }
  })

  return app
}
