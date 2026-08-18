import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { ExecutorPool } from '../src/executor-pool.js'
import { FakeComfy } from './fake-comfy.js'

const authHeaders = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

/** 造一套互相隔离的 app/db/pool:真实 ExecutorPool + FakeComfy(不打真实网络),鉴权头见
 * authHeaders。每个用例各自调用一次,互不共享状态(不再需要 beforeEach)。 */
function setupApp() {
  const db: Db = createDb(':memory:')
  const config = loadConfig({ AUTH_TOKEN: 'secret' })
  const events = new EventEmitter()
  const pool = new ExecutorPool({
    db,
    events,
    dataDir: config.dataDir,
    comfyFactory: () => new FakeComfy(),
  })
  const deps: AppDeps = { config, db, comfy: new FakeComfy(), events, executor: pool }
  const app = createApp(deps)
  return { app, db, pool, deps }
}

const req = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.request(`/api/hosts${path}`, {
    method,
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/** 直接占住切换锁,制造"一次切换还没做完"的排队窗口。新架构下 activate/disable 不再
 * 经手 pauseAll,没法再靠 mock pauseAll 卡点;直接占锁与被测代码的临界区实现无关,
 * 只要 handler 仍然 `lock.run(...)` 就能验证串行化。 */
function holdSwitchLock(deps: AppDeps): () => void {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  void deps.switchLock!.run(() => gate)
  return release
}

describe('hosts CRUD', () => {
  it('创建:url 去尾斜杠;非 http 前缀 400', async () => {
    const { app } = setupApp()
    const res = await req(app, 'POST', '', { name: 'A', url: 'http://a:8188//' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).host.url).toBe('http://a:8188')
    expect((await req(app, 'POST', '', { name: 'B', url: 'a:8188' })).status).toBe(400)
  })

  it('单价 0 是合法输入(自有机器记时长不记钱),不该被 400 掉', async () => {
    const { app } = setupApp()
    const res = await req(app, 'POST', '', {
      name: 'A',
      url: 'http://a:8188',
      kind: 'rental',
      hourlyRate: 0,
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).host.hourlyRate).toBe(0)
  })

  it('删 active 409;删普通 ok', async () => {
    const { app, db } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    expect((await req(app, 'DELETE', `/${a.id}`)).status).toBe(409)
    expect((await req(app, 'DELETE', `/${b.id}`)).status).toBe(200)
  })

  it('删参考主机 409 时不停它的 worker(先确认删得掉,再动 worker)', async () => {
    const { app, db, pool } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    pool.syncFromDb()
    expect(pool.hasWorker(a.id)).toBe(true)
    const res = await req(app, 'DELETE', `/${a.id}`)
    expect(res.status).toBe(409)
    // 回归点:旧实现会先 stopWorker 再判断 active,409 之后 worker 永久消失、
    // 没有任何路径把它救回来(见 review)
    expect(pool.hasWorker(a.id)).toBe(true)
  })

  it('非数字 :id 返回 400', async () => {
    const { app, db } = setupApp()
    repo.ensureActiveHost(db, 'http://a:8188')
    expect((await req(app, 'PATCH', '/abc', { name: 'X' })).status).toBe(400)
    expect((await req(app, 'DELETE', '/abc')).status).toBe(400)
    expect((await req(app, 'POST', '/abc/activate')).status).toBe(400)
    expect((await req(app, 'POST', '/abc/disable', { mode: 'wait' })).status).toBe(400)
  })
})

describe('参与调度开关', () => {
  it('disable 端点停用主机并停 worker', async () => {
    const { app, db, pool } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    const res = await app.request(`/api/hosts/${host.id}/disable`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'wait' }),
    })
    expect(res.status).toBe(200)
    expect(repo.getHost(db, host.id)!.enabled).toBe(0)
    expect(pool.hasWorker(host.id)).toBe(false)
  })

  it('disable interrupt 模式放弃在跑任务(abandon),host 不存在 404', async () => {
    const { app, db, pool } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    pool.syncFromDb()
    const stopSpy = vi.spyOn(pool, 'stopWorker')
    const res = await app.request(`/api/hosts/${host.id}/disable`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'interrupt' }),
    })
    expect(res.status).toBe(200)
    expect(stopSpy).toHaveBeenCalledWith(host.id, { abandon: true })
    expect((await req(app, 'POST', '/9999/disable', { mode: 'interrupt' })).status).toBe(404)
  })

  it('PATCH enabled=true 重新启用并清空停用原因', async () => {
    const { app, db, pool } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    repo.setHostEnabled(db, host.id, false, '连续 3 次任务失败')
    const res = await app.request(`/api/hosts/${host.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const after = repo.getHost(db, host.id)!
    expect(after.enabled).toBe(1)
    expect(after.disabledReason).toBeNull()
    expect(pool.hasWorker(host.id)).toBe(true)
  })

  it('disable 的 stopWorker 等待不占着切换锁:并发的其他主机 PATCH 不会被卡住', async () => {
    const { app, db, pool } = setupApp()
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    pool.syncFromDb()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // 模拟 A 正跑着一个很久的 GPU 任务:stopWorker 卡在 gate 上不返回
    const stopSpy = vi.spyOn(pool, 'stopWorker').mockImplementation(() => gate)

    const pDis = app.request(`/api/hosts/${a.id}/disable`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 'wait' }),
    })
    // disable 的 db 变更在锁内很快做完,不用等 stopWorker 就已经落地
    await vi.waitFor(() => expect(repo.getHost(db, a.id)!.enabled).toBe(0))

    // 若切换锁还被 disable 占着(stopWorker 没挪到锁外),这个请求要等到 release() 才有响应;
    // 用 holdSwitchLock 已确认过锁的排队机制,这里改用真实并发请求 + 有限等待验证它没被卡住
    const patchDone = await Promise.race([
      Promise.resolve(req(app, 'PATCH', `/${b.id}`, { name: 'B2' })).then(() => 'resolved' as const),
      new Promise((r) => setTimeout(r, 300)).then(() => 'timeout' as const),
    ])
    expect(patchDone).toBe('resolved')
    expect(repo.getHost(db, b.id)?.name).toBe('B2')

    release()
    expect((await pDis).status).toBe(200)
    expect(stopSpy).toHaveBeenCalledWith(a.id, undefined)
  })

  it('DELETE 的 stopWorker 等待不占着切换锁:并发的其他主机 PATCH 不会被卡住', async () => {
    const { app, db, pool } = setupApp()
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    pool.syncFromDb()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const stopSpy = vi.spyOn(pool, 'stopWorker').mockImplementation(() => gate)

    const pDel = req(app, 'DELETE', `/${a.id}`)
    // delete 的 db 变更(判活 + 删行)在锁内很快做完,不用等 stopWorker
    await vi.waitFor(() => expect(repo.getHost(db, a.id)).toBeUndefined())

    const patchDone = await Promise.race([
      Promise.resolve(req(app, 'PATCH', `/${b.id}`, { name: 'B2' })).then(() => 'resolved' as const),
      new Promise((r) => setTimeout(r, 300)).then(() => 'timeout' as const),
    ])
    expect(patchDone).toBe('resolved')

    release()
    expect((await pDel).status).toBe(200)
    expect(stopSpy).toHaveBeenCalledWith(a.id)
  })
})

describe('主机列表附带在线与锁定信息', () => {
  it('online 取自 monitor 快照,pinnedBatches 为未完成锁定批次数', async () => {
    const { app, db } = setupApp()
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const tpl = repo.createTemplate(db, {
      name: 't',
      comfyJson: { '1': { class_type: 'X', inputs: {} } },
      params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
    })
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] }, host.id)
    const res = await app.request('/api/hosts', { headers: authHeaders })
    const body = (await res.json()) as any
    expect(body.hosts[0].pinnedBatches).toBe(1)
    expect(body.hosts[0]).toHaveProperty('online')
  })
})

describe('activate 简化', () => {
  it('无请求体即可切换参考主机,且不停 worker', async () => {
    const { app, db, pool } = setupApp()
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    repo.activateHost(db, a.id)
    pool.syncFromDb()
    const before = pool.size()
    const res = await app.request(`/api/hosts/${b.id}/activate`, {
      method: 'POST',
      headers: authHeaders,
    })
    expect(res.status).toBe(200)
    expect(repo.getActiveHost(db)!.id).toBe(b.id)
    expect(pool.size()).toBe(before)
  })

  it('切换后发送 comfy-status 事件', async () => {
    const { app, db, deps } = setupApp()
    repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await app.request(`/api/hosts/${b.id}/activate`, {
      method: 'POST',
      headers: authHeaders,
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ hostId: b.id, hostName: 'B' })
  })

  it('已 active 幂等:不重连、不发事件;目标不存在 404', async () => {
    const { app, db, deps } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await app.request(`/api/hosts/${a.id}/activate`, {
      method: 'POST',
      headers: authHeaders,
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(0)
    expect((await req(app, 'POST', '/9999/activate')).status).toBe(404)
  })
})

describe('并发切换串行化', () => {
  it('两个 activate 排队:先到先执行,最终落在后者', async () => {
    const { app, db, deps } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const c = repo.createHost(db, { name: 'C', url: 'http://c:8188' })
    const release = holdSwitchLock(deps)

    const p1 = app.request(`/api/hosts/${b.id}/activate`, { method: 'POST', headers: authHeaders })
    await new Promise((r) => setTimeout(r, 30))
    const p2 = app.request(`/api/hosts/${c.id}/activate`, { method: 'POST', headers: authHeaders })
    await new Promise((r) => setTimeout(r, 30))
    // 两个请求都被锁挡在临界区外:active 还是最初的 a
    expect(repo.getActiveHost(db)?.id).toBe(a.id)

    release()
    expect((await p1).status).toBe(200)
    expect((await p2).status).toBe(200)
    expect(repo.getActiveHost(db)?.id).toBe(c.id)
  }, 15000)

  it('改参考主机 URL 与 activate 并发时共享同一把锁,不交错', async () => {
    const { app, db, deps } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const release = holdSwitchLock(deps)

    const p1 = req(app, 'PATCH', `/${a.id}`, { url: 'http://a2:8188' })
    const p2 = app.request(`/api/hosts/${b.id}/activate`, { method: 'POST', headers: authHeaders })
    await new Promise((r) => setTimeout(r, 30))
    expect(repo.getHost(db, a.id)?.url).toBe('http://a:8188')

    release()
    await Promise.all([p1, p2])
    expect(repo.getHost(db, a.id)?.url).toBe('http://a2:8188')
    expect(repo.getActiveHost(db)?.id).toBe(b.id)
  }, 15000)

  it('删除与切换串行:目标切换在途时删除排队,轮到时因已 active 被 409', async () => {
    const { app, db, deps } = setupApp()
    repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const release = holdSwitchLock(deps)

    const p1 = app.request(`/api/hosts/${b.id}/activate`, { method: 'POST', headers: authHeaders })
    await new Promise((r) => setTimeout(r, 30))
    const p2 = req(app, 'DELETE', `/${b.id}`)
    await new Promise((r) => setTimeout(r, 30))
    // 删除被锁挡在切换临界区外:b 仍然存在
    expect(repo.getHost(db, b.id)).toBeDefined()

    release()
    expect((await p1).status).toBe(200)
    expect((await p2).status).toBe(409) // 排到删除时 b 已成为 active
  }, 15000)

  it('activate 排队期间目标被删除:锁内重查返回 404', async () => {
    const { app, db, deps } = setupApp()
    repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    const release = holdSwitchLock(deps)

    const p = app.request(`/api/hosts/${b.id}/activate`, { method: 'POST', headers: authHeaders })
    await new Promise((r) => setTimeout(r, 30))
    repo.deleteHost(db, b.id) // 排队期间目标主机被删
    release()
    expect((await p).status).toBe(404)
    expect(repo.getActiveHost(db)?.id).not.toBe(b.id)
  }, 15000)
})

describe('PATCH', () => {
  it('改名不触发 worker 重建或重连事件', async () => {
    const { app, db, pool, deps } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    pool.syncFromDb()
    const restartSpy = vi.spyOn(pool, 'restartWorker')
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await req(app, 'PATCH', `/${a.id}`, { name: 'A2' })
    expect(res.status).toBe(200)
    expect(restartSpy).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('改参考主机 URL:重建该 worker 并重连查询 client', async () => {
    const { app, db, pool, deps } = setupApp()
    const a = repo.ensureActiveHost(db, 'http://a:8188')
    pool.syncFromDb()
    const restartSpy = vi.spyOn(pool, 'restartWorker')
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await req(app, 'PATCH', `/${a.id}`, { url: 'http://a2:8188' })
    expect(res.status).toBe(200)
    expect(restartSpy).toHaveBeenCalledWith(a.id)
    expect(repo.getHost(db, a.id)?.url).toBe('http://a2:8188')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ hostId: a.id })
  })

  it('改 URL 的 worker 重建不占着切换锁:并发的其他主机 PATCH 不会被卡住', async () => {
    const { app, db, pool } = setupApp()
    const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    pool.syncFromDb()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // 模拟 A 正跑着一个很久的 GPU 任务:restartWorker 里的 pause() 卡住不返回
    const restartSpy = vi.spyOn(pool, 'restartWorker').mockImplementation(() => gate)

    const pPatch = req(app, 'PATCH', `/${a.id}`, { url: 'http://a2:8188' })
    // 改行在锁内很快做完,不用等 worker 重建
    await vi.waitFor(() => expect(repo.getHost(db, a.id)!.url).toBe('http://a2:8188'))

    // 回归点:旧实现整段在锁内,这个请求要等到 release() 才有响应(代理层直接 504)
    const patchDone = await Promise.race([
      Promise.resolve(req(app, 'PATCH', `/${b.id}`, { name: 'B2' })).then(() => 'resolved' as const),
      new Promise((r) => setTimeout(r, 300)).then(() => 'timeout' as const),
    ])
    expect(patchDone).toBe('resolved')
    expect(repo.getHost(db, b.id)?.name).toBe('B2')

    release()
    expect((await pPatch).status).toBe(200)
    expect(restartSpy).toHaveBeenCalledWith(a.id)
  })

  it('改非参考主机 URL:只重建该主机 worker,不触发重连事件', async () => {
    const { app, db, pool, deps } = setupApp()
    repo.ensureActiveHost(db, 'http://a:8188')
    const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
    pool.syncFromDb()
    const restartSpy = vi.spyOn(pool, 'restartWorker')
    const seen: any[] = []
    deps.events.on('event', (e) => e.type === 'comfy-status' && seen.push(e))
    const res = await req(app, 'PATCH', `/${b.id}`, { url: 'http://b2:8188' })
    expect(res.status).toBe(200)
    expect(restartSpy).toHaveBeenCalledWith(b.id)
    expect(repo.getHost(db, b.id)?.url).toBe('http://b2:8188')
    expect(seen).toHaveLength(0)
  })
})

describe('current/stats', () => {
  it('在线返回摘要;fake 断网返回 online:false', async () => {
    const { app, db, deps } = setupApp()
    repo.ensureActiveHost(db, 'http://a:8188')
    const res = await app.request('/api/hosts/current/stats', { headers: authHeaders })
    const body = (await res.json()) as any
    expect(body.online).toBe(true)
    expect(body.gpuName).toBe('FakeGPU')
    expect(body.vramTotalMB).toBe(8192)
    expect(body.cwe).toBe(true)
    ;(deps.comfy as FakeComfy).getSystemStats = async () => {
      throw new Error('down')
    }
    const res2 = await app.request('/api/hosts/current/stats', { headers: authHeaders })
    expect(((await res2.json()) as any).online).toBe(false)
  })
})

describe('/:id/stats', () => {
  it('host 不存在 404;host 存在时按 id 探测,结构与 current/stats 相同', async () => {
    const { app, db, deps } = setupApp()
    expect((await req(app, 'GET', '/9999/stats')).status).toBe(404)
    const host = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
    deps.comfyFactory = () => new FakeComfy()
    const res = await req(app, 'GET', `/${host.id}/stats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.online).toBe(true)
    expect(body.gpuName).toBe('FakeGPU')
  })
})

describe('/:id/test', () => {
  it('host 不存在 404', async () => {
    const { app } = setupApp()
    expect((await req(app, 'POST', '/9999/test')).status).toBe(404)
  })

  it('不可达主机在 3s 超时内返回 reachable:false', async () => {
    const { app, db } = setupApp()
    const host = repo.createHost(db, { name: 'Dead', url: 'http://127.0.0.1:1' })
    const res = await req(app, 'POST', `/${host.id}/test`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).reachable).toBe(false)
  }, 10000)
})
