import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import * as repo from '../db/repo.js'

export function inputHistoryRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => {
    const key = c.req.query('key')
    if (!key) return c.json({ error: '缺少 key 参数' }, 400)
    return c.json({ values: repo.listInputHistory(deps.db, key, deps.config.inputHistoryLimit) })
  })

  app.delete('/', (c) => {
    const key = c.req.query('key')
    const value = c.req.query('value')
    if (!key || !value) return c.json({ error: '缺少 key 或 value 参数' }, 400)
    repo.deleteInputHistory(deps.db, key, value)
    return c.json({ ok: true })
  })

  return app
}
