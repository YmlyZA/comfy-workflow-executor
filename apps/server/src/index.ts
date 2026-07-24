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
const app = createApp({ config, db, comfy, events })

if (existsSync('./public')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/*', serveStatic({ path: './public/index.html' })) // SPA fallback
}

const executor = new Executor({ db, comfy, events, dataDir: config.dataDir })
executor.start()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port} → ${config.comfyUrl}`)
})
