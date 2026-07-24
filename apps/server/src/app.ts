import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import type { ComfyClient } from './comfy/client.js'
import { templateRoutes } from './routes/templates.js'
import { batchRoutes } from './routes/batches.js'

export interface AppDeps {
  config: Config
  db: Db
  comfy: ComfyClient | null
  events: EventEmitter
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  })

  app.use('/api/*', auth(deps.config.authToken))

  app.get('/api/health', async (c) =>
    c.json({ ok: true, comfy: deps.comfy ? await deps.comfy.isUp() : false }),
  )
  app.route('/api/templates', templateRoutes(deps))
  app.route('/api/batches', batchRoutes(deps))

  return app
}
