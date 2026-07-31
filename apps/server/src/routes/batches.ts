import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { Hono } from 'hono'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function batchRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listBatches(deps.db)))

  app.get('/:id', (c) => {
    const id = Number(c.req.param('id'))
    const detail = repo.getBatchDetail(deps.db, id)
    if (!detail) return c.json({ error: 'batch not found' }, 404)
    return c.json({ ...detail, nav: repo.getBatchNav(deps.db, id) })
  })

  app.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    // purgeGpu 需在删 DB 记录前收集 GPU 侧输出引用:文件在生成它的那台主机上,
    // 按 job.hostId 分组(盖章前的旧 job 归当前 active 主机),每组内按 subfolder/filename 去重
    const purgeGpu = c.req.query('purgeGpu') === '1'
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

  app.post('/:id/cancel', async (c) => {
    const id = Number(c.req.param('id'))
    if (!repo.getBatchDetail(deps.db, id)) return c.json({ error: 'batch not found' }, 404)
    const runningJob = repo.cancelBatch(deps.db, id)
    if (runningJob && deps.comfy) await deps.comfy.interrupt().catch(() => {})
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
