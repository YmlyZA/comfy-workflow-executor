import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import type { AppDeps } from '../app.js'
import { getActiveHost, getHost } from '../db/repo.js'
import type { ComfyClient } from '../comfy/client.js'

/** 缩略图最长边(px):网格 96px 格子 ×2 DPR */
const THUMB_SIZE = 192

export function thumbRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', async (c) => {
    const source = c.req.query('source') ?? ''
    const name = c.req.query('name') ?? ''
    if (source !== 'uploads' && source !== 'comfy' && source !== 'comfy-output') return c.json({ error: 'source 非法' }, 400)
    if (!name) return c.json({ error: '缺少 name 参数' }, 400)
    // uploads 仅裸文件名;comfy 允许子目录相对名(LoadImage COMBO 会列 subdir/file.png)
    if (name.includes('..') || isAbsolute(name)) return c.json({ error: 'name 非法' }, 400)
    if (source === 'uploads' && basename(name) !== name) return c.json({ error: 'name 非法' }, 400)

    // comfy* 源按名缓存,而"同名"只在同一台主机内有意义——目录按主机 id 隔离;
    // uploads 内容寻址与主机无关
    let cacheDir: string
    let outputClient: ComfyClient | null = null
    let hostLabel = ''
    if (source === 'uploads') {
      cacheDir = resolve(deps.config.dataDir, 'thumbs', 'uploads')
    } else if (source === 'comfy') {
      cacheDir = resolve(deps.config.dataDir, 'thumbs', 'comfy', String(getActiveHost(deps.db)?.id ?? 0))
    } else {
      const active = getActiveHost(deps.db)
      const hostIdRaw = c.req.query('hostId')
      const hostId = hostIdRaw !== undefined ? Number(hostIdRaw) : active?.id
      const host = hostId !== undefined ? getHost(deps.db, hostId) : undefined
      if (!host) return c.json({ error: 'host 不存在' }, 404)
      outputClient = host.id === active?.id ? deps.comfy : (deps.comfyFactory?.(host.url) ?? null)
      hostLabel = String(host.id)
      cacheDir = resolve(deps.config.dataDir, 'thumbs', 'comfy-output', hostLabel)
    }
    // encodeURIComponent 后不含路径分隔符,天然单段;前缀守卫双保险
    const cachePath = resolve(cacheDir, `${encodeURIComponent(name)}.webp`)
    if (!cachePath.startsWith(cacheDir + '/')) return c.json({ error: 'name 非法' }, 400)

    if (existsSync(cachePath)) {
      const buf = await readFile(cachePath)
      c.header('Content-Type', 'image/webp')
      c.header('Cache-Control', 'max-age=86400')
      return c.body(Readable.toWeb(Readable.from(buf)) as ReadableStream)
    }

    let src: Buffer
    if (source === 'uploads') {
      try {
        src = await readFile(join(deps.config.dataDir, 'uploads', name))
      } catch {
        return c.json({ error: '图片不存在' }, 404)
      }
    } else if (source === 'comfy') {
      if (!deps.comfy) return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      let buf: ArrayBuffer | null
      try {
        buf = await deps.comfy.getInputImage(name)
      } catch {
        return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      }
      if (!buf) return c.json({ error: '图片不存在' }, 404)
      src = Buffer.from(buf)
    } else if (source === 'comfy-output') {
      if (!outputClient) return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      let buf: ArrayBuffer | null
      try {
        buf = await outputClient.getOutputImage(name)
      } catch {
        return c.json({ error: 'ComfyUI 离线,无法读取 GPU 侧图片' }, 503)
      }
      if (!buf) return c.json({ error: '图片不存在' }, 404)
      src = Buffer.from(buf)
    } else {
      // source validation at the top ensures this is unreachable
      return c.json({ error: 'source 非法' }, 400)
    }

    let out: Buffer
    try {
      out = await sharp(src)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer()
    } catch {
      return c.json({ error: '无法解码为图片' }, 415)
    }
    mkdirSync(cacheDir, { recursive: true })
    await writeFile(cachePath, out)
    c.header('Content-Type', 'image/webp')
    c.header('Cache-Control', 'max-age=86400')
    return c.body(Readable.toWeb(Readable.from(out)) as ReadableStream)
  })

  return app
}
