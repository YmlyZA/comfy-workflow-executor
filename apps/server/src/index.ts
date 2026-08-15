import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { AppDeps } from './app.js'
import { createApp } from './app.js'
import { createComfyClient } from './comfy/client.js'
import { loadConfig } from './config.js'
import { createDb } from './db/index.js'
import { ensureActiveHost } from './db/repo.js'
import { ExecutorPool } from './executor-pool.js'
import { startHostMonitor } from './host-monitor.js'

const config = loadConfig()
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true })
mkdirSync(join(config.dataDir, 'outputs'), { recursive: true })

const db = createDb(join(config.dataDir, 'db.sqlite'))
const activeHost = ensureActiveHost(db, config.comfyUrl)
const events = new EventEmitter()
const comfy = createComfyClient(activeHost.url)
// deps 对象与 app/executor/monitor 共享:热切换靠替换 deps.db / deps.comfy
const deps: AppDeps = { config, db, comfy, events, executor: null }
const app = createApp(deps)

if (existsSync('./public')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/*', serveStatic({ path: './public/index.html' })) // SPA fallback
}

// 每台 enabled 主机一个 worker;先收无主的 running job,再按 hosts 表对齐 worker 集合
const pool = new ExecutorPool({ db, events, dataDir: config.dataDir, comfyFactory: createComfyClient })
pool.reclaimOrphans()
pool.syncFromDb()
deps.executor = pool
deps.hostMonitor = startHostMonitor({ db, events, comfyFactory: createComfyClient })

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port} → ${activeHost.name} (${activeHost.url})`)
})
