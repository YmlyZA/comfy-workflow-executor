# comfy-workflow-executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 批量执行 ComfyUI workflow 的轻量执行器——同一 workflow 模板 × 参数矩阵生成 batch，串行执行、SQLite 持久化、重启恢复、Web 管理界面、单容器部署。

**Architecture:** pnpm monorepo 三包（`@cwe/shared` 纯逻辑 + Zod 契约、`@cwe/server` Hono API + 进程内 executor loop、`@cwe/web` React UI）。生产环境单进程：Hono 托管前端产物 + API + executor。SQLite 是队列唯一事实源；只通过 HTTP/WS 连接已运行的 ComfyUI。

**Tech Stack:** TypeScript (ESM, strict) / Hono 4 + @hono/node-server / Drizzle ORM + better-sqlite3 / React 19 + Vite 7 + Tailwind 4 + shadcn/ui + TanStack Query / Vitest / Docker Compose。

**Spec:** `docs/superpowers/specs/2026-07-24-comfy-workflow-executor-design.md`

## Global Constraints

- Node >= 22，pnpm 11（`packageManager: pnpm@11.7.0`），所有包 `"type": "module"`
- 包名固定：`@cwe/shared`、`@cwe/server`、`@cwe/web`
- TypeScript strict；每包 `typecheck` 脚本 = `tsc --noEmit`
- 测试全部离线，绝不连接真实 ComfyUI（executor 测试用 FakeComfyClient）
- 环境变量：`AUTH_TOKEN`（生产必填，dev 缺省 `dev-token`）、`COMFYUI_URL`（默认 `http://127.0.0.1:8188`）、`DATA_DIR`（默认 `./data`，容器内 `/data`）、`PORT`（默认 8080）
- `/api/health` 免鉴权；其余 `/api/*` 接受 `Authorization: Bearer <token>` 或 `?token=` query（供 `<img>`/下载链接使用）
- 文件布局：`{DATA_DIR}/db.sqlite`、`{DATA_DIR}/uploads/`、`{DATA_DIR}/outputs/{batchId}/`
- Conventional commits；每个任务至少一个 commit
- 根目录 `pnpm test` / `pnpm typecheck` / `pnpm build` 必须始终全绿

---

### Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/web/package.json`（占位，Task 10 用 Vite 脚手架补全）

**Interfaces:**
- Produces: workspace 布局与包名 `@cwe/shared` / `@cwe/server` / `@cwe/web`；根脚本 `dev/build/test/typecheck`；`tsconfig.base.json` 供各包 extends

- [ ] **Step 1: 写根配置文件**

`package.json`:

```json
{
  "name": "comfy-workflow-executor",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@11.7.0",
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "esbuild"]
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "types": []
  }
}
```

`.gitignore`:

```
node_modules/
dist/
data/
.env
*.tsbuildinfo
.DS_Store
```

`.env.example`:

```
# 必填：Web UI 与 API 的访问 Token
AUTH_TOKEN=change-me
# ComfyUI 地址；容器内访问宿主机用 host.docker.internal
COMFYUI_URL=http://host.docker.internal:8188
# compose 对外发布端口
HOST_PORT=8080
```

- [ ] **Step 2: 写三个包的 package.json**

`packages/shared/package.json`:

```json
{
  "name": "@cwe/shared",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "zod": "^4.0.5" },
  "devDependencies": { "typescript": "^5.8.3", "vitest": "^3.2.4" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`apps/server/package.json`:

```json
{
  "name": "@cwe/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/index.ts",
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cwe/shared": "workspace:*",
    "@hono/node-server": "^1.14.4",
    "archiver": "^7.0.1",
    "better-sqlite3": "^12.2.0",
    "drizzle-orm": "^0.44.2",
    "hono": "^4.8.4",
    "ws": "^8.18.3",
    "zod": "^4.0.5"
  },
  "devDependencies": {
    "@types/archiver": "^6.0.3",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.15.0",
    "@types/ws": "^8.18.1",
    "tsup": "^8.5.0",
    "tsx": "^4.20.3",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "tsup.config.ts"]
}
```

`apps/web/package.json`（占位，Task 10 补全依赖）:

```json
{
  "name": "@cwe/web",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "echo skip",
    "test": "echo skip"
  }
}
```

- [ ] **Step 3: 安装并验证**

Run: `pnpm install`
Expected: 无报错，生成 `pnpm-lock.yaml`

Run: `pnpm test`
Expected: shared 报 "No test files found"（vitest run 在无测试时退出码非 0——给 shared 的 test 脚本临时加 `--passWithNoTests`：`"test": "vitest run --passWithNoTests"`，Task 2 加了测试后保留该 flag 无害）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo (shared/server/web)"
```

---

### Task 2: shared — 类型契约 + 矩阵展开（TDD）

**Files:**
- Create: `packages/shared/src/types.ts`, `packages/shared/src/matrix.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/matrix.test.ts`

**Interfaces:**
- Produces:
  - `ParamType = 'text' | 'number' | 'seed' | 'image'`
  - `ParamDef = { key; label; nodeId; inputName; type: ParamType; default?: string | number }`
  - `ParamValues = Record<string, string | number>`
  - `BatchStatus = 'pending' | 'running' | 'completed' | 'canceled'`；`JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'`
  - Zod schemas：`paramDefSchema`, `paramValuesSchema`, `createTemplateSchema = { name, comfyJson, params }`, `createBatchSchema = { name, jobs: ParamValues[] }`
  - `expandMatrix(axes: Record<string, Array<string | number>>): ParamValues[]`

- [ ] **Step 1: 写类型与 schemas**

`packages/shared/src/types.ts`:

```ts
import { z } from 'zod'

export const paramTypeSchema = z.enum(['text', 'number', 'seed', 'image'])
export type ParamType = z.infer<typeof paramTypeSchema>

export const paramDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  nodeId: z.string().min(1),
  inputName: z.string().min(1),
  type: paramTypeSchema,
  default: z.union([z.string(), z.number()]).optional(),
})
export type ParamDef = z.infer<typeof paramDefSchema>

export const paramValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]))
export type ParamValues = z.infer<typeof paramValuesSchema>

export const createTemplateSchema = z.object({
  name: z.string().min(1),
  comfyJson: z.record(z.string(), z.any()),
  params: z.array(paramDefSchema).min(1),
})
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>

export const createBatchSchema = z.object({
  name: z.string().min(1),
  jobs: z.array(paramValuesSchema).min(1),
})
export type CreateBatchInput = z.infer<typeof createBatchSchema>

export const batchStatusSchema = z.enum(['pending', 'running', 'completed', 'canceled'])
export type BatchStatus = z.infer<typeof batchStatusSchema>

export const jobStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'canceled'])
export type JobStatus = z.infer<typeof jobStatusSchema>

export interface OutputFile {
  /** 相对 outputs 根目录的路径，如 "3/0-cat-00001.png" */
  path: string
  filename: string
}
```

- [ ] **Step 2: 写失败测试**

`packages/shared/test/matrix.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { expandMatrix } from '../src/index.js'

describe('expandMatrix', () => {
  it('expands cartesian product in stable order', () => {
    const rows = expandMatrix({ prompt: ['a', 'b'], seed: [1, 2, 3] })
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ prompt: 'a', seed: 1 })
    expect(rows[5]).toEqual({ prompt: 'b', seed: 3 })
  })

  it('single axis returns one row per value', () => {
    expect(expandMatrix({ prompt: ['x'] })).toEqual([{ prompt: 'x' }])
  })

  it('empty axes object returns empty list', () => {
    expect(expandMatrix({})).toEqual([])
  })

  it('ignores axes with no values', () => {
    expect(expandMatrix({ prompt: ['a'], seed: [] })).toEqual([{ prompt: 'a' }])
  })
})
```

- [ ] **Step 3: 验证失败**

Run: `pnpm --filter @cwe/shared test`
Expected: FAIL — `expandMatrix` 未导出

- [ ] **Step 4: 实现**

`packages/shared/src/matrix.ts`:

```ts
import type { ParamValues } from './types.js'

export function expandMatrix(axes: Record<string, Array<string | number>>): ParamValues[] {
  const keys = Object.keys(axes).filter((k) => (axes[k] ?? []).length > 0)
  if (keys.length === 0) return []
  return keys.reduce<ParamValues[]>(
    (acc, key) => acc.flatMap((row) => (axes[key] ?? []).map((v) => ({ ...row, [key]: v }))),
    [{}],
  )
}
```

`packages/shared/src/index.ts`:

```ts
export * from './types.js'
export * from './matrix.js'
```

- [ ] **Step 5: 验证通过并提交**

Run: `pnpm --filter @cwe/shared test && pnpm --filter @cwe/shared typecheck`
Expected: PASS

```bash
git add packages/shared
git commit -m "feat(shared): param/batch schemas and matrix expansion"
```

---

### Task 3: shared — buildPrompt 参数注入（TDD）

**Files:**
- Create: `packages/shared/src/prompt.ts`
- Modify: `packages/shared/src/index.ts`（加一行 `export * from './prompt.js'`）
- Test: `packages/shared/test/prompt.test.ts`

**Interfaces:**
- Consumes: `ParamDef`, `ParamValues`（Task 2）
- Produces: `buildPrompt(comfyJson: Record<string, any>, params: ParamDef[], values: ParamValues): Record<string, any>` — 深拷贝注入，不修改原对象；缺值且无 default 抛 `Error("missing value for param \"<key>\"")`；nodeId 不存在抛 `Error("node <id> not found for param \"<key>\"")`；`number`/`seed` 强制 `Number()`

- [ ] **Step 1: 写失败测试**

`packages/shared/test/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildPrompt, type ParamDef } from '../src/index.js'

const comfyJson = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['4', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
}
const params: ParamDef[] = [
  { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' },
  { key: 'seed', label: 'Seed', nodeId: '3', inputName: 'seed', type: 'seed' },
]

describe('buildPrompt', () => {
  it('injects values into the right node inputs', () => {
    const out = buildPrompt(comfyJson, params, { prompt: 'a cat', seed: '42' })
    expect(out['6'].inputs.text).toBe('a cat')
    expect(out['3'].inputs.seed).toBe(42) // seed 强制为 number
    expect(out['3'].inputs.steps).toBe(20) // 其他输入不动
  })

  it('does not mutate the template json', () => {
    buildPrompt(comfyJson, params, { prompt: 'x', seed: 1 })
    expect(comfyJson['6'].inputs.text).toBe('old')
  })

  it('falls back to default value', () => {
    const withDefault: ParamDef[] = [{ ...params[0]!, default: 'dft' }]
    const out = buildPrompt(comfyJson, withDefault, {})
    expect(out['6'].inputs.text).toBe('dft')
  })

  it('throws on missing value without default', () => {
    expect(() => buildPrompt(comfyJson, params, { prompt: 'x' })).toThrow(
      'missing value for param "seed"',
    )
  })

  it('throws when node id is absent', () => {
    const bad: ParamDef[] = [{ ...params[0]!, nodeId: '99' }]
    expect(() => buildPrompt(comfyJson, bad, { prompt: 'x' })).toThrow(
      'node 99 not found for param "prompt"',
    )
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `pnpm --filter @cwe/shared test`
Expected: FAIL — `buildPrompt` 未导出

- [ ] **Step 3: 实现**

`packages/shared/src/prompt.ts`:

```ts
import type { ParamDef, ParamValues } from './types.js'

