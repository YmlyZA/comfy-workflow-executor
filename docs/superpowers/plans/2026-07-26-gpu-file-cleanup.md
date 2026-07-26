# 删除 batch 可选清理 GPU 主机输出文件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 batch 时可勾选同时清理 GPU 主机 output 目录里该 batch 的文件（经仓库自带的 ComfyUI 扩展），并让执行器开始把 GPU 侧输出引用入库。

**Architecture:** `OutputFile` 加可选 `gpu` 引用字段（JSON 列免迁移）；GPU 主机装一个约 60 行的纯路由 ComfyUI 扩展（ping + 受限删除）；server 的 ComfyClient 加两个 cwe 方法、`cwe-status` 探测端点、`DELETE /batches/:id?purgeGpu=1`；前端删除对话框加第二个勾选框（扩展未装时禁用）。规格见 `docs/superpowers/specs/2026-07-26-gpu-file-cleanup-design.md`。

**Tech Stack:** Hono + better-sqlite3 + vitest（server）；Python/aiohttp（ComfyUI 扩展，无仓库内测试）；React 19 + react-query + shadcn/ui（web）。

## Global Constraints

- server/shared 是 ESM：**相对导入必须带 `.js` 后缀**
- web 约定**不写渲染测试**，UI 文案用中文
- 不新增 npm 依赖，不改 `pnpm-workspace.yaml`
- Python 扩展无仓库测试设施：保持极简，`python3 -m py_compile` 语法检查通过即可
- 测试命令：`pnpm --filter @cwe/server test`、根目录 `pnpm test`（全部）、`pnpm typecheck`
- 提交信息结尾加 trailer：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 当前分支 `feat/gpu-file-cleanup`，直接在其上提交

---

### Task 1: OutputFile.gpu 字段 + executor 写入引用

**Files:**
- Modify: `packages/shared/src/types.ts`（OutputFile，当前 46-50 行）
- Modify: `apps/server/src/executor.ts`（collectOutputs，当前 169-180 行）
- Test: `apps/server/test/executor.test.ts`

**Interfaces:**
- Produces: `OutputFile` 新增可选字段 `gpu?: { filename: string; subfolder: string }`；executor 产出的每个 output 均带 `gpu`（旧数据无此字段）
- Consumes: 无

- [ ] **Step 1: 写失败测试**

`apps/server/test/executor.test.ts` 的 `describe('executor', ...)` 内追加：

```ts
  it('outputs 带 GPU 侧引用(供删除 batch 时清理)', async () => {
    const b = seed()
    await makeExecutor().runPendingOnce()
    const out = repo.getBatchDetail(db, b.id)!.jobs[0]!.outputs![0]!
    expect(out.gpu).toEqual({ filename: 'out.png', subfolder: '' })
  })
```

（FakeComfy 的 `nextResult` 输出为 `{ filename: 'out.png', subfolder: '', type: 'output' }`，见 test/fake-comfy.ts。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- executor`
Expected: FAIL——`out.gpu` 为 undefined

- [ ] **Step 3: 实现**

`packages/shared/src/types.ts` 的 `OutputFile` 改为：

```ts
export interface OutputFile {
  /** 相对 outputs 根目录的路径，如 "3/0-cat-00001.png" */
  path: string
  filename: string
  /** GPU 侧引用(type 恒为 output 不存);旧数据无此字段 → GPU 侧删除跳过 */
  gpu?: { filename: string; subfolder: string }
}
```

`apps/server/src/executor.ts` 的 `collectOutputs` 中 push 改为：

```ts
      outputs.push({
        path: `${job.batchId}/${filename}`,
        filename,
        gpu: { filename: ref.filename, subfolder: ref.subfolder },
      })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- executor && pnpm typecheck`
Expected: PASS（recover 路径复用 collectOutputs，自动获得引用）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts apps/server/src/executor.ts apps/server/test/executor.test.ts
git commit -m "feat: 输出文件入库 GPU 侧引用(filename/subfolder)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ComfyUI 扩展 comfyui-cwe/

**Files:**
- Create: `comfyui-cwe/__init__.py`
- Create: `comfyui-cwe/README.md`

**Interfaces:**
- Produces: GPU 侧 HTTP 端点 `GET /cwe/ping` → `{"ok": true, "version": 1}`；`POST /cwe/delete-output-files` body `{"files": [{"filename", "subfolder"}]}` → `{"deleted": n, "missing": n, "failed": [label...]}`
- Consumes: 无（部署在 GPU 主机，与 TS 代码无编译依赖）

- [ ] **Step 1: 写扩展**

新建 `comfyui-cwe/__init__.py`：

```python
"""cwe 扩展:受限的 output 文件删除端点(配套 comfy-workflow-executor)。

无鉴权——部署前提是 ComfyUI 仅本机/SSH 隧道可达,详见本目录 README。
"""
import os

