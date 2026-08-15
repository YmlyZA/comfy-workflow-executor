import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.js'
import { createComfyClient } from './comfy/client.js'
import { loadConfig } from './config.js'
import { createDb } from './db/index.js'
import { ensureActiveHost } from './db/repo.js'
import { Executor } from './executor.js'
import type { ExecutorPool } from './executor-pool.js'
import { startHostMonitor } from './host-monitor.js'

const config = loadConfig()
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true })
mkdirSync(join(config.dataDir, 'outputs'), { recursive: true })

const db = createDb(join(config.dataDir, 'db.sqlite'))
const activeHost = ensureActiveHost(db, config.comfyUrl)
const events = new EventEmitter()
const comfy = createComfyClient(activeHost.url)
// deps 对象与 app/executor/monitor 共享:热切换靠替换 deps.db / deps.comfy
// TODO(Task 8): 这里仍是改造前的单 Executor,先用类型断言让 AppDeps.executor(已提前
// 改为 ExecutorPool 类型,供 Task 6 路由使用)编译通过;真正换成 ExecutorPool 由 Task 8 接线。
const deps = { config, db, comfy, events, executor: null as ExecutorPool | null }
const app = createApp(deps)

if (existsSync('./public')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/*', serveStatic({ path: './public/index.html' })) // SPA fallback
}

// hostId 暂时固定为当前 active host;Task 4 会改造成每主机一个 Executor 实例(pool)
const executor = new Executor({
  db,
  comfy,
  events,
  dataDir: config.dataDir,
  hostId: activeHost.id,
  hostName: activeHost.name,
  hostKind: activeHost.kind,
})
deps.executor = executor as unknown as ExecutorPool
executor.start()
startHostMonitor(deps)

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port} → ${activeHost.name} (${activeHost.url})`)
})