export function buildPrompt(
  comfyJson: Record<string, any>,
  params: ParamDef[],
  values: ParamValues,
): Record<string, any> {
  const prompt = structuredClone(comfyJson)
  for (const def of params) {
    const value = values[def.key] ?? def.default
    if (value === undefined) throw new Error(`missing value for param "${def.key}"`)
    const node = prompt[def.nodeId]
    if (!node) throw new Error(`node ${def.nodeId} not found for param "${def.key}"`)
    node.inputs[def.inputName] =
      def.type === 'number' || def.type === 'seed' ? Number(value) : value
  }
  return prompt
}
```

- [ ] **Step 4: 验证通过并提交**

Run: `pnpm --filter @cwe/shared test && pnpm --filter @cwe/shared typecheck`
Expected: PASS（9 个测试）

```bash
git add packages/shared
git commit -m "feat(shared): buildPrompt param injection"
```

---

### Task 4: server 脚手架 — config + auth + health（TDD）

**Files:**
- Create: `apps/server/src/config.ts`, `apps/server/src/auth.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/tsup.config.ts`
- Test: `apps/server/test/app.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env?: NodeJS.ProcessEnv): Config`，`Config = { port: number; dataDir: string; comfyUrl: string; authToken: string }`
  - `auth(token: string): MiddlewareHandler` — 放行 `/api/health`；接受 Bearer header 或 `?token=`
  - `createApp(deps: AppDeps): Hono`，`AppDeps = { config: Config; db: Db; comfy: ComfyClient; events: EventEmitter }` — 本任务先只用 `config`，`db/comfy/events` 类型在 Task 5/7 落地前暂用 `any` 占位字段（`{ config: Config } & Record<string, any>`），Task 6/9 收紧
  - server 入口 `src/index.ts`（本任务最小版，后续任务扩展）

- [ ] **Step 1: 写失败测试**

`apps/server/test/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/app.js'

function testApp() {
  const config = loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: './data-test' })
  return createApp({ config })
}

describe('loadConfig', () => {
  it('applies defaults in dev', () => {
    const c = loadConfig({})
    expect(c).toEqual({
      port: 8080,
      dataDir: './data',
      comfyUrl: 'http://127.0.0.1:8188',
      authToken: 'dev-token',
    })
  })

  it('strips trailing slash from comfy url', () => {
    expect(loadConfig({ COMFYUI_URL: 'http://gpu:8188/' }).comfyUrl).toBe('http://gpu:8188')
  })

  it('requires AUTH_TOKEN in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('AUTH_TOKEN')
  })
})

describe('auth middleware', () => {
  it('health is public', async () => {
    const res = await testApp().request('/api/health')
    expect(res.status).toBe(200)
  })

  it('rejects missing token', async () => {
    const res = await testApp().request('/api/templates')
    expect(res.status).toBe(401)
  })

  it('accepts bearer header', async () => {
    const res = await testApp().request('/api/templates', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).not.toBe(401)
  })

  it('accepts token query param', async () => {
    const res = await testApp().request('/api/templates?token=secret')
    expect(res.status).not.toBe(401)
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `pnpm --filter @cwe/server test`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`apps/server/src/config.ts`:

```ts
export interface Config {
  port: number
  dataDir: string
  comfyUrl: string
  authToken: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let authToken = env.AUTH_TOKEN
  if (!authToken) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_TOKEN is required in production')
    authToken = 'dev-token'
  }
  return {
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? './data',
    comfyUrl: (env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    authToken,
  }
}
```

`apps/server/src/auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono'

export function auth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api/health') return next()
    const header = c.req.header('Authorization')
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    if (provided !== token) return c.json({ error: 'unauthorized' }, 401)
    return next()
  }
}
```

`apps/server/src/app.ts`:

```ts
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import type { Config } from './config.js'

export interface AppDeps {
  config: Config
  [key: string]: any
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  })

  app.use('/api/*', auth(deps.config.authToken))

  app.get('/api/health', (c) => c.json({ ok: true }))
  // 占位，Task 6 挂真实路由；先保证 auth 测试有非 404 路由可打
  app.get('/api/templates', (c) => c.json([]))

  return app
}
```

`apps/server/src/index.ts`:

```ts
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp({ config })

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port}`)
})
```

`apps/server/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node22',
  clean: true,
  noExternal: ['@cwe/shared'],
})
```

- [ ] **Step 4: 验证通过并提交**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck && pnpm --filter @cwe/server build`
Expected: 全 PASS，`apps/server/dist/index.js` 生成

```bash
git add apps/server
git commit -m "feat(server): hono scaffold with config and token auth"
```

---

### Task 5: 数据库层 — schema + repo（TDD）

**Files:**
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/index.ts`, `apps/server/src/db/repo.ts`
- Test: `apps/server/test/repo.test.ts`

**Interfaces:**
- Consumes: `ParamDef`, `ParamValues`, `OutputFile`, `BatchStatus`, `JobStatus`（@cwe/shared）
- Produces:
  - `createDb(path: string): Db`（`':memory:'` 可用；建表 DDL 幂等执行；WAL）
  - Drizzle 行类型：`Template`, `Batch`, `Job`（`$inferSelect`）
  - repo 函数（全部同步，首参 `db: Db`）：
    - `createTemplate(db, input: CreateTemplateInput): Template`
    - `listTemplates(db): Template[]` / `getTemplate(db, id: number): Template | undefined` / `deleteTemplate(db, id: number): void`
    - `createBatch(db, templateId: number, input: CreateBatchInput): Batch`
    - `listBatches(db): Array<Batch & { templateName: string; total: number; succeeded: number; failed: number }>`
    - `getBatchDetail(db, id: number): { batch: Batch; template: Template; jobs: Job[] } | undefined`
    - `claimNextJob(db): { job: Job; template: Template } | undefined`
    - `setJobPromptId(db, jobId: number, promptId: string): void`
    - `finishJob(db, jobId: number, outputs: OutputFile[]): void`（仅当 status='running' 时生效）
    - `failJob(db, jobId: number, error: string): void`（仅当 status='running' 时生效）
    - `listRunningJobs(db): Job[]` / `resetJobToPending(db, jobId: number): void`
    - `markBatchCompletedIfDone(db, batchId: number): boolean`
    - `cancelBatch(db, id: number): Job | undefined`（返回被取消时正在 running 的 job）
    - `retryFailedJobs(db, batchId: number): number`

- [ ] **Step 1: 写 schema 与 createDb**

`apps/server/src/db/schema.ts`:

```ts
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { OutputFile, ParamDef, ParamValues } from '@cwe/shared'

export const templates = sqliteTable('templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  comfyJson: text('comfy_json', { mode: 'json' }).$type<Record<string, any>>().notNull(),
  params: text('params', { mode: 'json' }).$type<ParamDef[]>().notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  templateId: integer('template_id').notNull(),
  name: text('name').notNull(),
  status: text('status').$type<'pending' | 'running' | 'completed' | 'canceled'>().notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull(),
  sortOrder: integer('sort_order').notNull(),
  params: text('params', { mode: 'json' }).$type<ParamValues>().notNull(),
  status: text('status')
    .$type<'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'>()
    .notNull()
    .default('pending'),
  comfyPromptId: text('comfy_prompt_id'),
  error: text('error'),
  outputs: text('outputs', { mode: 'json' }).$type<OutputFile[]>(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
})

export type Template = typeof templates.$inferSelect
export type Batch = typeof batches.$inferSelect
export type Job = typeof jobs.$inferSelect
```

`apps/server/src/db/index.ts`:

```ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

const DDL = `
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  comfy_json TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  sort_order INTEGER NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  comfy_prompt_id TEXT,
  error TEXT,
  outputs TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`

export function createDb(path: string) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(DDL)
  return drizzle(sqlite, { schema })
}

export type Db = ReturnType<typeof createDb>
```

- [ ] **Step 2: 写失败测试**

`apps/server/test/repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

const comfyJson = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } }
const params = [
  { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' as const },
]

let db: Db
beforeEach(() => {
  db = createDb(':memory:')
})

function seedBatch(jobs = [{ prompt: 'a' }, { prompt: 'b' }]) {
  const t = repo.createTemplate(db, { name: 'T', comfyJson, params })
  const b = repo.createBatch(db, t.id, { name: 'B', jobs })
  return { t, b }
}

describe('templates', () => {
  it('create/list/get/delete roundtrip', () => {
    const t = repo.createTemplate(db, { name: 'T', comfyJson, params })
    expect(repo.listTemplates(db)).toHaveLength(1)
    expect(repo.getTemplate(db, t.id)?.params[0]?.key).toBe('prompt')
    repo.deleteTemplate(db, t.id)
    expect(repo.listTemplates(db)).toHaveLength(0)
  })
})

describe('claimNextJob', () => {
  it('claims jobs in order and marks batch running', () => {
    const { b } = seedBatch()
    const c1 = repo.claimNextJob(db)
    expect(c1?.job.params).toEqual({ prompt: 'a' })
    expect(c1?.job.status).toBe('running')
    expect(c1?.template.name).toBe('T')
    expect(repo.getBatchDetail(db, b.id)?.batch.status).toBe('running')
    const c2 = repo.claimNextJob(db)
    expect(c2?.job.params).toEqual({ prompt: 'b' })
  })

  it('returns undefined when nothing pending', () => {
    expect(repo.claimNextJob(db)).toBeUndefined()
  })

  it('skips jobs of canceled batches', () => {
    const { b } = seedBatch()
    repo.cancelBatch(db, b.id)
    expect(repo.claimNextJob(db)).toBeUndefined()
  })
})

describe('finish/fail guards', () => {
  it('finishJob only applies to running jobs', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    repo.finishJob(db, job.id, [{ path: '1/0.png', filename: '0.png' }])
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('succeeded')
    expect(detail.jobs[0]?.outputs).toEqual([{ path: '1/0.png', filename: '0.png' }])
  })

  it('failJob does not overwrite canceled job', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    repo.cancelBatch(db, b.id) // running job 状态置 canceled
    repo.failJob(db, job.id, 'boom')
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('canceled')
  })
})

describe('batch lifecycle', () => {
  it('markBatchCompletedIfDone completes when all jobs terminal', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    expect(repo.markBatchCompletedIfDone(db, b.id)).toBe(false)
    repo.finishJob(db, job.id, [])
    expect(repo.markBatchCompletedIfDone(db, b.id)).toBe(true)
    expect(repo.getBatchDetail(db, b.id)?.batch.status).toBe('completed')
  })

  it('cancelBatch cancels pending+running jobs and returns running one', () => {
    const { b } = seedBatch()
    const { job } = repo.claimNextJob(db)!
    const running = repo.cancelBatch(db, b.id)
    expect(running?.id).toBe(job.id)
    const statuses = repo.getBatchDetail(db, b.id)!.jobs.map((j) => j.status)
    expect(statuses).toEqual(['canceled', 'canceled'])
  })

  it('retryFailedJobs resets failed to pending and reopens batch', () => {
    const { b } = seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    repo.failJob(db, job.id, 'boom')
    repo.markBatchCompletedIfDone(db, b.id)
    expect(repo.retryFailedJobs(db, b.id)).toBe(1)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('pending')
    expect(detail.jobs[0]?.error).toBeNull()
    expect(detail.batch.status).toBe('running')
    expect(repo.claimNextJob(db)?.job.id).toBe(job.id)
  })

  it('listBatches includes template name and counts', () => {
    const { b } = seedBatch()
    const { job } = repo.claimNextJob(db)!
    repo.finishJob(db, job.id, [])
    const rows = repo.listBatches(db)
    expect(rows[0]).toMatchObject({ id: b.id, templateName: 'T', total: 2, succeeded: 1, failed: 0 })
  })

  it('recovery helpers list and reset running jobs', () => {
    seedBatch([{ prompt: 'a' }])
    const { job } = repo.claimNextJob(db)!
    expect(repo.listRunningJobs(db).map((j) => j.id)).toEqual([job.id])
    repo.resetJobToPending(db, job.id)
    expect(repo.listRunningJobs(db)).toHaveLength(0)
    expect(repo.claimNextJob(db)?.job.id).toBe(job.id)
  })
})
```

- [ ] **Step 3: 验证失败**

Run: `pnpm --filter @cwe/server test`
Expected: FAIL — `repo.js` 不存在

- [ ] **Step 4: 实现 repo**

`apps/server/src/db/repo.ts`:

```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { CreateBatchInput, CreateTemplateInput, OutputFile } from '@cwe/shared'
import type { Db } from './index.js'
import { batches, jobs, templates, type Batch, type Job, type Template } from './schema.js'

