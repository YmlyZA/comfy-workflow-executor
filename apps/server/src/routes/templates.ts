import { Hono } from 'hono'
import { createBatchSchema, createTemplateSchema, renameTemplateSchema } from '@cwe/shared'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function templateRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listTemplates(deps.db)))

  app.patch('/order', async (c) => {
    const body = (await c.req.json()) as { ids?: unknown }
    const ids =
      Array.isArray(body?.ids) && body.ids.every((n): n is number => typeof n === 'number')
        ? body.ids
        : null
    if (!ids) return c.json({ error: 'ids 必须是数字数组' }, 400)
    const res = repo.reorderTemplates(deps.db, ids)
    if (res === 'unknown-id') return c.json({ error: '包含不存在的模板 id' }, 404)
    if (res === 'incomplete') return c.json({ error: 'ids 必须包含全部模板且不重复' }, 400)
    return c.json({ ok: true })
  })

  app.patch('/:id', async (c) => {
    const { name } = renameTemplateSchema.parse(await c.req.json())
    const t = repo.renameTemplate(deps.db, Number(c.req.param('id')), name)
    if (!t) return c.json({ error: 'template not found' }, 404)
    return c.json(t)
  })

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
