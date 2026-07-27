import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.js'
import { createComfyClient } from './comfy/client.js'
import { loadConfig } from './config.js'
import { createDb } from './db/index.js'
import { Executor } from './executor.js'

const config = loadConfig()
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true })
mkdirSync(join(config.dataDir, 'outputs'), { recursive: true })

const db = createDb(join(config.dataDir, 'db.sqlite'))
const events = new EventEmitter()
const comfy = createComfyClient(config.comfyUrl)
// deps 对象与 app/executor 共享:数据导入热切换靠替换 deps.db/暂停 executor
const deps = { config, db, comfy, events, executor: null as Executor | null }
const app = createApp(deps)

if (existsSync('./public')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/*', serveStatic({ path: './public/index.html' })) // SPA fallback
}

const executor = new Executor({ db, comfy, events, dataDir: config.dataDir })
deps.executor = executor
executor.start()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port} → ${config.comfyUrl}`)
})
