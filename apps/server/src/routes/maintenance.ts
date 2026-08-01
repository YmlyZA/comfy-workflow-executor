import { readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { ComfyClient } from '../comfy/client.js'
import * as repo from '../db/repo.js'
import { createAsyncLock } from '../host-switch.js'

/** 进行中导入的 .import-* 新鲜度窗口:只删超过这个时长的残留 */
const IMPORT_FRESH_MS = 60 * 60 * 1000

const cleanSchema = z.object({
  targets: z.array(z.enum(['bak', 'thumbs', 'orphan-outputs'])).nonempty(),
})

const gpuCleanSchema = z.object({
  hostId: z.number().int(),
  files: z.array(z.object({ filename: z.string(), subfolder: z.string() })).min(1).max(1000),
})

type HostClient =
  | { ok: true; host: { id: number; name: string }; client: ComfyClient }
  | { ok: false; status: 404 | 503; error: string }

/** hostId 缺省=active;非 active 主机按表里 URL 经 comfyFactory 临建 client */
function resolveHostClient(deps: AppDeps, hostIdRaw: string | undefined): HostClient {
  const active = repo.getActiveHost(deps.db)
  const hostId = hostIdRaw !== undefined ? Number(hostIdRaw) : active?.id
  const host = hostId !== undefined ? repo.getHost(deps.db, hostId) : undefined
  if (!host) return { ok: false, status: 404, error: 'host 不存在' }
  const client = host.id === active?.id ? deps.comfy : (deps.comfyFactory?.(host.url) ?? null)
  if (!client) return { ok: false, status: 503, error: 'GPU 主机不可达或未安装 cwe 扩展' }
  return { ok: true, host: { id: host.id, name: host.name }, client }
}

/** cwe v2 门禁:0 → 503,1 → 409 */
async function requireCweV2(client: ComfyClient): Promise<{ status: 503 | 409; error: string } | null> {
  const version = await client.cwePing()
  if (version === 0) return { status: 503, error: 'GPU 主机不可达或未安装 cwe 扩展' }
  if (version < 2) return { status: 409, error: '需将 cwe 扩展升级到 v2 并重启 ComfyUI' }
  return null
}

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

  app.get('/gpu-orphans', async (c) => {
    const resolved = resolveHostClient(deps, c.req.query('hostId'))
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status)
    const gate = await requireCweV2(resolved.client)
    if (gate) return c.json({ error: gate.error }, gate.status)
    const files = await resolved.client.cweListOutputFiles()
    const refs = repo.listAllGpuRefKeys(deps.db)
    const orphans = files.filter((f) => !refs.has(`${f.subfolder}/${f.filename}`))
    return c.json({
      host: resolved.host,
      orphans,
      totalBytes: orphans.reduce((acc, f) => acc + f.size, 0),
    })
  })

  app.post('/gpu-clean', async (c) => {
    const { hostId, files } = gpuCleanSchema.parse(await c.req.json())
    const resolved = resolveHostClient(deps, String(hostId))
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status)
    const gate = await requireCweV2(resolved.client)
    if (gate) return c.json({ error: gate.error }, gate.status)
    return c.json(await resolved.client.cweDeleteOutputFiles(files))
  })

  return app
}
