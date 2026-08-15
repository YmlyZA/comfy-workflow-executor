import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { FakeComfy } from './fake-comfy.js'

let db: Db
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

beforeEach(() => {
  db = createDb(':memory:')
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db,
    comfy: null,
    events: new EventEmitter(),
  })
})

const templateBody = {
  name: 'T',
  comfyJson: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } },
  params: [{ key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' }],
}

async function createTemplate() {
  const res = await app.request('/api/templates', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(templateBody),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number }
}

describe('templates routes', () => {
  it('POST validates body', async () => {
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST/GET/DELETE roundtrip', async () => {
    const t = await createTemplate()
    let list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list).toHaveLength(1)
    const del = await app.request(`/api/templates/${t.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list).toHaveLength(0)
  })

  it('DELETE returns 409 when template has batches', async () => {
    const t = await createTemplate()
    const create = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    expect(create.status).toBe(201)
    const res = await app.request(`/api/templates/${t.id}`, { method: 'DELETE', headers: H })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'template has batches' })
  })
})

describe('PATCH /api/templates/order', () => {
  it('重排后 GET 按新顺序返回', async () => {
    const a = await createTemplate()
    const res2 = await app.request('/api/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...templateBody, name: 'T2' }),
    })
    const b = (await res2.json()) as { id: number }
    const patch = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [b.id, a.id] }),
    })
    expect(patch.status).toBe(200)
    const list = (await (await app.request('/api/templates', { headers: H })).json()) as any[]
    expect(list.map((t) => t.id)).toEqual([b.id, a.id])
  })

  it('非法 body 400, 未知 id 404, 不完整 400', async () => {
    const a = await createTemplate()
    const bad = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: 'x' }),
    })
    expect(bad.status).toBe(400)
    const unknown = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [a.id, 999] }),
    })
    expect(unknown.status).toBe(404)
    const incomplete = await app.request('/api/templates/order', {
      method: 'PATCH', headers: H, body: JSON.stringify({ ids: [] }),
    })
    expect(incomplete.status).toBe(400)
  })
})

describe('PATCH /api/templates/:id', () => {
  it('改名成功,返回新名且列表可见', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '新名字' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('新名字')
    const list = (await (await app.request('/api/templates', { headers: H })).json()) as Array<{ name: string }>
    expect(list[0]!.name).toBe('新名字')
  })

  it('未知 id 404', async () => {
    const res = await app.request('/api/templates/999', {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('空名 400', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('batches routes', () => {
  it('creates batch with jobs and reads detail', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }, { prompt: 'b' }] }),
    })
    expect(res.status).toBe(201)
    const batch = (await res.json()) as { id: number }

    const listRes = await app.request('/api/batches', { headers: H })
    const list = (await listRes.json()) as any[]
    expect(list[0]).toMatchObject({ templateName: 'T', total: 2 })

    const detailRes = await app.request(`/api/batches/${batch.id}`, { headers: H })
    const detail = (await detailRes.json()) as any
    expect(detail.jobs).toHaveLength(2)
    expect(detail.template.name).toBe('T')
  })

  it('404 on unknown template/batch', async () => {
    const r1 = await app.request('/api/templates/999/batches', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    expect(r1.status).toBe(404)
    const r2 = await app.request('/api/batches/999', { headers: H })
    expect(r2.status).toBe(404)
  })

  it('cancel and retry-failed endpoints work', async () => {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const batch = (await res.json()) as { id: number }
    const cancel = await app.request(`/api/batches/${batch.id}/cancel`, { method: 'POST', headers: H })
    expect(cancel.status).toBe(200)
    const detail = (await (await app.request(`/api/batches/${batch.id}`, { headers: H })).json()) as any
    expect(detail.batch.status).toBe('canceled')
    const retry = await app.request(`/api/batches/${batch.id}/retry-failed`, { method: 'POST', headers: H })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ retried: 0 })
  })
})

describe('GET /api/batches/:id nav', () => {
  async function createBatchOn(templateId: number, name: string): Promise<number> {
    const res = await app.request(`/api/templates/${templateId}/batches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name, jobs: [{ prompt: 'x' }] }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: number }).id
  }

  async function navOf(id: number) {
    const res = await app.request(`/api/batches/${id}`, { headers: H })
    expect(res.status).toBe(200)
    return ((await res.json()) as { nav: { prevId: number | null; nextId: number | null } }).nav
  }

  it('中间/首/尾 batch 的 prevId/nextId 正确', async () => {
    const t = await createTemplate()
    const a = await createBatchOn(t.id, 'a')
    const b = await createBatchOn(t.id, 'b')
    const c = await createBatchOn(t.id, 'c')
    expect(await navOf(b)).toEqual({ prevId: a, nextId: c })
    expect(await navOf(a)).toEqual({ prevId: null, nextId: b })
    expect(await navOf(c)).toEqual({ prevId: b, nextId: null })
  })

  it('单 batch 双 null', async () => {
    const t = await createTemplate()
    const only = await createBatchOn(t.id, 'only')
    expect(await navOf(only)).toEqual({ prevId: null, nextId: null })
  })
})

