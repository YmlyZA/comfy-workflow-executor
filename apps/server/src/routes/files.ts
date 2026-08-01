import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { getBatchDetail } from '../db/repo.js'
import { imageMime } from '../mime.js'

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

  /** 上传文件内容(缩略图用);仅裸文件名,防穿越 */
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    if (name.includes('..') || basename(name) !== name) return c.json({ error: 'invalid name' }, 400)
    const full = join(deps.config.dataDir, 'uploads', name)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat?.isFile()) return c.json({ error: 'not found' }, 404)
    c.header('Content-Type', imageMime(name))
    return c.body(Readable.toWeb(createReadStream(full)) as ReadableStream)
  })

  app.post('/', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const raw = body['files']
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: 'no files' }, 400)
    const dir = join(deps.config.dataDir, 'uploads')
    const stored: Array<{ name: string; stored: string }> = []
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer())
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
      // 同内容(hash 前缀相同)复用已有文件,不重复写盘;返回名以先到者为准
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        // 目录不存在时走写盘路径,由 writeFile 抛错(与旧行为一致)
      }
      const existing = entries.find((n) => n.startsWith(`${hash}-`))
      if (existing) {
        stored.push({ name: file.name, stored: existing })
        continue
      }
      const safe = basename(file.name)
        .replace(/[^\w.-]/g, '_')
        .replace(/\.{2,}/g, '.')
      const name = `${hash}-${safe}`
      await writeFile(join(dir, name), buf)
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
    c.header('Content-Type', imageMime(full))
    const stream = Readable.toWeb(createReadStream(full)) as ReadableStream
    return c.body(stream)
  })

  return app
}

export function downloadRoute(deps: AppDeps) {
  const app = new Hono()

  app.get('/:id/download', (c) => {
    const id = Number(c.req.param('id'))
    const detail = getBatchDetail(deps.db, id)
    if (!detail) return c.json({ error: 'batch not found' }, 404)
    const zipName = `${detail.batch.name}-${id}.zip`
    const archive = archiver('zip')
    archive.on('error', (err) => console.error('zip archive error', err))
    archive.on('warning', (err) => console.error('zip archive warning', err))
    // 按 DB outputs 清单打包而非整目录:目录里可能有孤儿文件(重跑前的旧产物等)
    for (const job of detail.jobs) {
      for (const out of job.outputs ?? []) {
        const full = join(deps.config.dataDir, 'outputs', out.path)
        if (existsSync(full)) archive.file(full, { name: out.filename })
      }
    }
    void archive.finalize()
    // 中文批次名走 RFC 5987 filename*;filename 为 ASCII 兜底
    const fallback = zipName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
    c.header('Content-Type', 'application/zip')
    c.header(
      'Content-Disposition',
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    )
    return c.body(Readable.toWeb(archive) as ReadableStream)
  })

  return app
}