const now = () => new Date().toISOString()

// -- templates --

export function createTemplate(db: Db, input: CreateTemplateInput): Template {
  return db.insert(templates).values(input).returning().get()
}

export function listTemplates(db: Db): Template[] {
  return db.select().from(templates).orderBy(asc(templates.id)).all()
}

export function getTemplate(db: Db, id: number): Template | undefined {
  return db.select().from(templates).where(eq(templates.id, id)).get()
}

export function deleteTemplate(db: Db, id: number): void {
  db.delete(templates).where(eq(templates.id, id)).run()
}

// -- batches --

export function createBatch(db: Db, templateId: number, input: CreateBatchInput): Batch {
  return db.transaction((tx) => {
    const batch = tx.insert(batches).values({ templateId, name: input.name }).returning().get()
    tx.insert(jobs)
      .values(input.jobs.map((params, i) => ({ batchId: batch.id, sortOrder: i, params })))
      .run()
    return batch
  })
}

export function listBatches(
  db: Db,
): Array<Batch & { templateName: string; total: number; succeeded: number; failed: number }> {
  return db
    .select({
      id: batches.id,
      templateId: batches.templateId,
      name: batches.name,
      status: batches.status,
      createdAt: batches.createdAt,
      templateName: templates.name,
      total: sql<number>`count(${jobs.id})`,
      succeeded: sql<number>`sum(case when ${jobs.status} = 'succeeded' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${jobs.status} = 'failed' then 1 else 0 end)`,
    })
    .from(batches)
    .innerJoin(templates, eq(batches.templateId, templates.id))
    .leftJoin(jobs, eq(jobs.batchId, batches.id))
    .groupBy(batches.id)
    .orderBy(sql`${batches.id} desc`)
    .all()
}

export function getBatchDetail(
  db: Db,
  id: number,
): { batch: Batch; template: Template; jobs: Job[] } | undefined {
  const batch = db.select().from(batches).where(eq(batches.id, id)).get()
  if (!batch) return undefined
  const template = getTemplate(db, batch.templateId)
  if (!template) return undefined
  const rows = db.select().from(jobs).where(eq(jobs.batchId, id)).orderBy(asc(jobs.sortOrder)).all()
  return { batch, template, jobs: rows }
}

// -- executor queue --

export function claimNextJob(db: Db): { job: Job; template: Template } | undefined {
  return db.transaction((tx) => {
    const row = tx
      .select({ job: jobs, batch: batches })
      .from(jobs)
      .innerJoin(batches, eq(jobs.batchId, batches.id))
      .where(and(eq(jobs.status, 'pending'), inArray(batches.status, ['pending', 'running'])))
      .orderBy(asc(batches.id), asc(jobs.sortOrder))
      .limit(1)
      .get()
    if (!row) return undefined
    const job = tx
      .update(jobs)
      .set({ status: 'running', startedAt: now(), error: null })
      .where(eq(jobs.id, row.job.id))
      .returning()
      .get()
    if (row.batch.status === 'pending') {
      tx.update(batches).set({ status: 'running' }).where(eq(batches.id, row.batch.id)).run()
    }
    const template = tx.select().from(templates).where(eq(templates.id, row.batch.templateId)).get()
    if (!template) return undefined
    return { job, template }
  })
}

export function setJobPromptId(db: Db, jobId: number, promptId: string): void {
  db.update(jobs).set({ comfyPromptId: promptId }).where(eq(jobs.id, jobId)).run()
}

export function finishJob(db: Db, jobId: number, outputs: OutputFile[]): void {
  db.update(jobs)
    .set({ status: 'succeeded', outputs, finishedAt: now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    .run()
}

export function failJob(db: Db, jobId: number, error: string): void {
  db.update(jobs)
    .set({ status: 'failed', error, finishedAt: now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    .run()
}

export function listRunningJobs(db: Db): Job[] {
  return db.select().from(jobs).where(eq(jobs.status, 'running')).all()
}

export function resetJobToPending(db: Db, jobId: number): void {
  db.update(jobs)
    .set({ status: 'pending', comfyPromptId: null, startedAt: null })
    .where(eq(jobs.id, jobId))
    .run()
}

export function markBatchCompletedIfDone(db: Db, batchId: number): boolean {
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, batchId)).get()
    if (!batch || batch.status !== 'running') return false
    const open = tx
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(and(eq(jobs.batchId, batchId), inArray(jobs.status, ['pending', 'running'])))
      .get()
    if ((open?.n ?? 0) > 0) return false
    tx.update(batches).set({ status: 'completed' }).where(eq(batches.id, batchId)).run()
    return true
  })
}

export function cancelBatch(db: Db, id: number): Job | undefined {
  return db.transaction((tx) => {
    const running = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.batchId, id), eq(jobs.status, 'running')))
      .get()
    tx.update(jobs)
      .set({ status: 'canceled', finishedAt: now() })
      .where(and(eq(jobs.batchId, id), inArray(jobs.status, ['pending', 'running'])))
      .run()
    tx.update(batches).set({ status: 'canceled' }).where(eq(batches.id, id)).run()
    return running
  })
}

export function retryFailedJobs(db: Db, batchId: number): number {
  return db.transaction((tx) => {
    const res = tx
      .update(jobs)
      .set({ status: 'pending', error: null, comfyPromptId: null, startedAt: null, finishedAt: null })
      .where(and(eq(jobs.batchId, batchId), eq(jobs.status, 'failed')))
      .run()
    if (res.changes > 0) {
      tx.update(batches).set({ status: 'running' }).where(eq(batches.id, batchId)).run()
    }
    return res.changes
  })
}
```

- [ ] **Step 5: 验证通过并提交**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck`
Expected: PASS

```bash
git add apps/server
git commit -m "feat(server): sqlite schema and queue repository with claim semantics"
```

---

### Task 6: templates / batches 路由（TDD）

**Files:**
- Create: `apps/server/src/routes/templates.ts`, `apps/server/src/routes/batches.ts`
- Modify: `apps/server/src/app.ts`（AppDeps 收紧为 `{ config; db; comfy; events }`，挂载路由）、`apps/server/src/index.ts`（构造 db 传入）
- Test: `apps/server/test/routes.test.ts`

**Interfaces:**
- Consumes: repo 函数（Task 5）、`createTemplateSchema`/`createBatchSchema`（Task 2）
- Produces:
  - REST 端点：`GET/POST /api/templates`、`DELETE /api/templates/:id`、`POST /api/templates/:id/batches`、`GET /api/batches`、`GET /api/batches/:id`、`POST /api/batches/:id/cancel`、`POST /api/batches/:id/retry-failed`
  - `AppDeps = { config: Config; db: Db; comfy: ComfyClient | null; events: EventEmitter }`（comfy 本任务允许 null，Task 7 起注入真实实现；cancel 路由对 null comfy 跳过 interrupt）
  - 事件：cancel/retry 后 `events.emit('event', { type: 'batch-updated', batchId, status })`

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'

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
```

- [ ] **Step 2: 验证失败**

Run: `pnpm --filter @cwe/server test`
Expected: FAIL — createApp 不接受 db/routes 未实现（POST 404）

- [ ] **Step 3: 实现路由并接线**

`apps/server/src/routes/templates.ts`:

```ts
import { Hono } from 'hono'
import { createBatchSchema, createTemplateSchema } from '@cwe/shared'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function templateRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listTemplates(deps.db)))

  app.post('/', async (c) => {
    const input = createTemplateSchema.parse(await c.req.json())
    return c.json(repo.createTemplate(deps.db, input), 201)
  })

  app.delete('/:id', (c) => {
    repo.deleteTemplate(deps.db, Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  app.post('/:id/batches', async (c) => {
    const id = Number(c.req.param('id'))
    if (!repo.getTemplate(deps.db, id)) return c.json({ error: 'template not found' }, 404)
    const input = createBatchSchema.parse(await c.req.json())
    const batch = repo.createBatch(deps.db, id, input)
    deps.events.emit('event', { type: 'batch-updated', batchId: batch.id, status: batch.status })
    return c.json(batch, 201)
  })

  return app
}
```

`apps/server/src/routes/batches.ts`:

```ts
import { Hono } from 'hono'
import * as repo from '../db/repo.js'
import type { AppDeps } from '../app.js'

export function batchRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) => c.json(repo.listBatches(deps.db)))

  app.get('/:id', (c) => {
    const detail = repo.getBatchDetail(deps.db, Number(c.req.param('id')))
    if (!detail) return c.json({ error: 'batch not found' }, 404)
    return c.json(detail)
  })

  app.post('/:id/cancel', async (c) => {
    const id = Number(c.req.param('id'))
    if (!repo.getBatchDetail(deps.db, id)) return c.json({ error: 'batch not found' }, 404)
    const runningJob = repo.cancelBatch(deps.db, id)
    if (runningJob && deps.comfy) await deps.comfy.interrupt().catch(() => {})
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'canceled' })
    return c.json({ ok: true })
  })

  app.post('/:id/retry-failed', (c) => {
    const id = Number(c.req.param('id'))
    if (!repo.getBatchDetail(deps.db, id)) return c.json({ error: 'batch not found' }, 404)
    const retried = repo.retryFailedJobs(deps.db, id)
    deps.events.emit('event', { type: 'batch-updated', batchId: id, status: 'running' })
    return c.json({ retried })
  })

  return app
}
```

`apps/server/src/app.ts`（完整替换）:

```ts
import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import type { ComfyClient } from './comfy/client.js'
import { templateRoutes } from './routes/templates.js'
import { batchRoutes } from './routes/batches.js'

export interface AppDeps {
  config: Config
  db: Db
  comfy: ComfyClient | null
  events: EventEmitter
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  })

  app.use('/api/*', auth(deps.config.authToken))

  app.get('/api/health', async (c) =>
    c.json({ ok: true, comfy: deps.comfy ? await deps.comfy.isUp() : false }),
  )
  app.route('/api/templates', templateRoutes(deps))
  app.route('/api/batches', batchRoutes(deps))

  return app
}
```

注意：`ComfyClient` 类型在 Task 7 才创建。为让本任务独立可过 typecheck，先创建最小接口文件 `apps/server/src/comfy/client.ts`：

```ts
export interface ComfyClient {
  isUp(): Promise<boolean>
  interrupt(): Promise<void>
}
```

（Task 7 会扩展这个接口并加实现，不会与本定义冲突。）

同时更新 Task 4 的 `apps/server/test/app.test.ts` 中 `testApp()` 以匹配新 AppDeps：

```ts
import { EventEmitter } from 'node:events'
import { createDb } from '../src/db/index.js'

function testApp() {
  const config = loadConfig({ AUTH_TOKEN: 'secret' })
  return createApp({ config, db: createDb(':memory:'), comfy: null, events: new EventEmitter() })
}
```

`apps/server/src/index.ts`（完整替换）:

```ts
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/index.js'

const config = loadConfig()
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true })
mkdirSync(join(config.dataDir, 'outputs'), { recursive: true })

const db = createDb(join(config.dataDir, 'db.sqlite'))
const events = new EventEmitter()
const app = createApp({ config, db, comfy: null, events })

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port}`)
})
```