describe('GET /api/uploads', () => {
  it('目录不存在返回空;有文件按修改时间倒序且跳过子目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-ls-'))
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: createDb(':memory:'), comfy: null, events: new EventEmitter(),
    })
    expect(await (await localApp.request('/api/uploads', { headers: H })).json()).toEqual({ files: [] })

    const dir = join(dataDir, 'uploads')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), 'x')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'a.png'), past, past)
    writeFileSync(join(dir, 'b.png'), 'y')
    mkdirSync(join(dir, 'sub'))
    const res = (await (await localApp.request('/api/uploads', { headers: H })).json()) as { files: string[] }
    expect(res.files).toEqual(['b.png', 'a.png'])
  })
})

describe('DELETE /api/batches/:id', () => {
  async function makeBatch() {
    const t = await createTemplate()
    const res = await app.request(`/api/templates/${t.id}/batches`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    return (await res.json()) as { id: number }
  }

  it('删除 pending batch 及其 jobs', async () => {
    const b = await makeBatch()
    const del = await app.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    expect((await app.request(`/api/batches/${b.id}`, { headers: H })).status).toBe(404)
  })

  it('running batch 返回 409', async () => {
    const b = await makeBatch()
    // 直接用 repo 把 batch 置为 running(模拟执行器认领)
    const { claimNextJob } = await import('../src/db/repo.js')
    claimNextJob(db, 1)
    const del = await app.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(409)
    expect(await del.json()).toEqual({ error: 'batch is running' })
  })

  it('未知 id 404', async () => {
    const del = await app.request('/api/batches/999', { method: 'DELETE', headers: H })
    expect(del.status).toBe(404)
  })

  it('purgeOutputs=1 时清理输出目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-del-'))
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: localDb, comfy: null, events: new EventEmitter(),
    })
    const t = await localApp.request('/api/templates', {
      method: 'POST', headers: H, body: JSON.stringify(templateBody),
    })
    const tid = ((await t.json()) as { id: number }).id
    const bRes = await localApp.request(`/api/templates/${tid}/batches`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const bid = ((await bRes.json()) as { id: number }).id
    const outDir = join(dataDir, 'outputs', String(bid))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'x.png'), 'png')
    const del = await localApp.request(`/api/batches/${bid}?purgeOutputs=1`, {
      method: 'DELETE', headers: H,
    })
    expect(del.status).toBe(200)
    expect(existsSync(outDir)).toBe(false)
  })

  it('不带 purgeOutputs 时输出目录保留', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cwe-keep-'))
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
      db: localDb, comfy: null, events: new EventEmitter(),
    })
    const t = await localApp.request('/api/templates', {
      method: 'POST', headers: H, body: JSON.stringify(templateBody),
    })
    const tid = ((await t.json()) as { id: number }).id
    const bRes = await localApp.request(`/api/templates/${tid}/batches`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: 'B', jobs: [{ prompt: 'a' }] }),
    })
    const bid = ((await bRes.json()) as { id: number }).id
    const outDir = join(dataDir, 'outputs', String(bid))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'x.png'), 'png')
    const del = await localApp.request(`/api/batches/${bid}`, { method: 'DELETE', headers: H })
    expect(del.status).toBe(200)
    expect(existsSync(outDir)).toBe(true)
  })
})

