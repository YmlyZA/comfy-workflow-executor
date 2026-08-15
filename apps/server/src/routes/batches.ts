import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { Hono } from 'hono'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'
import type { ComfyClient } from '../comfy/client.js'
import type { Job } from '../db/schema.js'
import { createAsyncLock } from '../host-switch.js'

/** 这批 job 各自所在主机的 client(按主机去重)。
 * 参考主机复用 deps.comfy,其余按 hosts 表 URL 临建(与 thumbs/maintenance 同一套写法);
 * hostId 为空的历史任务(盖章之前)归参考主机;主机行已被删则无从中断,跳过。 */
function interruptClients(deps: AppDeps, jobs: Job[]): ComfyClient[] {
  const active = repo.getActiveHost(deps.db)
  const clients: ComfyClient[] = []
  // 无章任务与参考主机归一成同一个 key,避免朝参考主机连发两次 interrupt
  const keys = new Set(jobs.map((j) => j.hostId ?? active?.id ?? null))
  for (const hostId of keys) {
    if (hostId === null || hostId === active?.id) {
      if (deps.comfy) clients.push(deps.comfy)
      continue
    }
    const host = repo.getHost(deps.db, hostId)
    const client = host ? deps.comfyFactory?.(host.url) : null
    if (client) clients.push(client)
  }
  return clients
}

export function batchRoutes(deps: AppDeps) {
  const app = new Hono()
  const lock = (deps.switchLock ??= createAsyncLock())

  app.get('/', (c) => c.json(repo.listBatches(deps.db)))

  app.get('/:id', (c) => {
    const id = Number(c.req.param('id'))
    const detail = repo.getBatchDetail(deps.db, id)
    if (!detail) return c.json({ error: 'batch not found' }, 404)
    return c.json({ ...detail, nav: repo.getBatchNav(deps.db, id) })
  })

  app.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const purgeGpu = c.req.query('purgeGpu') === '1'
    // 整段进热切换锁:分组时读到的 activeId 与实际发送时的 deps.comfy 保持同一台主机,
    // 消除删除与主机切换并发时 active 分组发错主机的窗口
    return await lock.run(async () => {
      // purgeGpu 需在删 DB 记录前收集 GPU 侧输出引用:文件在生成它的那台主机上,
      // 按 job.hostId 分组(盖章前的旧 job 归当前 active 主机),每组内按 subfolder/filename 去重
      const activeId = repo.getActiveHost(deps.db)?.id ?? null
      const byHost = new Map<number | null, Map<string, { filename: string; subfolder: string }>>()
      let gpuSkipped = 0
      if (purgeGpu) {
        for (const job of repo.getBatchDetail(deps.db, id)?.jobs ?? []) {
          for (const out of job.outputs ?? []) {
            if (!out.gpu) {
              gpuSkipped++
              continue
            }
            // active 主机的分组键归一成 null,与无盖章旧 job 合并成一次调用
            const hostKey = job.hostId === activeId ? null : (job.hostId ?? null)
            const group = byHost.get(hostKey) ?? new Map()
            byHost.set(hostKey, group)
            group.set(`${out.gpu.subfolder}/${out.gpu.filename}`, out.gpu)
          }
        }
      }
      const res = repo.deleteBatch(deps.db, id)
      if (res === 'not-found') return c.json({ error: 'batch not found' }, 404)
      if (res === 'running') return c.json({ error: 'batch is running' }, 409)
      let purgeFailed = false
      if (c.req.query('purgeOutputs') === '1') {
        try {
          await rm(join(deps.config.dataDir, 'outputs', String(id)), { recursive: true, force: true })
        } catch {
          purgeFailed = true
        }
      }
      let gpuPurgeFailed = false
      let gpuMissing = 0
      for (const [hostKey, group] of byHost) {
        // null 组 → 当前连接;其余按 hosts 表 URL 临建 client,主机已删则该组失败
        let client = deps.comfy
        if (hostKey !== null) {
          const host = repo.getHost(deps.db, hostKey)
          client = host ? (deps.comfyFactory?.(host.url) ?? null) : null
        }
        if (!client) {
          gpuPurgeFailed = true
          continue
        }
        try {
          const r = await client.cweDeleteOutputFiles([...group.values()])
          if (r.failed.length > 0) gpuPurgeFailed = true
          gpuMissing += r.missing
        } catch {
          gpuPurgeFailed = true
        }
      }
      deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'deleted' })
      return c.json({
        ok: true,
        ...(purgeFailed ? { purgeFailed: true } : {}),
        ...(gpuPurgeFailed ? { gpuPurgeFailed: true } : {}),
        ...(gpuSkipped > 0 ? { gpuSkipped } : {}),
        ...(gpuMissing > 0 ? { gpuMissing } : {}),
      })
    })
  })

  app.post('/:id/cancel', async (c) => {
    const id = Number(c.req.param('id'))
    const detail = repo.getBatchDetail(deps.db, id)
    if (!detail) return c.json({ error: 'batch not found' }, 404)
    // 已结束的 batch 不可取消:否则 completed 会被无谓改写成 canceled
    if (!['pending', 'running'].includes(detail.batch.status)) {
      return c.json({ error: 'batch 已结束,无法取消' }, 409)
    }
    // interrupt 必须发给**真正在跑这个任务的那台主机**:deps.comfy 是参考主机的
    // client,而参考主机大概率正在跑别的批次——朝它发 interrupt 等于误杀无辜任务
    // (还会推高那台主机的失败连击直至熔断),而该停的主机照样把已取消的任务出完图。
    for (const client of interruptClients(deps, repo.cancelBatch(deps.db, id))) {
      await client.interrupt().catch(() => {})
    }
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'canceled' })
    return c.json({ ok: true })
  })

  app.post('/:id/retry-failed', (c) => {
    const id = Number(c.req.param('id'))
    if (!repo.getBatchDetail(deps.db, id)) return c.json({ error: 'batch not found' }, 404)
    const retried = repo.retryFailedJobs(deps.db, id)
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'running' })
    return c.json({ retried })
  })

  app.post('/:id/jobs/:jobId/reroll', (c) => {
    const id = Number(c.req.param('id'))
    const jobId = Number(c.req.param('jobId'))
    const res = repo.rerollJob(deps.db, id, jobId)
    if (res.kind === 'batch-not-found') return c.json({ error: 'batch not found' }, 404)
    if (res.kind === 'job-not-found') return c.json({ error: 'job not found' }, 404)
    if (res.kind === 'not-succeeded') return c.json({ error: '只能重roll成功的任务' }, 400)
    if (res.kind === 'no-seed')
      return c.json({ error: '模板没有 seed 参数,重roll 会生成相同图片' }, 409)
    deps.events.emit('event', {
      type: 'job-updated',
      jobId: res.job.id,
      batchId: id,
      status: 'pending',
    })
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'running' })
    return c.json({ jobId: res.job.id, sortOrder: res.job.sortOrder }, 201)
  })

  return app
}
