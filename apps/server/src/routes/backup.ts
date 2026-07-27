import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'

export function backupRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/export', (c) => {
    // WAL 合回主库,zip 里的 db.sqlite 才含最近写入
    deps.db.$client.pragma('wal_checkpoint(TRUNCATE)')
    const archive = archiver('zip')
    archive.on('error', (err) => console.error('export zip error', err))
    archive.on('warning', (err) => console.error('export zip warning', err))
    archive.file(join(deps.config.dataDir, 'db.sqlite'), { name: 'db.sqlite' })
    for (const sub of ['uploads', 'outputs'] as const) {
      const dir = join(deps.config.dataDir, sub)
      if (existsSync(dir)) archive.directory(dir, sub)
    }
    void archive.finalize()
    const date = new Date().toISOString().slice(0, 10)
    c.header('Content-Type', 'application/zip')
    c.header('Content-Disposition', `attachment; filename="cwe-backup-${date}.zip"`)
    return c.body(Readable.toWeb(archive) as ReadableStream)
  })

  return app
}
