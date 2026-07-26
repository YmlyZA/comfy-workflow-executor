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
    // purgeGpu 需在删 DB 记录前收集 GPU 侧输出引用(按 subfolder/filename 去重)
    const purgeGpu = c.req.query('purgeGpu') === '1'
    const gpuRefs: Array<{ filename: string; subfolder: string }> = []
    let gpuSkipped = 0
    if (purgeGpu) {
      const seen = new Set<string>()
      for (const job of repo.getBatchDetail(deps.db, id)?.jobs ?? []) {
        for (const out of job.outputs ?? []) {
          if (!out.gpu) {
            gpuSkipped++
            continue
          }
          const key = `${out.gpu.subfolder}/${out.gpu.filename}`
          if (!seen.has(key)) {
            seen.add(key)
            gpuRefs.push(out.gpu)
          }
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
    if (purgeGpu && gpuRefs.length > 0) {
      if (!deps.comfy) {
        gpuPurgeFailed = true
      } else {
        try {
          const r = await deps.comfy.cweDeleteOutputFiles(gpuRefs)
          if (r.failed.length > 0) gpuPurgeFailed = true
        } catch {
          gpuPurgeFailed = true
        }
      }
    }
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'deleted' })
    return c.json({
      ok: true,
      ...(purgeFailed ? { purgeFailed: true } : {}),
      ...(gpuPurgeFailed ? { gpuPurgeFailed: true } : {}),
      ...(gpuSkipped > 0 ? { gpuSkipped } : {}),
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

  return app
}
