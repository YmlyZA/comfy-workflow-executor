import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Hono } from 'hono'
import { createBatchSchema, createTemplateSchema, renameTemplateSchema } from '@cwe/shared'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function templateRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listTemplates(deps.db)))

  app.patch('/order', async (c) => {
    const body = (await c.req.json()) as { ids?: unknown }
    const ids =
      Array.isArray(body?.ids) && body.ids.every((n): n is number => typeof n === 'number')
        ? body.ids
        : null
    if (!ids) return c.json({ error: 'ids 必须是数字数组' }, 400)
    const res = repo.reorderTemplates(deps.db, ids)
    if (res === 'unknown-id') return c.json({ error: '包含不存在的模板 id' }, 404)
    if (res === 'incomplete') return c.json({ error: 'ids 必须包含全部模板且不重复' }, 400)
    return c.json({ ok: true })
  })

  app.patch('/:id', async (c) => {
    const { name } = renameTemplateSchema.parse(await c.req.json())
    const t = repo.renameTemplate(deps.db, Number(c.req.param('id')), name)
    if (!t) return c.json({ error: 'template not found' }, 404)
    return c.json(t)
  })

  app.post('/', async (c) => {
    const input = createTemplateSchema.parse(await c.req.json())
    return c.json(repo.createTemplate(deps.db, input), 201)
  })

  app.delete('/:id', (c) => {
    try {
      repo.deleteTemplate(deps.db, Number(c.req.param('id')))
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')) {
        return c.json({ error: 'template has batches' }, 409)
      }
      throw err
    }
  })

  app.post('/:id/batches', async (c) => {
    const id = Number(c.req.param('id'))
    const template = repo.getTemplate(deps.db, id)
    if (!template) return c.json({ error: 'template not found' }, 404)
    const input = createBatchSchema.parse(await c.req.json())
    // 引用 GPU 侧已有文件(本地 uploads 没有)的任务搬不到别的主机,把整批锁到参考主机。
    // 判据与 executor.execute 的取值逻辑保持一致:本地有就上传、没有才原样引用。
    const referencesGpuFile = template.params
      .filter((p) => p.type === 'image')
      .some((def) =>
        input.jobs.some((job) => {
          const v = job[def.key] ?? def.default
          if (typeof v !== 'string' || !v) return false
          if (v.includes('..') || isAbsolute(v)) return true
          return !existsSync(join(deps.config.dataDir, 'uploads', v))
        }),
      )
    // 锁定目标只能是参考主机(GPU 侧文件列表就是从它那儿列出来的,文件也只在它上面),
    // 即使它此刻没在参与调度也照锁不误:换锁别的主机等于锁到一台没有这些文件的机器上,
    // 每个任务都会失败。参考主机被熔断停用时,这批任务是「等它恢复」而不是「跑不了」,
    // 但绝不能让前端继续说「将只在该主机执行」——建批响应带着 pinnedHostId,
    // 前端用 pinnedHostNotice() 按该主机的实时状态给出如实提示(批次详情页也有横幅)
    const pinnedHostId = referencesGpuFile ? (repo.getActiveHost(deps.db)?.id ?? null) : null
    const batch = repo.createBatch(deps.db, id, input, pinnedHostId)
    // 输入历史记录失败不影响建批
    try {
      const textKeys = template.params.filter((p) => p.type === 'text').map((p) => p.key)
      repo.recordInputHistory(deps.db, textKeys, input.jobs, deps.config.inputHistoryLimit)
    } catch (err) {
      console.error('record input history failed', err)
    }
    deps.events.emit('event', { type: 'batch-updated', batchId: batch.id, status: batch.status })
    return c.json(batch, 201)
  })

  return app
}
