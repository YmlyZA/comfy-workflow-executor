import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
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
    archive.on('error', (err) => {
      // 中途读文件失败时掐断流:让下载明确失败,而不是 200 + 静默截断的坏包
      console.error('export zip error', err)
      archive.destroy()
    })
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

      // 外来 wal/shm 不可信(可能与主库不配套,触发错误的 WAL 恢复),丢弃;导出本就不含它们
      await rm(join(tmpDir, 'db.sqlite-wal'), { force: true })
      await rm(join(tmpDir, 'db.sqlite-shm'), { force: true })

      // 校验:趁旧数据还在线,用真实 createDb 试开候选库(连 DDL/迁移一起演练),
      // 失败就干净地 400——避免切换后才在恢复段炸出半死状态
      const dbPath = join(tmpDir, 'db.sqlite')
      let valid = existsSync(dbPath)
      if (valid) {
        try {
          const probe = createDb(dbPath)
          probe.$client.close()
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
          try {
            await rename(bak, dataDir) // 回滚:旧目录归位
          } catch (rollbackErr) {
            console.error(`导入回滚失败:旧数据完好保存在 ${bak},当前将运行在空库上`, rollbackErr)
          }
          throw err
        }
      } finally {
        // 无论换成新旧哪套目录,都要重开 db 恢复服务;这段再抛会把 deps.db 留在已关闭
        // 状态、executor 永久暂停,必须自兜底
        try {
          await mkdir(join(dataDir, 'uploads'), { recursive: true })
          await mkdir(join(dataDir, 'outputs'), { recursive: true })
          const reopened = createDb(join(dataDir, 'db.sqlite'))
          deps.db = reopened
          deps.executor?.resume(reopened)
        } catch (reopenErr) {
          console.error('导入后重开数据库失败,需要重启服务', reopenErr)
        }
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