import folder_paths
from aiohttp import web
from server import PromptServer

VERSION = 1

routes = PromptServer.instance.routes


def _resolve_output_file(subfolder: str, filename: str):
    """解析到 output 目录内的绝对路径;越界(../绝对路径/符号链接逃逸)返回 None。"""
    out_root = os.path.realpath(folder_paths.get_output_directory())
    target = os.path.realpath(os.path.join(out_root, subfolder or "", filename or ""))
    if not target.startswith(out_root + os.sep):
        return None
    return target


@routes.get("/cwe/ping")
async def cwe_ping(request):
    return web.json_response({"ok": True, "version": VERSION})


@routes.post("/cwe/delete-output-files")
async def cwe_delete_output_files(request):
    body = await request.json()
    files = body.get("files") or []
    deleted, missing, failed = 0, 0, []
    for item in files:
        subfolder = str(item.get("subfolder") or "")
        filename = str(item.get("filename") or "")
        label = f"{subfolder}/{filename}" if subfolder else filename
        target = _resolve_output_file(subfolder, filename)
        if target is None:
            failed.append(label)
            continue
        if not os.path.isfile(target):
            missing += 1
            continue
        try:
            os.remove(target)
            deleted += 1
        except OSError:
            failed.append(label)
    return web.json_response({"deleted": deleted, "missing": missing, "failed": failed})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
```

新建 `comfyui-cwe/README.md`：

```markdown
# comfyui-cwe

comfy-workflow-executor 配套的 ComfyUI 扩展：提供受限的 output 文件删除端点，
供执行器在删除 batch 时清理 GPU 侧输出文件。无节点定义，纯 HTTP 路由。

## 端点

- `GET /cwe/ping` → `{"ok": true, "version": 1}`（供服务端探测扩展已安装）
- `POST /cwe/delete-output-files`，body `{"files": [{"filename": "x.png", "subfolder": ""}]}`
  → `{"deleted": n, "missing": n, "failed": ["subfolder/filename", ...]}`
  只允许删除 ComfyUI output 目录内的普通文件（realpath 前缀校验，防路径穿越）。

## 安装

1. 拷贝本目录到 GPU 主机：`cp -r comfyui-cwe <ComfyUI>/custom_nodes/`
2. 重启 ComfyUI
3. 验证：`curl http://localhost:8188/cwe/ping`

## 安全前提

端点**无鉴权**。仅在 ComfyUI 只有本机 / SSH 隧道可达时使用；
若你的 ComfyUI 暴露于局域网或公网，请勿安装本扩展。
```

- [ ] **Step 2: 语法检查**

Run: `python3 -m py_compile comfyui-cwe/__init__.py && echo PY-OK`
Expected: PY-OK（只编译不导入，无需 ComfyUI 依赖）

- [ ] **Step 3: Commit**

```bash
git add comfyui-cwe/
git commit -m "feat: comfyui-cwe 扩展(ping + 受限 output 删除端点)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: ComfyClient cwe 方法 + cwe-status 端点

