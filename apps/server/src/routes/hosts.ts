import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { createComfyClient } from '../comfy/client.js'
import * as repo from '../db/repo.js'
import { createAsyncLock, reconnectComfy } from '../host-switch.js'

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
  // 与数据导入共用同一把锁(同一个 deps 对象,谁先建谁负责初始化)
  const lock = (deps.switchLock ??= createAsyncLock())

  /** `/:id` 路径参数:非纯数字返回 null,由调用方回 400 */
  const idParam = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null)

  app.get('/', (c) => c.json({ hosts: repo.listHosts(deps.db) }))

  app.post('/', async (c) => {
    const input = createSchema.parse(await c.req.json())
    return c.json({ host: repo.createHost(deps.db, input) }, 201)
  })

  app.get('/current/stats', async (c) => {
    if (!deps.comfy) return c.json({ online: false })
    try {
      const [stats, queue, cweVersion] = await Promise.all([
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
        cwe: cweVersion > 0,
      })
    } catch {
      return c.json({ online: false })
    }
  })

  app.patch('/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const patch = patchSchema.parse(await c.req.json())
    // 整段进锁:存在性判断与写入同一临界区,排队期间主机被删/易主也不会走错分支
    return await lock.run(async () => {
      const before = repo.getHost(deps.db, id)
      if (!before) return c.json({ error: 'host 不存在' }, 404)
      const urlChanged = patch.url !== undefined && patch.url !== before.url
      // 不动 active 主机地址的改动(改名/改非当前主机)不触发重连
      if (before.active !== 1 || !urlChanged) {
        const host = repo.updateHost(deps.db, id, patch)
        if (!host) return c.json({ error: 'host 不存在' }, 404)
        return c.json({ host })
      }
      // 改 active 主机的 URL = 租用 pod 换地址:等待模式重连(详见 host-switch.ts)
      await deps.executor?.pauseAll()
      const host = repo.updateHost(deps.db, id, patch)!
      try {
        await reconnectComfy(deps, host)
      } catch {
        // 当前实现的探测/广播不会抛;防御未来改动:表变更已提交,确保 executor 恢复运转
        deps.executor?.resumeAll(deps.db)
      }
      return c.json({ host })
    })
  })

  app.delete('/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    // 进锁:不与切换/改 URL 的临界区并发,消除锁内非空断言的删除竞态窗口
    return await lock.run(async () => {
      const result = repo.deleteHost(deps.db, id)
      if (result === 'active') return c.json({ error: '当前主机不可删除' }, 409)
      return c.json({ ok: true })
    })
  })

  app.post('/:id/activate', async (c) => {
    const id = idParam(c.req.param('id'))
    if (id === null) return c.json({ error: '无效的 host id' }, 400)
    const { mode } = activateSchema.parse(await c.req.json())
    // 整段进锁:与另一次 activate / 改 URL / 删除 / 数据导入互斥,避免起出两个 executor loop
    return await lock.run(async () => {
      // 锁内重查:排队期间目标主机可能被删除或已被激活
      const target = repo.getHost(deps.db, id)
      if (!target) return c.json({ error: 'host 不存在' }, 404)
      if (target.active === 1) return c.json({ host: target })
      // 先 pause 再切表:否则等待期间 executor 可能认领新 job 并盖上新主机的章
      await deps.executor?.pauseAll(mode === 'interrupt' ? { abandon: true } : undefined)
      const host = repo.activateHost(deps.db, id)!
      try {
        await reconnectComfy(deps, host)
      } catch {
        // 同 PATCH:防御未来改动,保证 executor 不停留在 paused
        deps.executor?.resumeAll(deps.db)
      }
      return c.json({ host })
    })
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