- [ ] **Step 4: 验证通过并提交**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck`
Expected: 全 PASS（app.test.ts + repo.test.ts + routes.test.ts）

```bash
git add apps/server
git commit -m "feat(server): template and batch REST routes"
```

---

### Task 7: ComfyUI client

**Files:**
- Modify: `apps/server/src/comfy/client.ts`（扩展接口 + 实现 + 纯函数）
- Test: `apps/server/test/comfy.test.ts`（只测纯函数 `extractOutputRefs`；HTTP 实现不在离线测试范围）

**Interfaces:**
- Produces:
  - `OutputRef = { filename: string; subfolder: string; type: string }`
  - `ComfyHistoryEntry = { status?: { completed?: boolean; status_str?: string; messages?: unknown[] }; outputs?: Record<string, Record<string, unknown>> }`
  - `interface ComfyClient { isUp(): Promise<boolean>; interrupt(): Promise<void>; uploadImage(filePath: string): Promise<string>; submit(prompt: Record<string, any>, clientId: string): Promise<string>; getHistory(promptId: string): Promise<ComfyHistoryEntry | null>; downloadOutput(ref: OutputRef, destPath: string): Promise<void>; connectEvents(clientId: string, onEvent: (e: ComfyWsEvent) => void): () => void }`
  - `ComfyWsEvent = { type: string; data?: any }`
  - `extractOutputRefs(entry: ComfyHistoryEntry): OutputRef[]` — 扫描 outputs 每个节点值中的数组，取含 `filename` 的对象
  - `createComfyClient(baseUrl: string): ComfyClient` — 真实 HTTP/WS 实现

- [ ] **Step 1: 写失败测试（纯函数）**

`apps/server/test/comfy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { extractOutputRefs } from '../src/comfy/client.js'

describe('extractOutputRefs', () => {
  it('collects file refs across nodes and array keys', () => {
    const refs = extractOutputRefs({
      outputs: {
        '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
        '12': {
          gifs: [{ filename: 'b.webp', subfolder: 'sub', type: 'output' }],
          text: ['not a file'],
        },
      },
    })
    expect(refs).toEqual([
      { filename: 'a.png', subfolder: '', type: 'output' },
      { filename: 'b.webp', subfolder: 'sub', type: 'output' },
    ])
  })

  it('skips temp previews and empty outputs', () => {
    expect(
      extractOutputRefs({
        outputs: { '9': { images: [{ filename: 't.png', subfolder: '', type: 'temp' }] } },
      }),
    ).toEqual([])
    expect(extractOutputRefs({})).toEqual([])
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `pnpm --filter @cwe/server test`
Expected: FAIL — `extractOutputRefs` 未导出

- [ ] **Step 3: 实现**

`apps/server/src/comfy/client.ts`（完整替换）:

```ts
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket from 'ws'

export interface OutputRef {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyHistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] }
  outputs?: Record<string, Record<string, unknown>>
}

export interface ComfyWsEvent {
  type: string
  data?: any
}

export interface ComfyClient {
  isUp(): Promise<boolean>
  interrupt(): Promise<void>
  uploadImage(filePath: string): Promise<string>
  submit(prompt: Record<string, any>, clientId: string): Promise<string>
  getHistory(promptId: string): Promise<ComfyHistoryEntry | null>
  downloadOutput(ref: OutputRef, destPath: string): Promise<void>
  /** 返回断开函数。连接失败时静默重试由调用方负责。 */
  connectEvents(clientId: string, onEvent: (e: ComfyWsEvent) => void): () => void
}

export function extractOutputRefs(entry: ComfyHistoryEntry): OutputRef[] {
  const refs: OutputRef[] = []
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as any).filename === 'string' &&
          (item as any).type === 'output'
        ) {
          refs.push({
            filename: (item as any).filename,
            subfolder: (item as any).subfolder ?? '',
            type: (item as any).type,
          })
        }
      }
    }
  }
  return refs
}

export function createComfyClient(baseUrl: string): ComfyClient {
  const http = baseUrl
  const ws = baseUrl.replace(/^http/, 'ws')

  return {
    async isUp() {
      try {
        const res = await fetch(`${http}/system_stats`, { signal: AbortSignal.timeout(3000) })
        return res.ok
      } catch {
        return false
      }
    },

    async interrupt() {
      await fetch(`${http}/interrupt`, { method: 'POST' })
    },

    async uploadImage(filePath: string) {
      const form = new FormData()
      form.append('image', new Blob([await readFile(filePath)]), basename(filePath))
      form.append('overwrite', 'true')
      const res = await fetch(`${http}/upload/image`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload/image failed: ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { name: string; subfolder?: string }
      return body.subfolder ? `${body.subfolder}/${body.name}` : body.name
    },

    async submit(prompt, clientId) {
      const res = await fetch(`${http}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: clientId }),
      })
      if (!res.ok) throw new Error(`comfyui rejected prompt: ${res.status} ${await res.text()}`)
      const body = (await res.json()) as { prompt_id: string }
      return body.prompt_id
    },

    async getHistory(promptId) {
      const res = await fetch(`${http}/history/${promptId}`)
      if (!res.ok) throw new Error(`history failed: ${res.status}`)
      const body = (await res.json()) as Record<string, ComfyHistoryEntry>
      return body[promptId] ?? null
    },

    async downloadOutput(ref, destPath) {
      const qs = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder,
        type: ref.type,
      })
      const res = await fetch(`${http}/view?${qs}`)
      if (!res.ok || !res.body) throw new Error(`view failed: ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath))
    },

    connectEvents(clientId, onEvent) {
      let closed = false
      let socket: WebSocket | null = null
      const connect = () => {
        if (closed) return
        socket = new WebSocket(`${ws}/ws?clientId=${clientId}`)
        socket.on('message', (raw, isBinary) => {
          if (isBinary) return // 忽略 preview 二进制帧
          try {
            onEvent(JSON.parse(raw.toString()))
          } catch {
            /* 忽略无法解析的帧 */
          }
        })
        const retry = () => {
          if (!closed) setTimeout(connect, 5000)
        }
        socket.on('close', retry)
        socket.on('error', () => socket?.close())
      }
      connect()
      return () => {
        closed = true
        socket?.close()
      }
    },
  }
}
```

- [ ] **Step 4: 验证通过并提交**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck`
Expected: PASS

```bash
git add apps/server
git commit -m "feat(server): comfyui http/ws client and output ref extraction"
```

---

### Task 8: Executor 执行循环 + 重启恢复（TDD）

**Files:**
- Create: `apps/server/src/executor.ts`
- Modify: `apps/server/src/index.ts`（构造并启动 executor，注入真实 comfy client）
- Test: `apps/server/test/executor.test.ts`

**Interfaces:**
- Consumes: repo（Task 5）、`ComfyClient`/`extractOutputRefs`（Task 7）、`buildPrompt`（Task 3）
- Produces:
  - `class Executor` 构造参数 `{ db: Db; comfy: ComfyClient; events: EventEmitter; dataDir: string; pollMs?: number }`（pollMs 默认 2000，测试传 5）
  - 方法：`async recover(): Promise<void>`、`async runPendingOnce(): Promise<boolean>`（处理一个 job，无可处理返回 false——测试入口）、`start(): void`（循环：recover 一次后 loop runPendingOnce，空闲/掉线时 sleep）、`stop(): void`
  - 事件（`events.emit('event', payload)`）：`{ type: 'job-updated', jobId, batchId, status }`、`{ type: 'batch-updated', batchId, status }`、`{ type: 'progress', jobId, value, max }`
  - 输出文件：`{dataDir}/outputs/{batchId}/{sortOrder}-{i}-{ref.filename}`；job.outputs 存 `{ path: '{batchId}/{...}', filename }`

- [ ] **Step 1: 写失败测试**

`apps/server/test/executor.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'
import { Executor } from '../src/executor.js'
import type { ComfyClient, ComfyHistoryEntry, OutputRef } from '../src/comfy/client.js'

class FakeComfy implements ComfyClient {
  up = true
  submitted: Array<Record<string, any>> = []
  uploads: string[] = []
  history = new Map<string, ComfyHistoryEntry>()
  private n = 0
  /** 每次 submit 后自动写入的 history 结果；null 表示留空（pending 中） */
  nextResult: ComfyHistoryEntry | null = {
    status: { completed: true },
    outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
  }

  async isUp() {
    return this.up
  }
  async interrupt() {}
  async uploadImage(filePath: string) {
    this.uploads.push(filePath)
    return `uploaded-${basename(filePath)}`
  }
  async submit(prompt: Record<string, any>) {
    this.submitted.push(prompt)
    const id = `p${++this.n}`
    if (this.nextResult) this.history.set(id, this.nextResult)
    return id
  }
  async getHistory(promptId: string) {
    return this.history.get(promptId) ?? null
  }
  async downloadOutput(_ref: OutputRef, destPath: string) {
    await writeFile(destPath, 'png-bytes')
  }
  connectEvents() {
    return () => {}
  }
}

const comfyJson = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
}
const params = [
  { key: 'prompt', label: 'P', nodeId: '6', inputName: 'text', type: 'text' as const },
]

let db: Db
let comfy: FakeComfy
let events: EventEmitter
let dataDir: string

beforeEach(() => {
  db = createDb(':memory:')
  comfy = new FakeComfy()
  events = new EventEmitter()
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-'))
})

function makeExecutor() {
  return new Executor({ db, comfy, events, dataDir, pollMs: 5 })
}

function seed(jobs = [{ prompt: 'a' }], p = params, json: Record<string, any> = comfyJson) {
  const t = repo.createTemplate(db, { name: 'T', comfyJson: json, params: p })
  return repo.createBatch(db, t.id, { name: 'B', jobs })
}

