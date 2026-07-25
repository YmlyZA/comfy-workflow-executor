import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { Hono } from 'hono'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function batchRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listBatches(deps.db)))

  app.get('/:id', (c) => {
    const detail = repo.getBatchDetail(deps.db, Number(c.req.param('id')))
    if (!detail) return c.json({ error: 'batch not found' }, 404)
    return c.json(detail)
  })

  app.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
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
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'deleted' })
    return c.json(purgeFailed ? { ok: true, purgeFailed: true } : { ok: true })
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
