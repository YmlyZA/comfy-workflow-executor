import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { ConvertError, convertGraphToApi, type GraphJson } from '../comfy/graph-convert.js'
import { ObjectInfoCache } from '../comfy/object-info-cache.js'
import type { ObjectInfoMap } from '../comfy/client.js'
import { enumOptions, validateApiJson } from '../comfy/validate.js'
import { imageSize } from 'image-size'

export function comfyRoutes(deps: AppDeps) {
  const app = new Hono()
  const cache = deps.comfy ? new ObjectInfoCache(deps.comfy) : null

  /** 离线/未配置时返回 null,由各端点决定降级方式 */
  async function objectInfo(refresh: boolean): Promise<ObjectInfoMap | null> {
    if (!cache) return null
    try {
      return await cache.get(refresh)
    } catch {
      return null
    }
  }

  app.post('/convert', async (c) => {
    const graph = (await c.req.json()) as GraphJson
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
      return c.json({ error: '不是 UI 格式的 workflow JSON(缺少 nodes/links)' }, 400)
    }
    if (!graph.nodes.every((n) => n && typeof n === 'object' && !Array.isArray(n))) {
      return c.json({ error: 'workflow JSON 的 nodes 含非法元素' }, 400)
    }
    const info = await objectInfo(c.req.query('refresh') === '1')
    if (!info) return c.json({ error: 'UI 格式转换需要 ComfyUI 在线' }, 503)
    try {
      return c.json({ comfyJson: convertGraphToApi(graph, info) })
    } catch (err) {
      if (err instanceof ConvertError) {
        return c.json({ error: err.message, missingTypes: err.missingTypes }, 422)
      }
      throw err
    }
  })

  app.post('/validate', async (c) => {
    const comfyJson = (await c.req.json()) as Record<string, any>
    const info = await objectInfo(false)
    if (!info) return c.json({ skipped: true, warnings: [], enumInputs: [] })
    return c.json({ skipped: false, ...validateApiJson(comfyJson, info) })
  })

  app.get('/input-options', async (c) => {
    const classType = c.req.query('classType') ?? ''
    const inputName = c.req.query('inputName') ?? ''
    const info = await objectInfo(c.req.query('refresh') === '1')
    if (!info) return c.json({ error: 'ComfyUI 离线,无法获取可选值' }, 503)
    const options = enumOptions(info, classType, inputName)
    if (!options) return c.json({ error: `${classType}.${inputName} 不是枚举输入` }, 404)
    return c.json({ options })
  })

  /** GPU 主机 input 目录文件清单(借 LoadImage 的 COMBO 选项);enum 语义不受影响 */
  app.get('/input-files', async (c) => {
    const info = await objectInfo(c.req.query('refresh') === '1')
    if (!info) return c.json({ error: 'ComfyUI 离线,无法获取输入文件列表' }, 503)
    const spec = info.LoadImage?.input?.required?.image
    const files = Array.isArray(spec?.[0]) ? (spec[0] as unknown[]).map(String) : []
    return c.json({ files })
  })

  /** 图片尺寸探测:uploads 本地优先,回退 GPU 侧;与执行器存在性回退同语义 */
  app.get('/image-dims', async (c) => {
    const name = c.req.query('name') ?? ''
    if (!name) return c.json({ error: '缺少 name 参数' }, 400)
    let bytes: Uint8Array | null = null
    const local = join(deps.config.dataDir, 'uploads', name)
    if (!name.includes('..') && !isAbsolute(name) && existsSync(local)) {
      bytes = await readFile(local)
    } else if (deps.comfy) {
      try {
        const buf = await deps.comfy.getInputImage(name)
        if (buf) bytes = new Uint8Array(buf)
      } catch {
        return c.json({ error: 'ComfyUI 离线,无法探测 GPU 侧图片尺寸' }, 503)
      }
    } else {
      return c.json({ error: 'ComfyUI 离线,无法探测 GPU 侧图片尺寸' }, 503)
    }
    if (!bytes) return c.json({ error: '图片不存在' }, 404)
    try {
      const dims = imageSize(bytes)
      if (!dims.width || !dims.height) throw new Error('no dims')
      return c.json({ width: dims.width, height: dims.height })
    } catch {
      return c.json({ error: '无法解析图片尺寸' }, 404)
    }
  })

  return app
}