describe('DELETE /api/batches/:id purgeGpu', () => {
  function makeComfyApp() {
    const comfy = new FakeComfy()
    const localDb = createDb(':memory:')
    // 盖章要落到「当前 active 主机」才能让 purgeGpu 分组归 null 组、直接走 deps.comfy
    const host = repo.ensureActiveHost(localDb, 'http://local:8188')
    const localDeps: AppDeps = {
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db: localDb,
      comfy,
      events: new EventEmitter(),
    }
    const localApp = createApp(localDeps)
    return { comfy, localDb, localApp, localDeps, host }
  }

  /** 建一个跳过默认种子主机的干净 db(用于测试用例自己掌控主机拓扑) */
  function makeComfyAppNoHost() {
    const comfy = new FakeComfy()
    const localDb = createDb(':memory:')
    const localDeps: AppDeps = {
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db: localDb,
      comfy,
      events: new EventEmitter(),
    }
    const localApp = createApp(localDeps)
    return { comfy, localDb, localApp, localDeps }
  }

  /** 建一个已完成 batch:job0 两个输出同 gpu 引用(测去重),job1 一个无引用输出(测跳过) */
  function seedFinished(localDb: Db, hostId: number) {
    const t = repo.createTemplate(localDb, {
      name: 'T',
      comfyJson: templateBody.comfyJson,
      params: templateBody.params as any,
    })
    const b = repo.createBatch(localDb, t.id, { name: 'B', jobs: [{ prompt: 'a' }, { prompt: 'b' }] })
    const c1 = repo.claimNextJob(localDb, hostId)!
    repo.finishJob(localDb, c1.job.id, [
      { path: `${b.id}/0-0-a.png`, filename: '0-0-a.png', gpu: { filename: 'a.png', subfolder: 'sub' } },
      { path: `${b.id}/0-1-b.png`, filename: '0-1-b.png', gpu: { filename: 'a.png', subfolder: 'sub' } },
    ])
    const c2 = repo.claimNextJob(localDb, hostId)!
    repo.finishJob(localDb, c2.job.id, [{ path: `${b.id}/1-0-old.png`, filename: '1-0-old.png' }])
    repo.markBatchCompletedIfDone(localDb, b.id)
    return b
  }

  it('收集引用去重传给扩展,无引用输出计入 gpuSkipped', async () => {
    const { comfy, localDb, localApp, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, gpuSkipped: 1 })
    expect(comfy.cweDeleted).toEqual([[{ filename: 'a.png', subfolder: 'sub' }]])
  })

  it('删除与主机切换共锁串行:锁被占用时排队,释放后才执行', async () => {
    const { comfy, localDb, localApp, localDeps, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    void localDeps.switchLock!.run(() => gate) // 模拟一次进行中的主机切换
    let done = false
    const p = Promise.resolve(
      localApp.request(`/api/batches/${b.id}?purgeGpu=1`, { method: 'DELETE', headers: H }),
    ).then((r) => {
      done = true
      return r
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(done).toBe(false) // 删除被挡在临界区外
    expect(comfy.cweDeleted).toEqual([])
    release()
    expect((await p).status).toBe(200)
    expect(comfy.cweDeleted).toEqual([[{ filename: 'a.png', subfolder: 'sub' }]])
  }, 15000)

  it('扩展调用抛错时 gpuPurgeFailed 且 batch 已删', async () => {
    const { comfy, localDb, localApp, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    comfy.cweDeleteOutputFiles = async () => {
      throw new Error('extension missing')
    }
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    const body = (await res.json()) as any
    expect(body.gpuPurgeFailed).toBe(true)
    expect((await localApp.request(`/api/batches/${b.id}`, { headers: H })).status).toBe(404)
  })

  it('扩展返回 failed 非空时 gpuPurgeFailed', async () => {
    const { comfy, localDb, localApp, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    comfy.cweDeleteResult = { deleted: 0, missing: 0, failed: ['sub/a.png'] }
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(((await res.json()) as any).gpuPurgeFailed).toBe(true)
  })

  it('全部输出无 gpu 引用时不调扩展', async () => {
    const { comfy, localDb, localApp, host } = makeComfyApp()
    const t = repo.createTemplate(localDb, {
      name: 'T2',
      comfyJson: templateBody.comfyJson,
      params: templateBody.params as any,
    })
    const b = repo.createBatch(localDb, t.id, { name: 'B2', jobs: [{ prompt: 'a' }] })
    const c1 = repo.claimNextJob(localDb, host.id)!
    repo.finishJob(localDb, c1.job.id, [{ path: `${b.id}/0-0-x.png`, filename: '0-0-x.png' }])
    repo.markBatchCompletedIfDone(localDb, b.id)
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(await res.json()).toEqual({ ok: true, gpuSkipped: 1 })
    expect(comfy.cweDeleted).toHaveLength(0)
  })

  it('不带 purgeGpu 时不收集也不调扩展', async () => {
    const { comfy, localDb, localApp, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    const res = await localApp.request(`/api/batches/${b.id}`, { method: 'DELETE', headers: H })
    expect(await res.json()).toEqual({ ok: true })
    expect(comfy.cweDeleted).toHaveLength(0)
  })

  it('comfy 未配置且有引用时 gpuPurgeFailed', async () => {
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db: localDb,
      comfy: null,
      events: new EventEmitter(),
    })
    const b = seedFinished(localDb, 1)
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(((await res.json()) as any).gpuPurgeFailed).toBe(true)
  })

  it('cancel 已结束的 batch 返回 409 且状态不被改写', async () => {
    const { localDb, localApp, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    expect(repo.getBatchStatus(localDb, b.id)).toBe('completed')
    const res = await localApp.request(`/api/batches/${b.id}/cancel`, { method: 'POST', headers: H })
    expect(res.status).toBe(409)
    expect(repo.getBatchStatus(localDb, b.id)).toBe('completed')
  })

  it('扩展返回 missing 时上报 gpuMissing(不再静默当成功)', async () => {
    const { comfy, localDb, localApp, host } = makeComfyApp()
    const b = seedFinished(localDb, host.id)
    comfy.cweDeleteResult = { deleted: 0, missing: 1, failed: [] }
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    const body = (await res.json()) as any
    expect(body.gpuMissing).toBe(1)
    expect(body.gpuPurgeFailed).toBeUndefined()
  })

  /** 跑在不同主机的 job:引用按 hostId 分组,发给各自主机(当前主机复用现有连接,其余按表里 URL 建临时 client) */
  it('多主机批次:引用按执行主机分组发送', async () => {
    const comfy = new FakeComfy()
    const remoteFakes: Record<string, FakeComfy> = { 'http://h1:8188': new FakeComfy() }
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db: localDb,
      comfy,
      events: new EventEmitter(),
      comfyFactory: (url: string) => remoteFakes[url]!,
    })
    const h1 = repo.ensureActiveHost(localDb, 'http://h1:8188')
    const h2 = repo.createHost(localDb, { name: 'H2', url: 'http://h2:8188' })
    const t = repo.createTemplate(localDb, {
      name: 'T',
      comfyJson: templateBody.comfyJson,
      params: templateBody.params as any,
    })
    const b = repo.createBatch(localDb, t.id, { name: 'B', jobs: [{ prompt: 'a' }, { prompt: 'b' }] })
    const c1 = repo.claimNextJob(localDb, h1.id)! // 盖 h1 章
    repo.finishJob(localDb, c1.job.id, [
      { path: `${b.id}/0-0-a.png`, filename: '0-0-a.png', gpu: { filename: 'a.png', subfolder: '' } },
    ])
    repo.activateHost(localDb, h2.id)
    const c2 = repo.claimNextJob(localDb, h2.id)! // 盖 h2 章(现为 active,对应 deps.comfy)
    repo.finishJob(localDb, c2.job.id, [
      { path: `${b.id}/1-0-b.png`, filename: '1-0-b.png', gpu: { filename: 'b.png', subfolder: '' } },
    ])
    repo.markBatchCompletedIfDone(localDb, b.id)
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ ok: true })
    // h2 是当前主机 → 走 deps.comfy;h1 → 工厂按表里 URL 建 client
    expect(comfy.cweDeleted).toEqual([[{ filename: 'b.png', subfolder: '' }]])
    expect(remoteFakes['http://h1:8188']!.cweDeleted).toEqual([
      [{ filename: 'a.png', subfolder: '' }],
    ])
    void h1
  })

  it('执行主机已被删除的分组标记 gpuPurgeFailed', async () => {
    const { comfy, localDb, localApp } = makeComfyAppNoHost()
    const h1 = repo.ensureActiveHost(localDb, 'http://h1:8188')
    const h2 = repo.createHost(localDb, { name: 'H2', url: 'http://h2:8188' })
    const t = repo.createTemplate(localDb, {
      name: 'T',
      comfyJson: templateBody.comfyJson,
      params: templateBody.params as any,
    })
    const b = repo.createBatch(localDb, t.id, { name: 'B', jobs: [{ prompt: 'a' }] })
    const c1 = repo.claimNextJob(localDb, h1.id)! // 盖 h1 章
    repo.finishJob(localDb, c1.job.id, [
      { path: `${b.id}/0-0-a.png`, filename: '0-0-a.png', gpu: { filename: 'a.png', subfolder: '' } },
    ])
    repo.markBatchCompletedIfDone(localDb, b.id)
    repo.activateHost(localDb, h2.id)
    expect(repo.deleteHost(localDb, h1.id)).toBe('ok') // h1 悬挂
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    const body = (await res.json()) as any
    expect(body.gpuPurgeFailed).toBe(true)
    expect(comfy.cweDeleted).toHaveLength(0) // 不会错发到当前主机
  })
})
