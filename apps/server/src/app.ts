import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import { createComfyClient, type ComfyClient } from './comfy/client.js'
import type { ExecutorPool } from './executor-pool.js'
import { ObjectInfoCache } from './comfy/object-info-cache.js'
import { getActiveHost } from './db/repo.js'
import type { AsyncLock } from './host-switch.js'
import type { HostMonitor } from './host-monitor.js'
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
import { maintenanceRoutes } from './routes/maintenance.js'

export interface AppDeps {
  config: Config
  db: Db
  comfy: ComfyClient | null
  events: EventEmitter
  /** 执行器池;测试/无 GPU 场景可为 null */
  executor?: ExecutorPool | null
  /** /object_info 缓存;由 createApp 自动初始化 */
  objectInfo?: ObjectInfoCache
  /** 热切换串行锁(主机切换 / 改 active URL / 数据导入共用);由各路由首次使用时自动初始化 */
  switchLock?: AsyncLock
  /** 按 URL 建 client(非当前主机的 GPU 清理用);默认真实实现,测试可注入 fake */
  comfyFactory?: (url: string) => ComfyClient
  /** 主机在线状态缓存;由 index.ts 在 createApp 之后赋值(deps 是共享可变对象) */
  hostMonitor?: HostMonitor
}

export function createApp(deps: AppDeps) {
  deps.objectInfo ??= new ObjectInfoCache(() => deps.comfy)
  deps.comfyFactory ??= createComfyClient
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
  app.route('/api/maintenance', maintenanceRoutes(deps))
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
