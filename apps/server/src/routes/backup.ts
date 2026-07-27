import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { createDb } from '../db/index.js'
import { extractZip } from '../zip.js'

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

  let importing = false

  app.post('/import', async (c) => {
    if (importing) return c.json({ error: '已有导入进行中' }, 409)
    importing = true
    const stamp = Date.now()
    const dataDir = resolve(deps.config.dataDir)
    const tmpZip = `${dataDir}.import-${stamp}.zip`
    const tmpDir = `${dataDir}.import-${stamp}`
    try {
      const body = c.req.raw.body
      if (!body) return c.json({ error: '请求体为空' }, 400)
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmpZip))

      try {
        await extractZip(tmpZip, tmpDir)
      } catch (err) {
        return c.json(
          { error: `zip 解析失败: ${err instanceof Error ? err.message : String(err)}` },
          400,
        )
      }

      const dbPath = join(tmpDir, 'db.sqlite')
      let valid = existsSync(dbPath)
      if (valid) {
        try {
          const check = new Database(dbPath, { readonly: true })
          check.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
          check.close()
        } catch {
          valid = false
        }
      }
      if (!valid) return c.json({ error: 'zip 内缺少有效的 db.sqlite' }, 400)

      // 热切换:暂停执行器 → 关库 → 换目录(留 bak) → 重开 → 换引用 → 复跑
      await deps.executor?.pause()
      deps.db.$client.close()
      const bak = `${dataDir}.bak-${stamp}`
      try {
        await rename(dataDir, bak)
        try {
          await rename(tmpDir, dataDir)
        } catch (err) {
          await rename(bak, dataDir) // 回滚:旧目录归位
          throw err
        }
      } finally {
        // 无论换成新旧哪套目录,都要重开 db 恢复服务
        await mkdir(join(dataDir, 'uploads'), { recursive: true })
        await mkdir(join(dataDir, 'outputs'), { recursive: true })
        const reopened = createDb(join(dataDir, 'db.sqlite'))
        deps.db = reopened
        deps.executor?.resume(reopened)
      }
      return c.json({ ok: true })
    } finally {
      importing = false
      await rm(tmpZip, { force: true }).catch(() => {})
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  return app
}
