import { Hono } from 'hono'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import type { Config } from './config.js'

export interface AppDeps {
  config: Config
  [key: string]: any
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  })

  app.use('/api/*', auth(deps.config.authToken))

  app.get('/api/health', (c) => c.json({ ok: true }))
  // 占位，Task 6 挂真实路由；先保证 auth 测试有非 404 路由可打
  app.get('/api/templates', (c) => c.json([]))

  return app
}