describe('executor', () => {
  it('runs a job to success and stores outputs on disk', async () => {
    const b = seed()
    const ex = makeExecutor()
    expect(await ex.runPendingOnce()).toBe(true)
    const detail = repo.getBatchDetail(db, b.id)!
    expect(detail.jobs[0]?.status).toBe('succeeded')
    expect(detail.batch.status).toBe('completed')
    const out = detail.jobs[0]!.outputs![0]!
    expect(out.path).toBe(`${b.id}/0-0-out.png`)
    expect(readFileSync(join(dataDir, 'outputs', out.path), 'utf8')).toBe('png-bytes')
    // 参数注入进了提交的 prompt
    expect(comfy.submitted[0]?.['6'].inputs.text).toBe('a')
  })

  it('uploads image params before submit', async () => {
    const p = [
      ...params,
      { key: 'img', label: 'I', nodeId: '10', inputName: 'image', type: 'image' as const },
    ]
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'uploads'), { recursive: true })
    await writeFile(join(dataDir, 'uploads', 'input.png'), 'x')
    seed([{ prompt: 'a', img: 'input.png' }], p)
    const ex = makeExecutor()
    await ex.runPendingOnce()
    expect(comfy.uploads[0]).toBe(join(dataDir, 'uploads', 'input.png'))
    expect(comfy.submitted[0]?.['10'].inputs.image).toBe('uploaded-input.png')
  })

  it('marks job failed when comfy reports error', async () => {
    comfy.nextResult = { status: { completed: false, status_str: 'error', messages: ['boom'] } }
    const b = seed()
    const ex = makeExecutor()
    await ex.runPendingOnce()
    const job = repo.getBatchDetail(db, b.id)!.jobs[0]!
    expect(job.status).toBe('failed')
    expect(job.error).toContain('boom')
  })

  it('marks job failed when submit rejects', async () => {
    comfy.submit = async () => {
      throw new Error('400 invalid prompt')
    }
    const b = seed()
    await makeExecutor().runPendingOnce()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('failed')
  })

  it('returns false when no pending jobs', async () => {
    expect(await makeExecutor().runPendingOnce()).toBe(false)
  })

  it('recover(): finished-in-history running job is harvested', async () => {
    const b = seed()
    const claimed = repo.claimNextJob(db)!
    repo.setJobPromptId(db, claimed.job.id, 'p-old')
    comfy.history.set('p-old', comfy.nextResult!)
    await makeExecutor().recover()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('succeeded')
  })

  it('recover(): unknown running job resets to pending', async () => {
    const b = seed()
    repo.claimNextJob(db)
    await makeExecutor().recover()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('pending')
  })

  it('recover(): comfy down resets running jobs to pending', async () => {
    const b = seed()
    const claimed = repo.claimNextJob(db)!
    repo.setJobPromptId(db, claimed.job.id, 'p-x')
    comfy.up = false
    comfy.getHistory = async () => {
      throw new Error('ECONNREFUSED')
    }
    await makeExecutor().recover()
    expect(repo.getBatchDetail(db, b.id)!.jobs[0]?.status).toBe('pending')
  })

  it('emits job-updated and progress events', async () => {
    seed()
    const seen: any[] = []
    events.on('event', (e) => seen.push(e))
    await makeExecutor().runPendingOnce()
    const types = seen.map((e) => e.type)
    expect(types).toContain('job-updated')
    expect(types).toContain('batch-updated')
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `pnpm --filter @cwe/server test`
Expected: FAIL — `executor.js` 不存在

- [ ] **Step 3: 实现 Executor**

`apps/server/src/executor.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { buildPrompt, type OutputFile } from '@cwe/shared'
import type { ComfyClient, ComfyHistoryEntry } from './comfy/client.js'
import { extractOutputRefs } from './comfy/client.js'
import type { Db } from './db/index.js'
import * as repo from './db/repo.js'
import type { Job, Template } from './db/schema.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ExecutorDeps {
  db: Db
  comfy: ComfyClient
  events: EventEmitter
  dataDir: string
  pollMs?: number
}

export class Executor {
  private readonly db: Db
  private readonly comfy: ComfyClient
  private readonly events: EventEmitter
  private readonly dataDir: string
  private readonly pollMs: number
  private readonly clientId = randomUUID()
  private running = false
  private currentJobId: number | null = null
  private disconnectWs: (() => void) | null = null

  constructor(deps: ExecutorDeps) {
    this.db = deps.db
    this.comfy = deps.comfy
    this.events = deps.events
    this.dataDir = deps.dataDir
    this.pollMs = deps.pollMs ?? 2000
  }

  start(): void {
    this.running = true
    this.disconnectWs = this.comfy.connectEvents(this.clientId, (e) => {
      if (e.type === 'progress' && this.currentJobId != null) {
        this.emit({
          type: 'progress',
          jobId: this.currentJobId,
          value: e.data?.value ?? 0,
          max: e.data?.max ?? 0,
        })
      }
    })
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.disconnectWs?.()
  }

  private async loop(): Promise<void> {
    await this.recover().catch((err) => console.error('recover failed', err))
    let offlineBackoff = this.pollMs
    while (this.running) {
      if (!(await this.comfy.isUp())) {
        await sleep(offlineBackoff)
        offlineBackoff = Math.min(offlineBackoff * 2, 30_000)
        continue
      }
      offlineBackoff = this.pollMs
      const didWork = await this.runPendingOnce().catch((err) => {
        console.error('executor iteration failed', err)
        return false
      })
      if (!didWork) await sleep(this.pollMs)
    }
  }

  /** 处理一个 pending job；无任务返回 false。测试入口。 */
  async runPendingOnce(): Promise<boolean> {
    const claimed = repo.claimNextJob(this.db)
    if (!claimed) return false
    const { job, template } = claimed
    this.currentJobId = job.id
    this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'running' })
    try {
      const outputs = await this.execute(job, template)
      repo.finishJob(this.db, job.id, outputs)
      this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'succeeded' })
    } catch (err) {
      repo.failJob(this.db, job.id, err instanceof Error ? err.message : String(err))
      this.emit({ type: 'job-updated', jobId: job.id, batchId: job.batchId, status: 'failed' })
    } finally {
      this.currentJobId = null
    }
    if (repo.markBatchCompletedIfDone(this.db, job.batchId)) {
      this.emit({ type: 'batch-updated', batchId: job.batchId, status: 'completed' })
    } else {
      this.emit({ type: 'batch-updated', batchId: job.batchId, status: 'running' })
    }
    return true
  }

  private async execute(job: Job, template: Template): Promise<OutputFile[]> {
    const values = { ...job.params }
    for (const def of template.params) {
      if (def.type !== 'image') continue
      const v = values[def.key] ?? def.default
      if (typeof v === 'string' && v) {
        values[def.key] = await this.comfy.uploadImage(join(this.dataDir, 'uploads', v))
      }
    }
    const prompt = buildPrompt(template.comfyJson, template.params, values)
    const promptId = await this.comfy.submit(prompt, this.clientId)
    repo.setJobPromptId(this.db, job.id, promptId)
    const entry = await this.waitForHistory(promptId)
    return this.collectOutputs(job, entry)
  }

  private async waitForHistory(promptId: string): Promise<ComfyHistoryEntry> {
    for (;;) {
      const entry = await this.comfy.getHistory(promptId)
      if (entry?.status?.completed) return entry
      if (entry?.status?.status_str === 'error') {
        throw new Error(
          `comfyui execution error: ${JSON.stringify(entry.status.messages ?? []).slice(0, 500)}`,
        )
      }
      await sleep(this.pollMs)
    }
  }

  private async collectOutputs(job: Job, entry: ComfyHistoryEntry): Promise<OutputFile[]> {
    const refs = extractOutputRefs(entry)
    const dir = join(this.dataDir, 'outputs', String(job.batchId))
    mkdirSync(dir, { recursive: true })
    const outputs: OutputFile[] = []
    for (const [i, ref] of refs.entries()) {
      const filename = `${job.sortOrder}-${i}-${ref.filename}`
      await this.comfy.downloadOutput(ref, join(dir, filename))
      outputs.push({ path: `${job.batchId}/${filename}`, filename })
    }
    return outputs
  }

  /** 启动时收割/重置 running 状态残留的 job。 */
  async recover(): Promise<void> {
    for (const job of repo.listRunningJobs(this.db)) {
      let recovered = false
      if (job.comfyPromptId) {
        try {
          const entry = await this.comfy.getHistory(job.comfyPromptId)
          if (entry?.status?.completed) {
            repo.finishJob(this.db, job.id, await this.collectOutputs(job, entry))
            recovered = true
          }
        } catch {
          /* comfy 不可达 → 走重置 */
        }
      }
      if (!recovered) repo.resetJobToPending(this.db, job.id)
      repo.markBatchCompletedIfDone(this.db, job.batchId)
    }
  }

  private emit(payload: Record<string, unknown>): void {
    this.events.emit('event', payload)
  }
}
```

- [ ] **Step 4: 验证通过**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck`
Expected: PASS（9 个 executor 测试全绿）

- [ ] **Step 5: 接线 index.ts 并提交**

`apps/server/src/index.ts`（完整替换）:

```ts
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createComfyClient } from './comfy/client.js'
import { loadConfig } from './config.js'
import { createDb } from './db/index.js'
import { Executor } from './executor.js'

const config = loadConfig()
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true })
mkdirSync(join(config.dataDir, 'outputs'), { recursive: true })

const db = createDb(join(config.dataDir, 'db.sqlite'))
const events = new EventEmitter()
const comfy = createComfyClient(config.comfyUrl)
const app = createApp({ config, db, comfy, events })

const executor = new Executor({ db, comfy, events, dataDir: config.dataDir })
executor.start()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`comfy-workflow-executor listening on :${info.port} → ${config.comfyUrl}`)
})
```

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server build`
Expected: PASS

```bash
git add apps/server
git commit -m "feat(server): executor loop with claim, poll, outputs and restart recovery"
```

---

### Task 9: SSE / uploads / outputs / zip 路由

**Files:**
- Create: `apps/server/src/routes/events.ts`, `apps/server/src/routes/files.ts`
- Modify: `apps/server/src/app.ts`（挂载新路由）
- Test: `apps/server/test/files.test.ts`

**Interfaces:**
- Consumes: `AppDeps`（Task 6）、`getBatchDetail`（Task 5）
- Produces:
  - `GET /api/events` — SSE；订阅 `events.on('event')`，`event:` 字段 = payload.type，`data:` = JSON；15s 心跳 comment
  - `POST /api/uploads` — multipart 字段 `files`（可多个）；存 `{dataDir}/uploads/{8位随机}-{原名}`；返回 `[{ name, stored }]`，`stored` 为存储文件名（job 参数里 image 类型的值用它）
  - `GET /api/outputs/*` — 从 `{dataDir}/outputs` 直出文件，带路径穿越防护
  - `GET /api/batches/:id/download` — archiver 打包 `{dataDir}/outputs/{id}/` 为 zip 流

- [ ] **Step 1: 写失败测试**

`apps/server/test/files.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'

let db: Db
let app: ReturnType<typeof createApp>
let dataDir: string
const H = { Authorization: 'Bearer secret' }

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cwe-files-'))
  mkdirSync(join(dataDir, 'uploads'), { recursive: true })
  mkdirSync(join(dataDir, 'outputs', '1'), { recursive: true })
  writeFileSync(join(dataDir, 'outputs', '1', '0-0-out.png'), 'png-bytes')
  db = createDb(':memory:')
  app = createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: dataDir }),
    db,
    comfy: null,
    events: new EventEmitter(),
  })
})

describe('uploads', () => {
  it('stores multipart files and returns stored names', async () => {
    const form = new FormData()
    form.append('files', new Blob(['abc']), 'cat.png')
    const res = await app.request('/api/uploads', { method: 'POST', headers: H, body: form })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Array<{ name: string; stored: string }>
    expect(body[0]?.name).toBe('cat.png')
    expect(body[0]?.stored).toMatch(/^[a-f0-9]{8}-cat\.png$/)
  })
})

describe('outputs static', () => {
  it('serves an output file', async () => {
    const res = await app.request('/api/outputs/1/0-0-out.png', { headers: H })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('png-bytes')
  })

  it('blocks path traversal', async () => {
    const res = await app.request('/api/outputs/..%2F..%2Fetc%2Fpasswd', { headers: H })
    expect(res.status).toBe(400)
  })

  it('404 on missing file', async () => {
    const res = await app.request('/api/outputs/1/nope.png', { headers: H })
    expect(res.status).toBe(404)
  })
})

describe('zip download', () => {
  it('streams a zip with content', async () => {
    const res = await app.request('/api/batches/1/download', { headers: H })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)
    expect([buf[0], buf[1]]).toEqual([0x50, 0x4b]) // "PK"
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `pnpm --filter @cwe/server test`
Expected: FAIL — 路由 404

- [ ] **Step 3: 实现**

`apps/server/src/routes/events.ts`:

```ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppDeps } from '../app.js'

export function eventRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0
      const listener = (payload: { type: string }) => {
        void stream.writeSSE({
          event: payload.type,
          data: JSON.stringify(payload),
          id: String(++id),
        })
      }
      deps.events.on('event', listener)
      stream.onAbort(() => deps.events.off('event', listener))
      // 心跳防止代理断流；连接断开时循环退出
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '{}' })
        await stream.sleep(15_000)
      }
    }),
  )

  return app
}
```

`apps/server/src/routes/files.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { getBatchDetail } from '../db/repo.js'

export function uploadRoutes(deps: AppDeps) {
  const app = new Hono()

  app.post('/', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const raw = body['files']
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: 'no files' }, 400)
    const stored: Array<{ name: string; stored: string }> = []
    for (const file of files) {
      const safe = basename(file.name).replace(/[^\w.-]/g, '_')
      const name = `${randomBytes(4).toString('hex')}-${safe}`
      await writeFile(
        join(deps.config.dataDir, 'uploads', name),
        Buffer.from(await file.arrayBuffer()),
      )
      stored.push({ name: file.name, stored: name })
    }
    return c.json(stored, 201)
  })

  return app
}

