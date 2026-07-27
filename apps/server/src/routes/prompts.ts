import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import * as repo from '../db/repo.js'

const keySchema = z
  .string()
  .trim()
  .min(1, 'key 不能为空')
  .refine((k) => !/\s/.test(k), 'key 不能含空白字符')
const contentSchema = z.string().refine((s) => s.trim() !== '', 'content 不能为空')

const createSchema = z.object({ key: keySchema, content: contentSchema })
const updateSchema = z.object({ key: keySchema.optional(), content: contentSchema.optional() })

export function promptRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json({ prompts: repo.listPrompts(deps.db) }))

  app.post('/', async (c) => {
    const body = createSchema.parse(await c.req.json())
    const row = repo.createPrompt(deps.db, body.key, body.content)
    if (row === 'conflict') return c.json({ error: 'key 已存在' }, 409)
    return c.json(row, 201)
  })

  app.put('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = updateSchema.parse(await c.req.json())
    const row = repo.updatePrompt(deps.db, id, body)
    if (row === 'not-found') return c.json({ error: 'not found' }, 404)
    if (row === 'conflict') return c.json({ error: 'key 已存在' }, 409)
    return c.json(row)
  })

  app.delete('/:id', (c) => {
    repo.deletePrompt(deps.db, Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  return app
}