**Files:**
- Modify: `apps/server/src/comfy/client.ts`（ComfyClient 接口 + createComfyClient 实现）
- Modify: `apps/server/test/fake-comfy.ts`
- Modify: `apps/server/src/routes/comfy.ts`
- Test: `apps/server/test/comfy-routes.test.ts`

**Interfaces:**
- Produces（Task 4/5 依赖）：
  - `ComfyClient.cwePing(): Promise<boolean>`
  - `ComfyClient.cweDeleteOutputFiles(refs: Array<{ filename: string; subfolder: string }>): Promise<{ deleted: number; missing: number; failed: string[] }>`
  - `GET /api/comfy/cwe-status` → `{ installed: boolean }`（comfy 未配置/离线/未装均 false，永远 200）
  - FakeComfy：`cwePingResult`（默认 true）、`cweDeleted`（记录每次调用的 refs 数组）、`cweDeleteResult`（可配置返回，null 时返回 `{deleted: refs.length, missing: 0, failed: []}`）
- Consumes: Task 2 的两个 GPU 侧端点（实现按其契约 fetch）

- [ ] **Step 1: 写失败测试**

`apps/server/test/comfy-routes.test.ts` 追加：

```ts
describe('GET /api/comfy/cwe-status', () => {
  it('扩展在线返回 installed:true', async () => {
    const res = await app.request('/api/comfy/cwe-status', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ installed: true })
  })

  it('cwePing false 返回 installed:false', async () => {
    comfy.cwePingResult = false
    const res = await app.request('/api/comfy/cwe-status', { headers: H })
    expect(await res.json()).toEqual({ installed: false })
  })

  it('comfy 未配置返回 installed:false 而非 503', async () => {
    const res = await makeApp(false).request('/api/comfy/cwe-status', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ installed: false })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- comfy-routes`
Expected: FAIL——路由不存在落到 `/api/*` 兜底 404（且 `comfy.cwePingResult` 属性不存在会先报类型/运行错，属预期）

- [ ] **Step 3: 实现**

`apps/server/src/comfy/client.ts` 的 `ComfyClient` 接口（`connectEvents` 之前）加：

```ts
  /** cwe 扩展是否安装(GET /cwe/ping);离线/404/异常均 false */
  cwePing(): Promise<boolean>
  /** 删除 GPU 侧 output 文件;扩展缺失/离线抛错,由调用方兜 gpuPurgeFailed */
  cweDeleteOutputFiles(
    refs: Array<{ filename: string; subfolder: string }>,
  ): Promise<{ deleted: number; missing: number; failed: string[] }>
```

`createComfyClient` 返回对象中（`connectEvents` 之前）加：