export function outputRoutes(deps: AppDeps) {
  const app = new Hono()
  const root = resolve(deps.config.dataDir, 'outputs')

  app.get('/*', (c) => {
    const rel = decodeURIComponent(c.req.path.replace(/^\/api\/outputs\//, ''))
    const full = resolve(root, normalize(rel))
    if (!full.startsWith(root + '/')) return c.json({ error: 'invalid path' }, 400)
    if (!existsSync(full)) return c.json({ error: 'not found' }, 404)
    const stream = Readable.toWeb(createReadStream(full)) as ReadableStream
    return c.body(stream)
  })

  return app
}

export function downloadRoute(deps: AppDeps) {
  const app = new Hono()

  app.get('/:id/download', (c) => {
    const id = Number(c.req.param('id'))
    const dir = join(deps.config.dataDir, 'outputs', String(id))
    const detail = getBatchDetail(deps.db, id)
    const zipName = detail ? `${detail.batch.name}-${id}.zip` : `batch-${id}.zip`
    const archive = archiver('zip')
    if (existsSync(dir)) archive.directory(dir, false)
    void archive.finalize()
    c.header('Content-Type', 'application/zip')
    c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`)
    return c.body(Readable.toWeb(archive) as ReadableStream)
  })

  return app
}
```

`apps/server/src/app.ts` 的 `createApp` 中，在 `app.route('/api/batches', batchRoutes(deps))` 之前加：

```ts
import { eventRoutes } from './routes/events.js'
import { downloadRoute, outputRoutes, uploadRoutes } from './routes/files.js'
// ...
app.route('/api/events', eventRoutes(deps))
app.route('/api/uploads', uploadRoutes(deps))
app.route('/api/outputs', outputRoutes(deps))
app.route('/api/batches', downloadRoute(deps)) // 与 batchRoutes 并存，路径不冲突
```

- [ ] **Step 4: 验证通过并提交**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck && pnpm --filter @cwe/server build`
Expected: PASS

```bash
git add apps/server
git commit -m "feat(server): sse events, uploads, outputs static and zip download"
```

---

### Task 10: web 脚手架 — Vite + Tailwind + shadcn + 路由 + Login

**Files:**
- Replace: `apps/web/`（Vite React-TS 工程：`package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/index.css`, `src/App.tsx`, `src/lib/api.ts`, `src/lib/utils.ts`, `src/pages/login.tsx`, `components.json`）
- 通过 shadcn CLI 生成: `src/components/ui/{button,input,card,table,tabs,badge,progress,textarea,label,select}.tsx`

**Interfaces:**
- Consumes: server API（`/api/health` 验 token）
- Produces:
  - `api<T>(path, init?): Promise<T>`（自动带 Bearer；401 跳 `/login`）、`getToken()/setToken()`、`outputUrl(path: string)`、`downloadUrl(batchId: number)`（后两者带 `?token=`）
  - 路由骨架：`/login`、`/`（重定向 `/batches`）、`/templates`、`/templates/new`、`/batches`、`/batches/new`、`/batches/:id`（Task 11-13 填充页面，先放占位组件）
  - `RequireToken` 布局组件：无 token 重定向 `/login`；顶部导航

- [ ] **Step 1: 写 web 工程文件**

`apps/web/package.json`（完整替换占位版）:

```json
{
  "name": "@cwe/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "echo skip",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cwe/shared": "workspace:*",
    "@tanstack/react-query": "^5.81.5",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.525.0",
    "papaparse": "^5.5.3",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.6.3",
    "tailwind-merge": "^3.3.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.11",
    "@types/papaparse": "^5.3.16",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^4.6.0",
    "tailwindcss": "^4.1.11",
    "tw-animate-css": "^1.3.5",
    "typescript": "^5.8.3",
    "vite": "^7.0.3"
  }
}
```

`apps/web/vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
})
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

（`vite.config.ts` 需要 node types：在 devDependencies 已有 vite 提供 `vite/client`；`fileURLToPath` 需 `@types/node`——把 `"@types/node": "^22.15.0"` 也加进 web 的 devDependencies，并在 tsconfig `compilerOptions.types` 设为 `["vite/client", "node"]`。）

`apps/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Comfy Workflow Executor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`（shadcn neutral 主题，Tailwind v4，仅浅色）:

```css
@import 'tailwindcss';
@import 'tw-animate-css';

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

`apps/web/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

`apps/web/src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

`apps/web/src/lib/api.ts`:

```ts
const TOKEN_KEY = 'cwe_token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
    ...(init.headers as Record<string, string>),
  }
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`/api${path}`, { ...init, headers })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(await res.text())
  return res.json() as Promise<T>
}

/** <img>/<a> 无法带 header，用 query token */
export function outputUrl(path: string): string {
  return `/api/outputs/${path}?token=${encodeURIComponent(getToken())}`
}

export function downloadUrl(batchId: number): string {
  return `/api/batches/${batchId}/download?token=${encodeURIComponent(getToken())}`
}
```

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
```

`apps/web/src/App.tsx`:

```tsx
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { getToken } from '@/lib/api'
import LoginPage from '@/pages/login'

function Placeholder({ name }: { name: string }) {
  return <div className="text-muted-foreground">{name} — Task 11-13 实现</div>
}

function RequireToken() {
  const location = useLocation()
  if (!getToken()) return <Navigate to="/login" state={{ from: location }} replace />
  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-6 flex items-center gap-6 border-b pb-4">
        <span className="font-semibold">Comfy Workflow Executor</span>
        <Link to="/batches" className="text-sm hover:underline">
          Batches
        </Link>
        <Link to="/templates" className="text-sm hover:underline">
          Templates
        </Link>
      </nav>
      <Outlet />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireToken />}>
        <Route path="/" element={<Navigate to="/batches" replace />} />
        <Route path="/templates" element={<Placeholder name="Templates" />} />
        <Route path="/templates/new" element={<Placeholder name="Import Template" />} />
        <Route path="/batches" element={<Placeholder name="Batches" />} />
        <Route path="/batches/new" element={<Placeholder name="New Batch" />} />
        <Route path="/batches/:id" element={<Placeholder name="Batch Detail" />} />
      </Route>
    </Routes>
  )
}
```

`apps/web/src/pages/login.tsx`:

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { setToken } from '@/lib/api'

