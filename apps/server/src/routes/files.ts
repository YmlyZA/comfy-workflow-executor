import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { getBatchDetail } from '../db/repo.js'

export function uploadRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => {
    const dir = join(deps.config.dataDir, 'uploads')
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return c.json({ files: [] })
    }
    const files = entries
      .map((name) => ({ name, stat: statSync(join(dir, name), { throwIfNoEntry: false }) }))
      .filter((e) => e.stat?.isFile())
      .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
      .map((e) => e.name)
    return c.json({ files })
  })

  app.post('/', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const raw = body['files']
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: 'no files' }, 400)
    const stored: Array<{ name: string; stored: string }> = []
    for (const file of files) {
      const safe = basename(file.name).replace(/[^\w.-]/g, '_')
      const name = `${randomBytes(4).toString('hex')}-${safe}`
      await writeFile(
        join(deps.config.dataDir, 'uploads', name),
        Buffer.from(await file.arrayBuffer()),
      )
      stored.push({ name: file.name, stored: name })
    }
    return c.json(stored, 201)
  })

  return app
}

export function outputRoutes(deps: AppDeps) {
  const app = new Hono()
  const root = resolve(deps.config.dataDir, 'outputs')

  app.get('/*', (c) => {
    let rel: string
    try {
      rel = decodeURIComponent(c.req.path.replace(/^\/api\/outputs\//, ''))
    } catch {
      return c.json({ error: 'invalid path' }, 400)
    }
    const full = resolve(root, normalize(rel))
    if (!full.startsWith(root + '/')) return c.json({ error: 'invalid path' }, 400)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat || !stat.isFile()) return c.json({ error: 'not found' }, 404)
    const stream = Readable.toWeb(createReadStream(full)) as ReadableStream
    return c.body(stream)
  })

  return app
}

export function downloadRoute(deps: AppDeps) {
  const app = new Hono()

  app.get('/:id/download', (c) => {
    const id = Number(c.req.param('id'))
    const dir = join(deps.config.dataDir, 'outputs', String(id))
    const detail = getBatchDetail(deps.db, id)
    const zipName = detail ? `${detail.batch.name}-${id}.zip` : `batch-${id}.zip`
    const archive = archiver('zip')
    archive.on('error', (err) => console.error('zip archive error', err))
    archive.on('warning', (err) => console.error('zip archive warning', err))
    if (existsSync(dir)) archive.directory(dir, false)
    void archive.finalize()
    c.header('Content-Type', 'application/zip')
    c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`)
    return c.body(Readable.toWeb(archive) as ReadableStream)
  })

  return app
}
