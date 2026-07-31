import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import type { ComfyClient } from './comfy/client.js'
import { ObjectInfoCache } from './comfy/object-info-cache.js'
import { getActiveHost } from './db/repo.js'
import { templateRoutes } from './routes/templates.js'
import { batchRoutes } from './routes/batches.js'
import { eventRoutes } from './routes/events.js'
import { downloadRoute, outputRoutes, uploadRoutes } from './routes/files.js'
import { comfyRoutes } from './routes/comfy.js'
import { hostRoutes } from './routes/hosts.js'
import { inputHistoryRoutes } from './routes/input-history.js'
import { promptRoutes } from './routes/prompts.js'
import { thumbRoutes } from './routes/thumbs.js'
import { backupRoutes } from './routes/backup.js'

export interface AppDeps {
  config: Config
  db: Db
  comfy: ComfyClient | null
  events: EventEmitter
  /** 数据导入热切换用;测试/无 GPU 场景可为 null */
  executor?: { pause(opts?: { abandon?: boolean }): Promise<void>; resume(db: Db, comfy?: ComfyClient): void } | null
  /** /object_info 缓存;由 createApp 自动初始化 */
  objectInfo?: ObjectInfoCache
}

export function createApp(deps: AppDeps) {
  deps.objectInfo ??= new ObjectInfoCache(() => deps.comfy)
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  })

  app.use('/api/*', auth(deps.config.authToken))

  app.get('/api/health', async (c) => {
    const host = getActiveHost(deps.db)
    return c.json({
      ok: true,
      comfy: deps.comfy ? await deps.comfy.isUp() : false,
      host: host ? { id: host.id, name: host.name } : null,
    })
  })
  app.route('/api', backupRoutes(deps))
  app.route('/api/hosts', hostRoutes(deps))
  app.route('/api/comfy', comfyRoutes(deps))
  app.route('/api/templates', templateRoutes(deps))
  app.route('/api/events', eventRoutes(deps))
  app.route('/api/uploads', uploadRoutes(deps))
  app.route('/api/thumbs', thumbRoutes(deps))
  app.route('/api/input-history', inputHistoryRoutes(deps))
  app.route('/api/prompts', promptRoutes(deps))
  app.route('/api/outputs', outputRoutes(deps))
  app.route('/api/batches', downloadRoute(deps))
  app.route('/api/batches', batchRoutes(deps))

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  return app
}