export default function LoginPage() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  async function submit() {
    const res = await fetch('/api/templates', {
      headers: { Authorization: `Bearer ${value}` },
    })
    if (!res.ok) {
      setError('Token 无效')
      return
    }
    setToken(value)
    navigate('/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-96">
        <CardHeader>
          <CardTitle>Comfy Workflow Executor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="password"
            placeholder="Access Token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={submit}>
            进入
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: 安装依赖并生成 shadcn 组件**

```bash
pnpm install
cd apps/web
pnpm dlx shadcn@latest add button input card table tabs badge progress textarea label select --yes
cd ../..
```

Expected: `src/components/ui/` 下生成 10 个组件文件（CLI 读取 components.json，非交互）。若 CLI 报错，检查 components.json 与 index.css 是否如上；CLI 可能追加 radix 依赖到 package.json——保留即可，重新 `pnpm install`。

- [ ] **Step 3: 验证并提交**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web build`
Expected: PASS，`apps/web/dist/` 生成

Run（手动冒烟，可选）: `pnpm dev` 后开 `http://localhost:5173/login`，输入 `dev-token` 能进入占位页。

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): vite react scaffold with shadcn, router and login"
```

---

### Task 11: Templates 页面 + 导入向导

**Files:**
- Create: `apps/web/src/pages/templates.tsx`, `apps/web/src/pages/template-import.tsx`, `apps/web/src/lib/comfy-parse.ts`
- Modify: `apps/web/src/App.tsx`（替换两个 Placeholder 路由）

**Interfaces:**
- Consumes: `api()`（Task 10）、`ParamDef`/`ParamType`（@cwe/shared）、server `GET/POST/DELETE /api/templates`
- Produces:
  - `parseNodeInputs(json): NodeInputRow[]`，`NodeInputRow = { nodeId; classType; inputName; value: string | number }`
  - `guessType(row): ParamType`（inputName 含 `seed` → seed；LoadImage.image → image；number 值 → number；否则 text）
  - Template 行类型（前端侧）：`TemplateDto = { id: number; name: string; comfyJson: Record<string, any>; params: ParamDef[]; createdAt: string }`

- [ ] **Step 1: 写解析工具**

`apps/web/src/lib/comfy-parse.ts`:

```ts
import type { ParamType } from '@cwe/shared'

export interface NodeInputRow {
  nodeId: string
  classType: string
  inputName: string
  value: string | number
}

/** API-format JSON → 所有字面量输入（数组值是节点连线，跳过） */
export function parseNodeInputs(json: Record<string, any>): NodeInputRow[] {
  return Object.entries(json).flatMap(([nodeId, node]) => {
    if (!node || typeof node !== 'object' || typeof node.inputs !== 'object') return []
    return Object.entries(node.inputs as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([inputName, value]) => ({
        nodeId,
        classType: String(node.class_type ?? '?'),
        inputName,
        value: value as string | number,
      }))
  })
}

export function guessType(row: NodeInputRow): ParamType {
  if (row.inputName.toLowerCase().includes('seed')) return 'seed'
  if (row.classType === 'LoadImage' && row.inputName === 'image') return 'image'
  if (typeof row.value === 'number') return 'number'
  return 'text'
}
```

- [ ] **Step 2: 写列表页**

`apps/web/src/pages/templates.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { ParamDef } from '@cwe/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'

export interface TemplateDto {
  id: number
  name: string
  comfyJson: Record<string, any>
  params: ParamDef[]
  createdAt: string
}

export default function TemplatesPage() {
  const qc = useQueryClient()
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Templates</h1>
        <Button asChild>
          <Link to="/templates/new">导入 Workflow</Link>
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>参数</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.name}</TableCell>
              <TableCell className="space-x-1">
                {t.params.map((p) => (
                  <Badge key={p.key} variant="secondary">
                    {p.key}:{p.type}
                  </Badge>
                ))}
              </TableCell>
              <TableCell>{t.createdAt}</TableCell>
              <TableCell className="space-x-2 text-right">
                <Button asChild size="sm" variant="outline">
                  <Link to={`/batches/new?template=${t.id}`}>新建 Batch</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(t.id)}>
                  删除
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {templates.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                还没有模板——先从 ComfyUI 导出 API-format JSON 再导入
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 3: 写导入向导**

`apps/web/src/pages/template-import.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ParamDef, ParamType } from '@cwe/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { guessType, parseNodeInputs, type NodeInputRow } from '@/lib/comfy-parse'

interface Selection {
  key: string
  type: ParamType
}

const rowId = (r: NodeInputRow) => `${r.nodeId}.${r.inputName}`

export default function TemplateImportPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [json, setJson] = useState<Record<string, any> | null>(null)
  const [rows, setRows] = useState<NodeInputRow[]>([])
  const [selected, setSelected] = useState<Record<string, Selection>>({})
  const [error, setError] = useState('')

  function onFile(file: File) {
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Record<string, any>
        const inputs = parseNodeInputs(parsed)
        if (inputs.length === 0) {
          setError('未解析到任何节点输入——请确认导出的是 API-format JSON（设置里开启 Dev Mode 后用 "Save (API Format)")')
          return
        }
        setJson(parsed)
        setRows(inputs)
        setSelected({})
        setError('')
        if (!name) setName(file.name.replace(/\.json$/, ''))
      } catch {
        setError('JSON 解析失败')
      }
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const params: ParamDef[] = rows
        .filter((r) => selected[rowId(r)])
        .map((r) => {
          const sel = selected[rowId(r)]!
          return {
            key: sel.key,
            label: sel.key,
            nodeId: r.nodeId,
            inputName: r.inputName,
            type: sel.type,
            default: r.value,
          }
        })
      return api('/templates', {
        method: 'POST',
        body: JSON.stringify({ name, comfyJson: json, params }),
      })
    },
    onSuccess: () => navigate('/templates'),
    onError: (e) => setError(e.message),
  })

  const chosenCount = Object.keys(selected).length

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">导入 Workflow</h1>
      <div className="flex items-center gap-4">
        <Input type="file" accept=".json" className="w-72" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <Input placeholder="模板名称" className="w-72" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            勾选要作为批量参数的输入并命名（其余输入保持导出时的值）：
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>节点</TableHead>
                <TableHead>输入</TableHead>
                <TableHead>当前值</TableHead>
                <TableHead>参数 key</TableHead>
                <TableHead>类型</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const id = rowId(r)
                const sel = selected[id]
                return (
                  <TableRow key={id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={!!sel}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = { ...prev }
                            if (e.target.checked) {
                              next[id] = { key: r.inputName, type: guessType(r) }
                            } else {
                              delete next[id]
                            }
                            return next
                          })
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {r.nodeId} · {r.classType}
                    </TableCell>
                    <TableCell>{r.inputName}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">
                      {String(r.value)}
                    </TableCell>
                    <TableCell>
                      {sel && (
                        <Input
                          className="h-8 w-36"
                          value={sel.key}
                          onChange={(e) =>
                            setSelected((prev) => ({ ...prev, [id]: { ...sel, key: e.target.value } }))
                          }
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      {sel && (
                        <Select
                          value={sel.type}
                          onValueChange={(v) =>
                            setSelected((prev) => ({ ...prev, [id]: { ...sel, type: v as ParamType } }))
                          }
                        >
                          <SelectTrigger className="h-8 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(['text', 'number', 'seed', 'image'] as const).map((t) => (
                              <SelectItem key={t} value={t}>
                                {t}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <Button disabled={!name || chosenCount === 0 || save.isPending} onClick={() => save.mutate()}>
            保存模板（{chosenCount} 个参数）
          </Button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 接入路由**

`apps/web/src/App.tsx` 中替换：

```tsx
import TemplatesPage from '@/pages/templates'
import TemplateImportPage from '@/pages/template-import'
// ...
<Route path="/templates" element={<TemplatesPage />} />
<Route path="/templates/new" element={<TemplateImportPage />} />
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web build`
Expected: PASS

手动冒烟（可选）：`pnpm dev`，登录后导入一个 ComfyUI API JSON，勾选参数保存，列表出现。

```bash
git add apps/web
git commit -m "feat(web): templates list and import wizard with param selection"
```

---

### Task 12: New Batch 页面（表格 / 矩阵 / 图片三入口）

**Files:**
- Create: `apps/web/src/pages/batch-new.tsx`
- Modify: `apps/web/src/App.tsx`（替换 Placeholder）

**Interfaces:**
- Consumes: `expandMatrix`、`ParamValues`（@cwe/shared）、`api()`、`TemplateDto`（Task 11）、`POST /api/uploads`（返回 `[{ name, stored }]`）、`POST /api/templates/:id/batches`
- Produces: 页面 `/batches/new?template=<id>`；提交后跳 `/batches/:id`

- [ ] **Step 1: 写页面**

`apps/web/src/pages/batch-new.tsx`:

```tsx
import { useMutation, useQuery } from '@tanstack/react-query'
import Papa from 'papaparse'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { expandMatrix, type ParamValues } from '@cwe/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { TemplateDto } from '@/pages/templates'

export default function BatchNewPage() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
  })
  const [templateId, setTemplateId] = useState(search.get('template') ?? '')
  const template = templates.find((t) => String(t.id) === templateId)
  const [name, setName] = useState('')
  const [jobs, setJobs] = useState<ParamValues[]>([])
  const [error, setError] = useState('')

  const submit = useMutation({
    mutationFn: () =>
      api<{ id: number }>(`/templates/${templateId}/batches`, {
        method: 'POST',
        body: JSON.stringify({ name: name || `batch-${Date.now()}`, jobs }),
      }),
    onSuccess: (b) => navigate(`/batches/${b.id}`),
    onError: (e) => setError(e.message),
  })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New Batch</h1>
      <div className="flex items-end gap-4">
        <div className="space-y-1">
          <Label>模板</Label>
          <Select value={templateId} onValueChange={(v) => { setTemplateId(v); setJobs([]) }}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="选择模板" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Batch 名称</Label>
          <Input className="w-64" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      {template && (
        <Tabs defaultValue="table" onValueChange={() => setJobs([])}>
          <TabsList>
            <TabsTrigger value="table">表格 / CSV</TabsTrigger>
            <TabsTrigger value="matrix">矩阵组合</TabsTrigger>
            <TabsTrigger value="images">批量图片</TabsTrigger>
          </TabsList>
          <TabsContent value="table">
            <TableEntry template={template} onChange={setJobs} />
          </TabsContent>
          <TabsContent value="matrix">
            <MatrixEntry template={template} onChange={setJobs} />
          </TabsContent>
          <TabsContent value="images">
            <ImagesEntry template={template} onChange={setJobs} />
          </TabsContent>
        </Tabs>
      )}

      {jobs.length > 0 && template && (
        <div className="space-y-2 rounded-md border p-4">
          <p className="text-sm font-medium">预览：共 {jobs.length} 个任务（最多显示 20 行）</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                {template.params.map((p) => (
                  <TableHead key={p.key}>{p.key}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.slice(0, 20).map((row, i) => (
                <TableRow key={i}>
                  <TableCell>{i}</TableCell>
                  {template.params.map((p) => (
                    <TableCell key={p.key} className="max-w-48 truncate">
                      {String(row[p.key] ?? p.default ?? '')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
            提交 {jobs.length} 个任务
          </Button>
        </div>
      )}
    </div>
  )
}

function TableEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const [rows, setRows] = useState<ParamValues[]>([{}])
  const [csvOpen, setCsvOpen] = useState(false)
  const [csvText, setCsvText] = useState('')

  function update(next: ParamValues[]) {
    setRows(next)
    onChange(next.filter((r) => Object.keys(r).length > 0))
  }

  function importCsv() {
    const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
      header: true,
      skipEmptyLines: true,
    })
    const keys = new Set(template.params.map((p) => p.key))
    const imported = parsed.data.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k, v]) => keys.has(k) && v !== '')),
    )
    update(imported)
    setCsvOpen(false)
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            {template.params.map((p) => (
              <TableHead key={p.key}>{p.key}</TableHead>
            ))}
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {template.params.map((p) => (
                <TableCell key={p.key}>
                  <Input
                    className="h-8"
                    placeholder={String(p.default ?? '')}
                    value={String(row[p.key] ?? '')}
                    onChange={(e) => {
                      const next = rows.map((r, j) =>
                        j === i ? { ...r, [p.key]: e.target.value } : r,
                      )
                      update(next)
                    }}
                  />
                </TableCell>
              ))}
              <TableCell>
                <Button size="sm" variant="ghost" onClick={() => update(rows.filter((_, j) => j !== i))}>
                  ✕
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => update([...rows, {}])}>
          + 加一行
        </Button>
        <Button size="sm" variant="outline" onClick={() => setCsvOpen((v) => !v)}>
          粘贴 CSV
        </Button>
      </div>
      {csvOpen && (
        <div className="space-y-2">
          <Textarea
            rows={6}
            placeholder={`表头需与参数 key 一致，如：\n${template.params.map((p) => p.key).join(',')}\n...`}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <Button size="sm" onClick={importCsv}>
            导入
          </Button>
        </div>
      )}
    </div>
  )
}

function MatrixEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const [axes, setAxes] = useState<Record<string, string>>({})

  const parsed = useMemo(() => {
    const out: Record<string, Array<string | number>> = {}
    for (const p of template.params) {
      const lines = (axes[p.key] ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      out[p.key] =
        p.type === 'number' || p.type === 'seed' ? lines.map(Number).filter((n) => !Number.isNaN(n)) : lines
    }
    return out
  }, [axes, template])

  const count = Object.values(parsed).reduce((acc, v) => acc * Math.max(v.length, 1), 1)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {template.params.map((p) => (
          <div key={p.key} className="space-y-1">
            <Label>
              {p.key}（{p.type}，一行一个值{p.default !== undefined ? `，留空用默认 ${p.default}` : ''}）
            </Label>
            <Textarea
              rows={4}
              value={axes[p.key] ?? ''}
              onChange={(e) => setAxes((prev) => ({ ...prev, [p.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <Button size="sm" onClick={() => onChange(expandMatrix(parsed))}>
        生成组合（约 {count} 个任务）
      </Button>
    </div>
  )
}

function ImagesEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const imageParams = template.params.filter((p) => p.type === 'image')
  const otherParams = template.params.filter((p) => p.type !== 'image')
  const [imageKey, setImageKey] = useState(imageParams[0]?.key ?? '')
  const [shared, setShared] = useState<ParamValues>({})
  const [uploading, setUploading] = useState(false)

  async function onFiles(files: FileList) {
    setUploading(true)
    try {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      onChange(stored.map((s) => ({ ...shared, [imageKey]: s.stored })))
    } finally {
      setUploading(false)
    }
  }

  if (imageParams.length === 0) {
    return <p className="text-sm text-muted-foreground">该模板没有 image 类型参数</p>
  }

  return (
    <div className="space-y-4">
      {imageParams.length > 1 && (
        <div className="space-y-1">
          <Label>图片填充到哪个参数</Label>
          <Select value={imageKey} onValueChange={setImageKey}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {imageParams.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        {otherParams.map((p) => (
          <div key={p.key} className="space-y-1">
            <Label>{p.key}（所有任务共享）</Label>
            <Input
              placeholder={String(p.default ?? '')}
              value={String(shared[p.key] ?? '')}
              onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <Input
        type="file"
        multiple
        accept="image/*"
        disabled={uploading}
        onChange={(e) => e.target.files?.length && onFiles(e.target.files)}
      />
      {uploading && <p className="text-sm text-muted-foreground">上传中…</p>}
    </div>
  )
}
```

- [ ] **Step 2: 接入路由**

`apps/web/src/App.tsx`：

```tsx
import BatchNewPage from '@/pages/batch-new'
// ...
<Route path="/batches/new" element={<BatchNewPage />} />
```

- [ ] **Step 3: 验证并提交**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web build`
Expected: PASS

```bash
git add apps/web
git commit -m "feat(web): new batch page with table/matrix/images param entry"
```

---

### Task 13: Batches 列表 + 详情（SSE 实时、画廊、下载）

**Files:**
- Create: `apps/web/src/pages/batches.tsx`, `apps/web/src/pages/batch-detail.tsx`, `apps/web/src/hooks/use-events.ts`
- Modify: `apps/web/src/App.tsx`（替换 Placeholder，删除 Placeholder 组件）

**Interfaces:**
- Consumes: `api()/outputUrl()/downloadUrl()`（Task 10）、`GET /api/batches`、`GET /api/batches/:id`、cancel/retry 端点、`GET /api/events`（SSE，事件名 `job-updated`/`batch-updated`/`progress`）
- Produces:
  - `useEvents(): Record<number, { value: number; max: number }>` — 订阅 SSE；`job-updated`/`batch-updated` 时 invalidate `['batches']` 前缀查询；返回按 jobId 的进度表
  - `BatchSummaryDto = { id; templateId; name; status; createdAt; templateName; total; succeeded; failed }`
  - `JobDto = { id; batchId; sortOrder; params: ParamValues; status; error: string | null; outputs: Array<{ path: string; filename: string }> | null; comfyPromptId: string | null; startedAt: string | null; finishedAt: string | null }`

- [ ] **Step 1: 写 SSE hook**

`apps/web/src/hooks/use-events.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { getToken } from '@/lib/api'

export interface JobProgress {
  value: number
  max: number
}

export function useEvents(): Record<number, JobProgress> {
  const qc = useQueryClient()
  const [progress, setProgress] = useState<Record<number, JobProgress>>({})

  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)
    const invalidate = () => void qc.invalidateQueries({ queryKey: ['batches'] })
    es.addEventListener('job-updated', invalidate)
    es.addEventListener('batch-updated', invalidate)
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { jobId: number; value: number; max: number }
      setProgress((prev) => ({ ...prev, [d.jobId]: { value: d.value, max: d.max } }))
    })
    return () => es.close()
  }, [qc])

  return progress
}
```

- [ ] **Step 2: 写列表页**

`apps/web/src/pages/batches.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { BatchStatus } from '@cwe/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useEvents } from '@/hooks/use-events'
import { api } from '@/lib/api'

export interface BatchSummaryDto {
  id: number
  templateId: number
  name: string
  status: BatchStatus
  createdAt: string
  templateName: string
  total: number
  succeeded: number
  failed: number
}

export const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'default',
  completed: 'secondary',
  canceled: 'outline',
  succeeded: 'secondary',
  failed: 'destructive',
}

export default function BatchesPage() {
  useEvents()
  const { data: batches = [] } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Batches</h1>
        <Button asChild>
          <Link to="/batches/new">New Batch</Link>
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>模板</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>进度</TableHead>
            <TableHead>创建时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((b) => (
            <TableRow key={b.id}>
              <TableCell>
                <Link to={`/batches/${b.id}`} className="font-medium hover:underline">
                  {b.name}
                </Link>
              </TableCell>
              <TableCell>{b.templateName}</TableCell>
              <TableCell>
                <Badge variant={statusVariant[b.status]}>{b.status}</Badge>
              </TableCell>
              <TableCell>
                {b.succeeded + b.failed}/{b.total}
                {b.failed > 0 && <span className="ml-1 text-destructive">({b.failed} 失败)</span>}
              </TableCell>
              <TableCell>{b.createdAt}</TableCell>
            </TableRow>
          ))}
          {batches.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                还没有 batch
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 3: 写详情页**

`apps/web/src/pages/batch-detail.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import type { BatchStatus, JobStatus, ParamValues } from '@cwe/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useEvents } from '@/hooks/use-events'
import { api, downloadUrl, outputUrl } from '@/lib/api'
import { statusVariant } from '@/pages/batches'
import type { TemplateDto } from '@/pages/templates'

export interface JobDto {
  id: number
  batchId: number
  sortOrder: number
  params: ParamValues
  status: JobStatus
  error: string | null
  outputs: Array<{ path: string; filename: string }> | null
  comfyPromptId: string | null
  startedAt: string | null
  finishedAt: string | null
}

interface BatchDetailDto {
  batch: { id: number; name: string; status: BatchStatus; createdAt: string }
  template: TemplateDto
  jobs: JobDto[]
}

export default function BatchDetailPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const progress = useEvents()
  const { data } = useQuery({
    queryKey: ['batches', id],
    queryFn: () => api<BatchDetailDto>(`/batches/${id}`),
  })

  const act = useMutation({
    mutationFn: (action: 'cancel' | 'retry-failed') =>
      api(`/batches/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['batches'] }),
  })

  if (!data) return null
  const { batch, template, jobs } = data
  const done = jobs.filter((j) => ['succeeded', 'failed', 'canceled'].includes(j.status)).length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const gallery = jobs.filter((j) => j.status === 'succeeded').flatMap((j) => (j.outputs ?? []).map((o) => ({ job: j, output: o })))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{batch.name}</h1>
          <Badge variant={statusVariant[batch.status]}>{batch.status}</Badge>
          <span className="text-sm text-muted-foreground">模板：{template.name}</span>
        </div>
        <div className="space-x-2">
          {failed > 0 && (
            <Button variant="outline" onClick={() => act.mutate('retry-failed')}>
              重试失败任务（{failed}）
            </Button>
          )}
          {['pending', 'running'].includes(batch.status) && (
            <Button variant="destructive" onClick={() => act.mutate('cancel')}>
              取消
            </Button>
          )}
          <Button asChild variant="outline">
            <a href={downloadUrl(batch.id)}>下载 ZIP</a>
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <Progress value={(done / Math.max(jobs.length, 1)) * 100} />
        <p className="text-sm text-muted-foreground">
          {done}/{jobs.length} 完成
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>参数</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>输出 / 错误</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((j) => (
            <TableRow key={j.id}>
              <TableCell>{j.sortOrder}</TableCell>
              <TableCell className="max-w-96 truncate font-mono text-xs">
                {JSON.stringify(j.params)}
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant[j.status]}>{j.status}</Badge>
                {j.status === 'running' && progress[j.id] && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {progress[j.id]!.value}/{progress[j.id]!.max}
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-96 truncate text-xs">
                {j.error ? (
                  <span className="text-destructive">{j.error}</span>
                ) : (
                  (j.outputs ?? []).map((o) => o.filename).join(', ')
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {gallery.length > 0 && (
        <div>
          <h2 className="mb-3 font-medium">结果画廊（{gallery.length}）</h2>
          <div className="grid grid-cols-4 gap-4">
            {gallery.map(({ job, output }) => (
              <a
                key={output.path}
                href={outputUrl(output.path)}
                target="_blank"
                rel="noreferrer"
                className="group space-y-1"
              >
                <img
                  src={outputUrl(output.path)}
                  alt={output.filename}
                  loading="lazy"
                  className="aspect-square w-full rounded-md border object-cover transition group-hover:opacity-80"
                />
                <p className="truncate font-mono text-xs text-muted-foreground">
                  #{job.sortOrder} {JSON.stringify(job.params)}
                </p>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 接入路由并清理**

`apps/web/src/App.tsx`（最终形态）:

```tsx
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { getToken } from '@/lib/api'
import BatchDetailPage from '@/pages/batch-detail'
import BatchNewPage from '@/pages/batch-new'
import BatchesPage from '@/pages/batches'
import LoginPage from '@/pages/login'
import TemplateImportPage from '@/pages/template-import'
import TemplatesPage from '@/pages/templates'

function RequireToken() {
  const location = useLocation()
  if (!getToken()) return <Navigate to="/login" state={{ from: location }} replace />
  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-6 flex items-center gap-6 border-b pb-4">
        <span className="font-semibold">Comfy Workflow Executor</span>
        <Link to="/batches" className="text-sm hover:underline">
          Batches
        </Link>
        <Link to="/templates" className="text-sm hover:underline">
          Templates
        </Link>
      </nav>
      <Outlet />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireToken />}>
        <Route path="/" element={<Navigate to="/batches" replace />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/new" element={<TemplateImportPage />} />
        <Route path="/batches" element={<BatchesPage />} />
        <Route path="/batches/new" element={<BatchNewPage />} />
        <Route path="/batches/:id" element={<BatchDetailPage />} />
      </Route>
    </Routes>
  )
}
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web build && pnpm test`
Expected: 全 PASS

```bash
git add apps/web
git commit -m "feat(web): batches list and detail with sse progress, gallery and zip download"
```

---

### Task 14: 生产化 — 静态托管 + Dockerfile + compose + README

**Files:**
- Modify: `apps/server/src/index.ts`（生产环境托管 `./public` + SPA fallback）
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`, `README.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: `docker compose up -d --build` 一键运行；镜像内 web 产物在 `/app/public`

- [ ] **Step 1: server 托管静态产物**

`apps/server/src/index.ts` 在 `serve(...)` 之前加：

```ts
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
// ...（放在 createApp 之后）
if (existsSync('./public')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('/*', serveStatic({ path: './public/index.html' })) // SPA fallback
}
```

（`mkdirSync` 已从 `node:fs` 导入，把 `existsSync` 合并进同一 import。）

- [ ] **Step 2: 写 Docker 相关文件**

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
data
.git
.env
docs
```

`Dockerfile`:

```dockerfile
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @cwe/web build && pnpm --filter @cwe/server build
# pnpm v10+ deploy 需要 --legacy（shared 已被 tsup 打进 server dist，无需 workspace 链接）
RUN pnpm --filter @cwe/server deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/web/dist ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
VOLUME /data
CMD ["node", "dist/index.js"]
```

`compose.yaml`:

```yaml
services:
  executor:
    build: .
    ports:
      - '${HOST_PORT:-8080}:8080'
    environment:
      COMFYUI_URL: ${COMFYUI_URL:-http://host.docker.internal:8188}
      AUTH_TOKEN: ${AUTH_TOKEN:?set AUTH_TOKEN in .env}
    volumes:
      - data:/data
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    restart: unless-stopped

volumes:
  data:
```

- [ ] **Step 3: 写 README**

`README.md`:

````markdown
# comfy-workflow-executor

批量执行 ComfyUI workflow 的轻量执行器：导入 API-format workflow JSON、圈选参数保存为模板，
用表格/CSV、笛卡尔积矩阵或批量图片生成一批任务，串行提交给一个已运行的 ComfyUI，
结果落盘 + Web 画廊 + zip 下载。SQLite 持久化队列，重启自动恢复。

设计文档：`docs/superpowers/specs/2026-07-24-comfy-workflow-executor-design.md`

## 本地开发

需要 Node >= 22 与 pnpm 11：

```bash
pnpm install
pnpm test          # 全部离线单测
pnpm dev           # server :8080 + web :5173（/api 自动代理）
```

开发模式 Token 默认 `dev-token`；ComfyUI 地址用 `COMFYUI_URL` 覆盖（默认 `http://127.0.0.1:8188`）。

## Docker Compose 部署（本地 / VPS / GPU 主机）

```bash
cp .env.example .env   # 修改 AUTH_TOKEN 和 COMFYUI_URL
docker compose up -d --build
```

打开 `http://<host>:8080`，输入 `.env` 里的 `AUTH_TOKEN` 登录。

- ComfyUI 在宿主机时保持默认 `http://host.docker.internal:8188`
- SQLite 与输出文件在 named volume `data` 中，容器重建不丢
- 执行器重启后未完成的 batch 自动继续

## 使用流程

1. ComfyUI 开启 Dev Mode，用 **Save (API Format)** 导出 workflow JSON
2. Templates → 导入 Workflow → 勾选要批量变化的输入（prompt/seed/image…）并命名
3. New Batch → 三种方式生成任务：表格/CSV、矩阵组合、批量图片
4. Batches 详情页看实时进度与画廊，完成后下载 zip

## 边界（V1）

单 ComfyUI 实例、串行执行；不自动重试（提供手动「重试失败任务」）；
不管理 ComfyUI 生命周期；无多用户。
````

- [ ] **Step 4: 验证**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: 全 PASS

Run: `docker build -t cwe-test .`
Expected: 镜像构建成功（若 `pnpm deploy --legacy` 报错提示不认识 `--legacy`，去掉该 flag 重试——pnpm 版本差异）

Run（可选完整冒烟）: `AUTH_TOKEN=t docker compose up -d --build` 后 `curl http://127.0.0.1:8080/api/health` 返回 `{"ok":true,"comfy":false}`，`docker compose down`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: production static serving, dockerfile, compose and readme"
```

---

## Self-Review 记录

- **Spec 覆盖**：模板导入/圈选（Task 11）、三种参数入口（Task 12）、串行 executor + claim + 恢复（Task 8）、SQLite 事实源（Task 5）、SSE 进度（Task 9/13）、画廊/zip/落盘（Task 8/9/13）、单 Token（Task 4）、compose 部署（Task 14）、测试策略三块（Task 2/3/5/8）——全部有对应任务。
- **取消语义**：cancel 路由（Task 6）+ repo.cancelBatch 守卫（Task 5）+ executor finish/fail 仅作用于 running 状态，覆盖设计中的 interrupt 尽力而为语义。
- **类型一致性**：`OutputFile { path, filename }`、`AppDeps`、repo 函数签名、SSE 事件名 `job-updated/batch-updated/progress` 在 server 与 web 两侧一致。
- **已知取舍**：uploads 的 stored 文件名用 8 位 hex（`randomBytes(4)`）；web 端 DTO 手写而非从 server 导出（避免 web 依赖 server 包，结构与 server drizzle 行类型保持一致）。
````
