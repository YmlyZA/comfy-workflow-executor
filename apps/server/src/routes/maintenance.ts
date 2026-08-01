import { readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import * as repo from '../db/repo.js'
import { createAsyncLock } from '../host-switch.js'

/** 进行中导入的 .import-* 新鲜度窗口:只删超过这个时长的残留 */
const IMPORT_FRESH_MS = 60 * 60 * 1000

const cleanSchema = z.object({
  targets: z.array(z.enum(['bak', 'thumbs', 'orphan-outputs'])).nonempty(),
})

/** 递归统计文件数与字节;路径不存在返回全零 */
function duSync(path: string): { files: number; bytes: number } {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return { files: 0, bytes: 0 }
  if (st.isFile()) return { files: 1, bytes: st.size }
  if (!st.isDirectory()) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const name of readdirSync(path)) {
    const sub = duSync(join(path, name))
    files += sub.files
    bytes += sub.bytes
  }
  return { files, bytes }
}

export function maintenanceRoutes(deps: AppDeps) {
  const app = new Hono()
  deps.switchLock ??= createAsyncLock()

  const bakEntries = () => {
    try {
      return readdirSync(deps.config.dataDir).filter(
        (n) => n.startsWith('.bak-') || n.startsWith('.import-'),
      )
    } catch {
      return []
    }
  }

  /** outputs/ 下不是现存 batch id 的目录(含非数字命名) */
  const orphanOutputDirs = () => {
    const root = join(deps.config.dataDir, 'outputs')
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      return []
    }
    return entries.filter((name) => {
      if (!statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory()) return false
      const id = Number(name)
      if (!Number.isInteger(id) || id <= 0) return true
      return repo.getBatchStatus(deps.db, id) === undefined
    })
  }

  app.get('/summary', (c) => {
    const dataDir = deps.config.dataDir
    const sum = (paths: string[]) =>
      paths.reduce(
        (acc, p) => {
          const d = duSync(p)
          return { files: acc.files + d.files, bytes: acc.bytes + d.bytes }
        },
        { files: 0, bytes: 0 },
      )
    const bak = sum(bakEntries().map((n) => join(dataDir, n)))
    const thumbs = duSync(join(dataDir, 'thumbs'))
    const orphans = sum(orphanOutputDirs().map((n) => join(dataDir, 'outputs', n)))
    return c.json({
      bak: { count: bakEntries().length, bytes: bak.bytes },
      thumbs: { count: thumbs.files, bytes: thumbs.bytes },
      orphanOutputs: { count: orphanOutputDirs().length, bytes: orphans.bytes },
    })
  })

  app.post('/clean', async (c) => {
    const { targets } = cleanSchema.parse(await c.req.json())
    const dataDir = deps.config.dataDir
    // 整体进热切换锁:绝不与导入的临时目录/热切换窗口并发
    const results = await deps.switchLock!.run(async () => {
      const out: Record<string, { freedBytes: number; failed: string[] }> = {}
      for (const target of new Set(targets)) {
        const r = { freedBytes: 0, failed: [] as string[] }
        out[target] = r
        const removeAll = async (paths: Array<{ label: string; full: string }>) => {
          for (const { label, full } of paths) {
            const size = duSync(full).bytes
            try {
              await rm(full, { recursive: true, force: true })
              r.freedBytes += size
            } catch {
              r.failed.push(label)
            }
          }
        }
        if (target === 'bak') {
          const now = Date.now()
          const entries = bakEntries().filter((n) => {
            if (!n.startsWith('.import-')) return true
            const st = statSync(join(dataDir, n), { throwIfNoEntry: false })
            // 新鲜 .import-* 可能属于进行中的导入(上传/解压段不持锁),跳过
            return st != null && now - st.mtimeMs > IMPORT_FRESH_MS
          })
          await removeAll(entries.map((n) => ({ label: n, full: join(dataDir, n) })))
        } else if (target === 'thumbs') {
          await removeAll([{ label: 'thumbs', full: join(dataDir, 'thumbs') }])
        } else {
          await removeAll(
            orphanOutputDirs().map((n) => ({ label: n, full: join(dataDir, 'outputs', n) })),
          )
        }
      }
      return out
    })
    return c.json({ results })
  })

  return app
}
