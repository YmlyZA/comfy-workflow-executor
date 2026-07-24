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
