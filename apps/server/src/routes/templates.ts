import { Hono } from 'hono'
import { createBatchSchema, createTemplateSchema } from '@cwe/shared'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function templateRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listTemplates(deps.db)))

  app.post('/', async (c) => {
    const input = createTemplateSchema.parse(await c.req.json())
    return c.json(repo.createTemplate(deps.db, input), 201)
  })

  app.delete('/:id', (c) => {
    try {
      repo.deleteTemplate(deps.db, Number(c.req.param('id')))
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')) {
        return c.json({ error: 'template has batches' }, 409)
      }
      throw err
    }
  })

  app.post('/:id/batches', async (c) => {
    const id = Number(c.req.param('id'))
    if (!repo.getTemplate(deps.db, id)) return c.json({ error: 'template not found' }, 404)
    const input = createBatchSchema.parse(await c.req.json())
    const batch = repo.createBatch(deps.db, id, input)
    deps.events.emit('event', { type: 'batch-updated', batchId: batch.id, status: batch.status })
    return c.json(batch, 201)
  })

  return app
}