```ts
    async cwePing() {
      try {
        const res = await fetch(`${http}/cwe/ping`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) return false
        const body = (await res.json()) as { ok?: boolean }
        return body.ok === true
      } catch {
        return false
      }
    },

    async cweDeleteOutputFiles(refs) {
      const res = await fetch(`${http}/cwe/delete-output-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: refs }),
      })
      if (!res.ok) throw new Error(`cwe delete failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as { deleted: number; missing: number; failed: string[] }
    },
```

`apps/server/test/fake-comfy.ts` 的 FakeComfy 类内（`connectEvents` 之前）加：

```ts
  cwePingResult = true
  cweDeleted: Array<Array<{ filename: string; subfolder: string }>> = []
  cweDeleteResult: { deleted: number; missing: number; failed: string[] } | null = null

  async cwePing() {
    return this.cwePingResult
  }
  async cweDeleteOutputFiles(refs: Array<{ filename: string; subfolder: string }>) {
    this.cweDeleted.push(refs)
    return this.cweDeleteResult ?? { deleted: refs.length, missing: 0, failed: [] }
  }
```

`apps/server/src/routes/comfy.ts` 在 `input-image` 端点后追加：

```ts
  /** cwe 扩展探测:未配置/离线/未安装均 installed:false(能力探测,不用 503) */
  app.get('/cwe-status', async (c) => {
    if (!deps.comfy) return c.json({ installed: false })
    return c.json({ installed: await deps.comfy.cwePing() })
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test -- comfy-routes && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/comfy/client.ts apps/server/test/fake-comfy.ts apps/server/src/routes/comfy.ts apps/server/test/comfy-routes.test.ts
git commit -m "feat(server): ComfyClient cwe 方法与 cwe-status 探测端点

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: DELETE /batches/:id 支持 purgeGpu=1

**Files:**
- Modify: `apps/server/src/routes/batches.ts`（delete handler，当前 18-33 行）
- Test: `apps/server/test/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OutputFile.gpu`；Task 3 的 `cweDeleteOutputFiles` 与 FakeComfy 的 `cweDeleted`/`cweDeleteResult`
- Produces: `DELETE /api/batches/:id?purgeGpu=1` 响应字段——`gpuPurgeFailed?: true`（扩展调用抛错 / 返回 failed 非空 / comfy 未配置且有引用）、`gpuSkipped?: number`（无 gpu 引用的输出文件数，0 时省略）；`purgeGpu` 与 `purgeOutputs` 独立组合

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes.test.ts`：顶部 import 区加：

```ts
import * as repo from '../src/db/repo.js'
import { FakeComfy } from './fake-comfy.js'
```

文件末尾追加：

```ts
describe('DELETE /api/batches/:id purgeGpu', () => {
  function makeComfyApp() {
    const comfy = new FakeComfy()
    const localDb = createDb(':memory:')
    const localApp = createApp({
      config: loadConfig({ AUTH_TOKEN: 'secret' }),
      db: localDb,
      comfy,
      events: new EventEmitter(),
    })
    return { comfy, localDb, localApp }
  }

  /** 建一个已完成 batch:job0 两个输出同 gpu 引用(测去重),job1 一个无引用输出(测跳过) */
  function seedFinished(localDb: Db) {
    const t = repo.createTemplate(localDb, {
      name: 'T',
      comfyJson: templateBody.comfyJson,
      params: templateBody.params as any,
    })
    const b = repo.createBatch(localDb, t.id, { name: 'B', jobs: [{ prompt: 'a' }, { prompt: 'b' }] })
    const c1 = repo.claimNextJob(localDb)!
    repo.finishJob(localDb, c1.job.id, [
      { path: `${b.id}/0-0-a.png`, filename: '0-0-a.png', gpu: { filename: 'a.png', subfolder: 'sub' } },
      { path: `${b.id}/0-1-b.png`, filename: '0-1-b.png', gpu: { filename: 'a.png', subfolder: 'sub' } },
    ])
    const c2 = repo.claimNextJob(localDb)!
    repo.finishJob(localDb, c2.job.id, [{ path: `${b.id}/1-0-old.png`, filename: '1-0-old.png' }])
    repo.markBatchCompletedIfDone(localDb, b.id)
    return b
  }

  it('收集引用去重传给扩展,无引用输出计入 gpuSkipped', async () => {
    const { comfy, localDb, localApp } = makeComfyApp()
    const b = seedFinished(localDb)
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, gpuSkipped: 1 })
    expect(comfy.cweDeleted).toEqual([[{ filename: 'a.png', subfolder: 'sub' }]])
  })

  it('扩展调用抛错时 gpuPurgeFailed 且 batch 已删', async () => {
    const { comfy, localDb, localApp } = makeComfyApp()
    const b = seedFinished(localDb)
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
    const { comfy, localDb, localApp } = makeComfyApp()
    const b = seedFinished(localDb)
    comfy.cweDeleteResult = { deleted: 0, missing: 0, failed: ['sub/a.png'] }
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(((await res.json()) as any).gpuPurgeFailed).toBe(true)
  })

  it('全部输出无 gpu 引用时不调扩展', async () => {
    const { comfy, localDb, localApp } = makeComfyApp()
    const t = repo.createTemplate(localDb, {
      name: 'T2',
      comfyJson: templateBody.comfyJson,
      params: templateBody.params as any,
    })
    const b = repo.createBatch(localDb, t.id, { name: 'B2', jobs: [{ prompt: 'a' }] })
    const c1 = repo.claimNextJob(localDb)!
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
    const { comfy, localDb, localApp } = makeComfyApp()
    const b = seedFinished(localDb)
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
    const b = seedFinished(localDb)
    const res = await localApp.request(`/api/batches/${b.id}?purgeGpu=1`, {
      method: 'DELETE',
      headers: H,
    })
    expect(((await res.json()) as any).gpuPurgeFailed).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cwe/server test -- routes`
Expected: FAIL——响应缺 `gpuSkipped`/`gpuPurgeFailed`、`cweDeleted` 为空

- [ ] **Step 3: 实现**

`apps/server/src/routes/batches.ts` 的 delete handler 整体替换为：

```ts
  app.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    // purgeGpu 需在删 DB 记录前收集 GPU 侧输出引用(按 subfolder/filename 去重)
    const purgeGpu = c.req.query('purgeGpu') === '1'
    const gpuRefs: Array<{ filename: string; subfolder: string }> = []
    let gpuSkipped = 0
    if (purgeGpu) {
      const seen = new Set<string>()
      for (const job of repo.getBatchDetail(deps.db, id)?.jobs ?? []) {
        for (const out of job.outputs ?? []) {
          if (!out.gpu) {
            gpuSkipped++
            continue
          }
          const key = `${out.gpu.subfolder}/${out.gpu.filename}`
          if (!seen.has(key)) {
            seen.add(key)
            gpuRefs.push(out.gpu)
          }
        }
      }
    }
    const res = repo.deleteBatch(deps.db, id)
    if (res === 'not-found') return c.json({ error: 'batch not found' }, 404)
    if (res === 'running') return c.json({ error: 'batch is running' }, 409)
    let purgeFailed = false
    if (c.req.query('purgeOutputs') === '1') {
      try {
        await rm(join(deps.config.dataDir, 'outputs', String(id)), { recursive: true, force: true })
      } catch {
        purgeFailed = true
      }
    }
    let gpuPurgeFailed = false
    if (purgeGpu && gpuRefs.length > 0) {
      if (!deps.comfy) {
        gpuPurgeFailed = true
      } else {
        try {
          const r = await deps.comfy.cweDeleteOutputFiles(gpuRefs)
          if (r.failed.length > 0) gpuPurgeFailed = true
        } catch {
          gpuPurgeFailed = true
        }
      }
    }
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'deleted' })
    return c.json({
      ok: true,
      ...(purgeFailed ? { purgeFailed: true } : {}),
      ...(gpuPurgeFailed ? { gpuPurgeFailed: true } : {}),
      ...(gpuSkipped > 0 ? { gpuSkipped } : {}),
    })
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cwe/server test && pnpm typecheck`
Expected: 全绿（既有 DELETE 测试不受影响：不带 purgeGpu 时行为不变）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/batches.ts apps/server/test/routes.test.ts
git commit -m "feat(server): DELETE /batches/:id 支持 purgeGpu=1 清理 GPU 侧输出

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 删除对话框 GPU 勾选框 + README

**Files:**
- Create: `apps/web/src/hooks/use-cwe-status.ts`
- Modify: `apps/web/src/pages/batches.tsx`（BatchesBulkActions 的 AlertDialog 与删除回调）
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3 的 `GET /api/comfy/cwe-status`；Task 4 的 `gpuPurgeFailed`/`gpuSkipped` 响应字段
- Produces: 无（终端 UI）

- [ ] **Step 1: 新建 hook**

新建 `apps/web/src/hooks/use-cwe-status.ts`：

```ts
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** cwe 扩展探测:未装/离线 installed:false,GPU 清理勾选框据此禁用 */
export function useCweStatus() {
  return useQuery({
    queryKey: ['cwe-status'],
    queryFn: () => api<{ installed: boolean }>('/comfy/cwe-status'),
    staleTime: 30_000,
    retry: false,
  })
}
```

- [ ] **Step 2: 改删除对话框**

`apps/web/src/pages/batches.tsx`：

顶部加 `import { useCweStatus } from '@/hooks/use-cwe-status'`。

`BatchesBulkActions` 函数内，`const [purge, setPurge] = useState(false)` 之后加：

```tsx
  const [purgeGpu, setPurgeGpu] = useState(false)
  const cwe = useCweStatus()
  const cweInstalled = cwe.data?.installed === true
```

`AlertDialog` 的 `onOpenChange` 改为同时复位两个勾选：

```tsx
      <AlertDialog onOpenChange={(open) => { if (!open) { setPurge(false); setPurgeGpu(false) } }}>
```

现有 purge 勾选框 `<div className="flex items-center gap-2">...</div>` 之后加第二个勾选框：

```tsx
          <div className="flex items-center gap-2">
            <Checkbox
              id="purge-gpu"
              checked={purgeGpu}
              disabled={!cweInstalled}
              onCheckedChange={(v) => setPurgeGpu(!!v)}
            />
            <Label htmlFor="purge-gpu" className={cweInstalled ? '' : 'text-muted-foreground'}>
              同时删除 GPU 主机上的输出文件
              {cweInstalled ? '' : '（需在 GPU 主机安装 cwe 扩展）'}
            </Label>
          </div>
```

`AlertDialogAction` 的 `onClick` 整体替换为（收集三类结果，横幅后缀拼接沿用现有模式）：

```tsx
              onClick={() => {
                const purgeFailures: string[] = []
                const gpuFailures: string[] = []
                const gpuSkips: string[] = []
                void run(
                  '删除',
                  () => true,
                  async (b) => {
                    const qs = new URLSearchParams()
                    if (purge) qs.set('purgeOutputs', '1')
                    if (purgeGpu) qs.set('purgeGpu', '1')
                    const q = qs.toString()
                    const res = await api<{
                      ok: true
                      purgeFailed?: boolean
                      gpuPurgeFailed?: boolean
                      gpuSkipped?: number
                    }>(`/batches/${b.id}${q ? `?${q}` : ''}`, { method: 'DELETE' })
                    if (res.purgeFailed) purgeFailures.push(b.name)
                    if (res.gpuPurgeFailed) gpuFailures.push(b.name)
                    if (res.gpuSkipped) gpuSkips.push(b.name)
                  },
                  () => {
                    const parts: string[] = []
                    if (purgeFailures.length > 0)
                      parts.push(`${purgeFailures.join('、')} 记录已删，但输出目录清理失败`)
                    if (gpuFailures.length > 0) parts.push(`${gpuFailures.join('、')} GPU 侧清理失败`)
                    if (gpuSkips.length > 0)
                      parts.push(`${gpuSkips.join('、')} GPU 侧引用缺失已跳过（旧批次）`)
                    return parts.length > 0 ? `；${parts.join('；')}` : ''
                  },
                )
              }}
```

- [ ] **Step 3: README 特性清单补一句**

`README.md` 特性清单（批量图片双来源那条之后）追加：

```markdown
- 删除 batch 可选同时清理 GPU 主机上的输出文件（需在 GPU 主机安装 `comfyui-cwe/` 扩展，安装步骤见其 README）
```

- [ ] **Step 4: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/use-cwe-status.ts apps/web/src/pages/batches.tsx README.md
git commit -m "feat(web): 删除对话框支持清理 GPU 主机输出(扩展未装时禁用)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 手动验收清单（PR 描述用）

1. GPU 主机装扩展（comfyui-cwe/README 步骤），`curl http://localhost:8188/cwe/ping` 返回 ok
2. 跑一个新 batch → 勾选两个删除选项删除 → 本地 outputs 目录与 GPU output 目录文件都消失
3. 只勾本地不勾 GPU → GPU 侧文件保留
4. 删除 PR ② 之前创建的旧 batch（勾 GPU 选项）→ 横幅提示「GPU 侧引用缺失已跳过（旧批次）」
5. 停掉 ComfyUI（或未装扩展）→ GPU 勾选框禁用并显示「需在 GPU 主机安装 cwe 扩展」
