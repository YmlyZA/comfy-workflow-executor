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
import { startHostMonitor } from './host-monitor.js'

const config = loadConfig()
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true })
mkdirSync(join(config.dataDir, 'outputs'), { recursive: true })

const db = createDb(join(config.dataDir, 'db.sqlite'))
const activeHost = ensureActiveHost(db, config.comfyUrl)
const events = new EventEmitter()
const comfy = createComfyClient(activeHost.url)
// deps 对象与 app/executor/monitor 共享:热切换靠替换 deps.db / deps.comfy
const deps = { config, db, comfy, events, executor: null as Executor | null }
const app = createApp(deps)

if (existsSync('./public')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/*', serveStatic({ path: './public/index.html' })) // SPA fallback
}

// hostId 暂时固定为当前 active host;Task 3 会改造成每主机一个 Executor 实例
const executor = new Executor({ db, comfy, events, dataDir: config.dataDir, hostId: activeHost.id })
deps.executor = executor
executor.start()
startHostMonitor(deps)

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port} → ${activeHost.name} (${activeHost.url})`)
})
