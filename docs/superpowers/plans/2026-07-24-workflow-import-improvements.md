# Workflow 导入体验改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导入支持 UI/graph 格式(后端转换)、粘贴、PNG 元数据提取;参数圈选改为分组+搜索+智能预选;新增 enum 参数类型(可选值来自 ComfyUI `/object_info`);导入时做模型存在性校验(警告不阻断)。

**Architecture:** 后端新增 `graph-convert.ts`(纯函数 graph→API 转换,依赖 `/object_info` 的 widget 定义)、`object-info-cache.ts`(5 分钟 TTL 内存缓存)、`routes/comfy.ts`(convert / validate / input-options 三个端点)。前端新增 `png-meta.ts`(PNG chunk 解析)、`suggest-params.ts`(常用参数预选)、`detectFormat`,重构 `template-import.tsx` 为分组卡片,`batch-new.tsx` 增加枚举下拉/多选。spec 见 `docs/superpowers/specs/2026-07-24-workflow-import-improvements-design.md`。

**Tech Stack:** TypeScript strict / ESM / Node ≥22;Hono 4;Zod v4;vitest 3(本计划为 @cwe/web 首次引入 vitest);React 19 + shadcn/ui。

## Global Constraints

- 全部 ESM、TS strict;UI 与错误文案用中文;API 错误响应统一 `{ error: string }` JSON
- 现有测试(server 51 + shared 9)必须保持全绿;不修改既有测试的断言语义(允许因接口新增方法而扩展 fake)
- pnpm 11.7:新增依赖用 `pnpm --filter <pkg> add -D <dep>`;不要动 `pnpm-workspace.yaml` 的 `allowBuilds`,不要在仓库级配置里加 `minimum-release-age`
- `/object_info` 相关逻辑不得阻塞 API 格式导入:ComfyUI 离线时 convert 返回 503、validate 返回 `{skipped:true}`、input-options 返回 503,前端全部有降级
- 不打印、不提交 `.env` 与任何 token
- 提交信息用 conventional commits(feat/fix/test/docs),结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 在功能分支 `feat/import-improvements` 上开发(执行时由 worktree/branch 流程建立)

---

### Task 1: shared — ParamType 增加 `enum` 与 `enumRef`

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/test/types.test.ts`(新建)

**Interfaces:**
- Consumes: 无
- Produces: `paramTypeSchema` 含 `'enum'`;`paramDefSchema` 新增可选字段 `enumRef?: { classType: string; inputName: string }`;导出 `enumRefSchema`。后续任务(路由校验、web 圈选、batch-new)都依赖 `ParamDef['enumRef']` 这个形状。

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/test/types.test.ts
import { describe, expect, it } from 'vitest'
import { paramDefSchema, paramTypeSchema } from '../src/index.js'

describe('paramDefSchema enum 支持', () => {
  it('paramTypeSchema 接受 enum', () => {
    expect(paramTypeSchema.parse('enum')).toBe('enum')
  })

  it('接受带 enumRef 的 enum 参数', () => {
    const def = paramDefSchema.parse({
      key: 'ckpt',
      label: 'ckpt',
      nodeId: '4',
      inputName: 'ckpt_name',
      type: 'enum',
      enumRef: { classType: 'CheckpointLoaderSimple', inputName: 'ckpt_name' },
      default: 'a.safetensors',
    })
    expect(def.enumRef?.classType).toBe('CheckpointLoaderSimple')
  })

  it('enumRef 可省略(旧数据兼容)', () => {
    const def = paramDefSchema.parse({
      key: 'p', label: 'p', nodeId: '6', inputName: 'text', type: 'text',
    })
    expect(def.enumRef).toBeUndefined()
  })

  it('拒绝空 classType 的 enumRef', () => {
    expect(() =>
      paramDefSchema.parse({
        key: 'k', label: 'k', nodeId: '1', inputName: 'x', type: 'enum',
        enumRef: { classType: '', inputName: 'x' },
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cwe/shared exec vitest run test/types.test.ts`
Expected: FAIL(`'enum'` 不在枚举里 / `enumRef` 被 strip 后为 undefined 但第 2 例 parse 抛错)

- [ ] **Step 3: 实现**

`packages/shared/src/types.ts` 顶部两个 schema 改为:

```ts
export const paramTypeSchema = z.enum(['text', 'number', 'seed', 'image', 'enum'])
export type ParamType = z.infer<typeof paramTypeSchema>

/** enum 参数指向的 object_info 输入(用于批量填参时拉取可选值) */
export const enumRefSchema = z.object({
  classType: z.string().min(1),
  inputName: z.string().min(1),
})
export type EnumRef = z.infer<typeof enumRefSchema>

export const paramDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  nodeId: z.string().min(1),
  inputName: z.string().min(1),
  type: paramTypeSchema,
  enumRef: enumRefSchema.optional(),
  default: z.union([z.string(), z.number()]).optional(),
})
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `pnpm --filter @cwe/shared test && pnpm --filter @cwe/server test`
Expected: 全部 PASS(server 测试不受影响——字段是可选的)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/test/types.test.ts
git commit -m "feat(shared): param type 'enum' with enumRef"
```

---

### Task 2: server — `getObjectInfo` + FakeComfy 抽取 + ObjectInfoCache

**Files:**
- Modify: `apps/server/src/comfy/client.ts`
- Create: `apps/server/src/comfy/object-info-cache.ts`
- Create: `apps/server/test/fake-comfy.ts`(从 `executor.test.ts` 抽出 FakeComfy 并扩展)
- Modify: `apps/server/test/executor.test.ts`(改为 import FakeComfy)
- Test: `apps/server/test/object-info-cache.test.ts`(新建)

**Interfaces:**
- Consumes: 现有 `ComfyClient` 接口
- Produces:
  - `client.ts` 新增导出 `type ObjectInfoMap = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>`
  - `ComfyClient` 接口新增方法 `getObjectInfo(): Promise<ObjectInfoMap>`
  - `ObjectInfoCache` 类:`constructor(comfy: ComfyClient, ttlMs = 5 * 60_000)`,`get(refresh = false): Promise<ObjectInfoMap>`
  - `test/fake-comfy.ts` 导出 `class FakeComfy implements ComfyClient`,含公开字段 `objectInfo: ObjectInfoMap = {}` 与 `objectInfoCalls = 0`(Task 4 的路由测试复用)

- [ ] **Step 1: 抽取 FakeComfy 到独立文件并扩展**

新建 `apps/server/test/fake-comfy.ts`,内容为 `executor.test.ts` 第 13-64 行的 `FakeComfy` 类原样搬移(连同其 import:`writeFile`、`basename`、`ComfyClient`、`ComfyHistoryEntry`、`OutputRef` 类型),加 `export`,并追加两个成员:

```ts
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ComfyClient, ComfyHistoryEntry, ObjectInfoMap, OutputRef } from '../src/comfy/client.js'

export class FakeComfy implements ComfyClient {
  // …原有字段与方法全部保留…
  objectInfo: ObjectInfoMap = {}
  objectInfoCalls = 0

  async getObjectInfo() {
    this.objectInfoCalls++
    return this.objectInfo
  }
}
```

`executor.test.ts` 删除类定义,改为 `import { FakeComfy } from './fake-comfy.js'`。

- [ ] **Step 2: 写 ObjectInfoCache 失败测试**

```ts
// apps/server/test/object-info-cache.test.ts
import { describe, expect, it } from 'vitest'
import { ObjectInfoCache } from '../src/comfy/object-info-cache.js'
import { FakeComfy } from './fake-comfy.js'

describe('ObjectInfoCache', () => {
  it('TTL 内命中缓存,只拉一次', async () => {
    const comfy = new FakeComfy()
    comfy.objectInfo = { KSampler: {} }
    const cache = new ObjectInfoCache(comfy, 60_000)
    expect(await cache.get()).toEqual({ KSampler: {} })
    await cache.get()
    expect(comfy.objectInfoCalls).toBe(1)
  })

  it('refresh=true 强制重新拉取', async () => {
    const comfy = new FakeComfy()
    const cache = new ObjectInfoCache(comfy, 60_000)
    await cache.get()
    await cache.get(true)
    expect(comfy.objectInfoCalls).toBe(2)
  })

  it('TTL=0 时每次都重新拉取', async () => {
    const comfy = new FakeComfy()
    const cache = new ObjectInfoCache(comfy, 0)
    await cache.get()
    await cache.get()
    expect(comfy.objectInfoCalls).toBe(2)
  })

  it('拉取失败时不缓存错误,下次重试', async () => {
    const comfy = new FakeComfy()
    let fail = true
    comfy.getObjectInfo = async () => {
      if (fail) throw new Error('down')
      return { OK: {} }
    }
    const cache = new ObjectInfoCache(comfy, 60_000)
    await expect(cache.get()).rejects.toThrow('down')
    fail = false
    expect(await cache.get()).toEqual({ OK: {} })
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/object-info-cache.test.ts`
Expected: FAIL(模块不存在;且 `ObjectInfoMap`/`getObjectInfo` 未定义导致类型错误)

- [ ] **Step 4: 实现 client.ts 扩展与缓存**

`apps/server/src/comfy/client.ts`:在 `ComfyWsEvent` 定义后新增类型,在接口与实现中新增方法:

```ts
/** GET /object_info 返回的节点定义(仅声明本项目用到的 input 部分) */
export type ObjectInfoMap = Record<
  string,
  { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }
>
```

`ComfyClient` 接口内(`getQueuedIds` 之后)加:

```ts
  /** 全量节点定义,体积较大,调用方应走 ObjectInfoCache */
  getObjectInfo(): Promise<ObjectInfoMap>
```

`createComfyClient` 返回对象内(`getQueuedIds` 实现之后)加:

```ts
    async getObjectInfo() {
      const res = await fetch(`${http}/object_info`)
      if (!res.ok) throw new Error(`object_info failed: ${res.status}`)
      return (await res.json()) as ObjectInfoMap
    },
```

新建 `apps/server/src/comfy/object-info-cache.ts`:

```ts
import type { ComfyClient, ObjectInfoMap } from './client.js'

/** /object_info 内存缓存:convert / validate / input-options 共用,默认 5 分钟 TTL */
export class ObjectInfoCache {
  private data: ObjectInfoMap | null = null
  private fetchedAt = 0

  constructor(
    private comfy: ComfyClient,
    private ttlMs = 5 * 60_000,
  ) {}

  async get(refresh = false): Promise<ObjectInfoMap> {
    if (!refresh && this.data && Date.now() - this.fetchedAt < this.ttlMs) return this.data
    const fresh = await this.comfy.getObjectInfo()
    this.data = fresh
    this.fetchedAt = Date.now()
    return fresh
  }
}
```

- [ ] **Step 5: 运行确认通过 + 全量回归**

Run: `pnpm --filter @cwe/server test`
Expected: 全部 PASS(含搬移后的 executor.test.ts)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/comfy/client.ts apps/server/src/comfy/object-info-cache.ts apps/server/test/fake-comfy.ts apps/server/test/executor.test.ts apps/server/test/object-info-cache.test.ts
git commit -m "feat(server): comfy getObjectInfo + ObjectInfoCache, extract FakeComfy helper"
```

---

### Task 3: server — graph→API 转换器

**Files:**
- Create: `apps/server/src/comfy/graph-convert.ts`
- Test: `apps/server/test/graph-convert.test.ts`

**Interfaces:**
- Consumes: `ObjectInfoMap`(Task 2)
- Produces:
  - `convertGraphToApi(graph: GraphJson, objectInfo: ObjectInfoMap): Record<string, any>` — 输出 API 格式 `{ [nodeId]: { class_type, inputs, _meta: { title } } }`
  - `class ConvertError extends Error { missingTypes: string[] }`
  - `interface GraphJson { nodes: GraphNode[]; links: Array<...|null> }`(供路由做形状检查)

- [ ] **Step 1: 写失败测试(含夹具)**

```ts
// apps/server/test/graph-convert.test.ts
import { describe, expect, it } from 'vitest'
import type { ObjectInfoMap } from '../src/comfy/client.js'
import { ConvertError, convertGraphToApi, type GraphJson } from '../src/comfy/graph-convert.js'

/** 录制自真实 /object_info 的最小片段(input 顺序与真实一致) */
const objectInfo: ObjectInfoMap = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } },
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
  },
  EmptySD3LatentImage: {
    input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } },
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m']],
        scheduler: [['simple', 'karras']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', {}],
      },
    },
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } },
  },
  LoraLoader: {
    input: {
      required: {
        model: ['MODEL'],
        clip: ['CLIP'],
        lora_name: [['l.safetensors']],
        strength_model: ['FLOAT', {}],
        strength_clip: ['FLOAT', {}],
      },
    },
  },
  LoadImage: {
    input: { required: { image: [['x.png'], { image_upload: true }] } },
  },
}

// 基础 txt2img 图:1=ckpt 2=pos-clip 3=neg-clip 4=latent 5=ksampler 6=vaedecode 7=save
// 8=Reroute(2→8→5.positive) 9=PrimitiveNode(STRING→3.text) 20=Note
// links: [id, srcId, srcSlot, dstId, dstSlot, type]
const baseGraph: GraphJson = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
      outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2, 3] }, { name: 'VAE', type: 'VAE', links: [4] }] },
    { id: 2, type: 'CLIPTextEncode', title: '正向提示词', widgets_values: ['a cat'],
      inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [10] }] },
    { id: 3, type: 'CLIPTextEncode', widgets_values: ['占位将被 primitive 覆盖'],
      inputs: [
        { name: 'clip', type: 'CLIP', link: 3 },
        { name: 'text', type: 'STRING', link: 12, widget: { name: 'text' } },
      ],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }] },
    { id: 4, type: 'EmptySD3LatentImage', widgets_values: [512, 512, 1],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }] },
    { id: 5, type: 'KSampler', widgets_values: [42, 'randomize', 4, 1, 'euler', 'simple', 1],
      inputs: [
        { name: 'model', type: 'MODEL', link: 1 },
        { name: 'positive', type: 'CONDITIONING', link: 11 },
        { name: 'negative', type: 'CONDITIONING', link: 6 },
        { name: 'latent_image', type: 'LATENT', link: 7 },
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }] },
    { id: 6, type: 'VAEDecode',
      inputs: [
        { name: 'samples', type: 'LATENT', link: 8 },
        { name: 'vae', type: 'VAE', link: 4 },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }] },
    { id: 7, type: 'SaveImage', widgets_values: ['ComfyUI'],
      inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] },
    { id: 8, type: 'Reroute',
      inputs: [{ name: '', type: '*', link: 10 }],
      outputs: [{ name: '', type: 'CONDITIONING', links: [11] }] },
    { id: 9, type: 'PrimitiveNode', widgets_values: ['from primitive'],
      outputs: [{ name: 'STRING', type: 'STRING', links: [12] }] },
    { id: 20, type: 'Note', widgets_values: ['随便写点'] },
  ],
  links: [
    [1, 1, 0, 5, 0, 'MODEL'],
    [2, 1, 1, 2, 0, 'CLIP'],
    [3, 1, 1, 3, 0, 'CLIP'],
    [4, 1, 2, 6, 1, 'VAE'],
    [6, 3, 0, 5, 2, 'CONDITIONING'],
    [7, 4, 0, 5, 3, 'LATENT'],
    [8, 5, 0, 6, 0, 'LATENT'],
    [9, 6, 0, 7, 0, 'IMAGE'],
    [10, 2, 0, 8, 0, 'CONDITIONING'],
    [11, 8, 0, 5, 1, 'CONDITIONING'],
    [12, 9, 0, 3, 0, 'STRING'],
  ],
}

describe('convertGraphToApi', () => {
  const api = convertGraphToApi(baseGraph, objectInfo)

  it('widgets_values 按 object_info 顺序映射为命名 inputs', () => {
    expect(api['4'].inputs).toEqual({ width: 512, height: 512, batch_size: 1 })
    expect(api['1'].inputs).toEqual({ ckpt_name: 'a.safetensors' })
  })

  it('seed 的 control_after_generate 占位被跳过', () => {
    expect(api['5'].inputs.seed).toBe(42)
    expect(api['5'].inputs.steps).toBe(4)
    expect(api['5'].inputs.cfg).toBe(1)
    expect(api['5'].inputs.sampler_name).toBe('euler')
    expect(api['5'].inputs.scheduler).toBe('simple')
    expect(api['5'].inputs.denoise).toBe(1)
    expect(api['5'].inputs).not.toHaveProperty('control_after_generate')
  })

  it('连线解析为 [nodeId, slot]', () => {
    expect(api['5'].inputs.model).toEqual(['1', 0])
    expect(api['5'].inputs.negative).toEqual(['3', 0])
    expect(api['6'].inputs.vae).toEqual(['1', 2])
  })

  it('Reroute 透传到真实源', () => {
    expect(api['5'].inputs.positive).toEqual(['2', 0])
    expect(api['8']).toBeUndefined()
  })

  it('PrimitiveNode 值内联为字面量,覆盖 widget 占位', () => {
    expect(api['3'].inputs.text).toBe('from primitive')
    expect(api['9']).toBeUndefined()
  })

  it('Note 节点被剔除,_meta.title 保留', () => {
    expect(api['20']).toBeUndefined()
    expect(api['2']._meta.title).toBe('正向提示词')
    expect(api['3']._meta.title).toBe('CLIPTextEncode')
  })

  it('bypassed(mode=4)节点按输出类型透传', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'LoraLoader', mode: 4, widgets_values: ['l.safetensors', 1, 1],
          inputs: [
            { name: 'model', type: 'MODEL', link: 1 },
            { name: 'clip', type: 'CLIP', link: null },
          ],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [2] }, { name: 'CLIP', type: 'CLIP', links: null }] },
        { id: 3, type: 'VAEDecode',
          inputs: [{ name: 'samples', type: 'LATENT', link: null }, { name: 'vae', type: 'VAE', link: null }] },
        { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 4, 1, 'euler', 'simple', 1],
          inputs: [{ name: 'model', type: 'MODEL', link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 2, 0, 5, 0, 'MODEL'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['5'].inputs.model).toEqual(['1', 0])
    expect(out['2']).toBeUndefined()
  })

  it('muted(mode=2)源节点:下游该输入被剔除', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', mode: 2, widgets_values: ['a.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
        { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 4, 1, 'euler', 'simple', 1],
          inputs: [{ name: 'model', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 5, 0, 'MODEL']],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['1']).toBeUndefined()
    expect(out['5'].inputs).not.toHaveProperty('model')
  })

  it('image_upload 伪 widget 占位被跳过', () => {
    const graph: GraphJson = {
      nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['cat.png', 'image'] }],
      links: [],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['1'].inputs).toEqual({ image: 'cat.png' })
  })

  it('widgets_values 为对象时按名直取', () => {
    const graph: GraphJson = {
      nodes: [{ id: 1, type: 'SaveImage', widgets_values: { filename_prefix: 'x' } as any }],
      links: [],
    }
    expect(convertGraphToApi(graph, objectInfo)['1'].inputs.filename_prefix).toBe('x')
  })

  it('缺失节点类型抛 ConvertError 并列出全部缺失项', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 1, type: 'SomeCustomNodeA' },
        { id: 2, type: 'SomeCustomNodeB' },
        { id: 3, type: 'SomeCustomNodeA' },
      ],
      links: [],
    }
    try {
      convertGraphToApi(graph, objectInfo)
      expect.unreachable('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(ConvertError)
      expect((err as ConvertError).missingTypes).toEqual(['SomeCustomNodeA', 'SomeCustomNodeB'])
      expect((err as ConvertError).message).toContain('SomeCustomNodeA')
    }
  })

  it('连线成环时不死循环,该输入剔除', () => {
    const graph: GraphJson = {
      nodes: [
        { id: 8, type: 'Reroute',
          inputs: [{ name: '', type: '*', link: 2 }],
          outputs: [{ name: '', type: '*', links: [1] }] },
        { id: 9, type: 'Reroute',
          inputs: [{ name: '', type: '*', link: 1 }],
          outputs: [{ name: '', type: '*', links: [2] }] },
        { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 4, 1, 'euler', 'simple', 1],
          inputs: [{ name: 'model', type: 'MODEL', link: 3 }] },
      ],
      links: [
        [1, 8, 0, 9, 0, '*'],
        [2, 9, 0, 8, 0, '*'],
        [3, 8, 0, 5, 0, 'MODEL'],
      ],
    }
    const out = convertGraphToApi(graph, objectInfo)
    expect(out['5'].inputs).not.toHaveProperty('model')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/graph-convert.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现转换器**

```ts
// apps/server/src/comfy/graph-convert.ts
import type { ObjectInfoMap } from './client.js'

export interface GraphNode {
  id: number
  type: string
  /** 0=正常 2=muted(never) 4=bypassed */
  mode?: number
  title?: string
  inputs?: Array<{ name: string; type: string | number; link: number | null; widget?: { name: string } }>
  outputs?: Array<{ name: string; type: string | number; links?: number[] | null }>
  widgets_values?: unknown[] | Record<string, unknown>
}

/** [linkId, srcNodeId, srcSlot, dstNodeId, dstSlot, type] */
export type GraphLink = [number, number, number, number, number, unknown]

export interface GraphJson {
  nodes: GraphNode[]
  links: Array<GraphLink | null>
}

export class ConvertError extends Error {
  constructor(
    message: string,
    readonly missingTypes: string[] = [],
  ) {
    super(message)
  }
}

/** 前端虚拟节点:不进执行图 */
const VIRTUAL_TYPES = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote'])
/** object_info 中会渲染为 widget 的标量类型(数组=COMBO 枚举) */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

const MODE_MUTED = 2
const MODE_BYPASSED = 4

interface WidgetSlot {
  name: string
  /** seed 的 control_after_generate、LoadImage 的 image_upload 等伪 widget 会在 widgets_values 里多占一位 */
  extraSlot: boolean
}

function widgetSlots(def: ObjectInfoMap[string]): WidgetSlot[] {
  const out: WidgetSlot[] = []
  for (const section of [def.input?.required, def.input?.optional]) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      const type = spec?.[0]
      const opts = (spec?.[1] ?? {}) as Record<string, unknown>
      const isWidget = Array.isArray(type) || (typeof type === 'string' && WIDGET_TYPES.has(type))
      if (!isWidget) continue
      const extraSlot =
        Boolean(opts.control_after_generate) ||
        Boolean(opts.image_upload) ||
        (type === 'INT' && (name === 'seed' || name === 'noise_seed'))
      out.push({ name, extraSlot })
    }
  }
  return out
}

type Source = { link: [string, number] } | { value: unknown } | null

/** 沿 Reroute/Primitive/bypass 链回溯连线的真实源;muted 或断链返回 null */
function resolveSource(
  nodeById: Map<number, GraphNode>,
  linkById: Map<number, GraphLink>,
  linkId: number,
  seen: Set<number>,
): Source {
  if (seen.has(linkId)) return null
  seen.add(linkId)
  const link = linkById.get(linkId)
  if (!link) return null
  const [, srcId, srcSlot] = link
  const src = nodeById.get(srcId)
  if (!src || src.mode === MODE_MUTED) return null
  if (src.type === 'Reroute') {
    const upstream = src.inputs?.[0]?.link
    return upstream == null ? null : resolveSource(nodeById, linkById, upstream, seen)
  }
  if (src.type === 'PrimitiveNode') {
    const wv = src.widgets_values
    return { value: Array.isArray(wv) ? wv[0] : wv }
  }
  if (src.mode === MODE_BYPASSED) {
    const outType = src.outputs?.[srcSlot]?.type
    const passthrough = src.inputs?.find((i) => i.type === outType && i.link != null)
    return passthrough?.link == null
      ? null
      : resolveSource(nodeById, linkById, passthrough.link, seen)
  }
  return { link: [String(srcId), srcSlot] }
}

export function convertGraphToApi(
  graph: GraphJson,
  objectInfo: ObjectInfoMap,
): Record<string, any> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const linkById = new Map<number, GraphLink>()
  for (const l of graph.links ?? []) if (l) linkById.set(l[0], l)

  const real = graph.nodes.filter(
    (n) => !VIRTUAL_TYPES.has(n.type) && n.mode !== MODE_MUTED && n.mode !== MODE_BYPASSED,
  )
  const missing = [...new Set(real.filter((n) => !objectInfo[n.type]).map((n) => n.type))]
  if (missing.length > 0) {
    throw new ConvertError(`服务器缺少节点类型定义: ${missing.join(', ')}`, missing)
  }

  const api: Record<string, any> = {}
  for (const node of real) {
    const def = objectInfo[node.type]!
    const inputs: Record<string, unknown> = {}

    const wv = node.widgets_values
    if (Array.isArray(wv)) {
      let i = 0
      for (const w of widgetSlots(def)) {
        if (i >= wv.length) break
        inputs[w.name] = wv[i]
        i += w.extraSlot ? 2 : 1
      }
    } else if (wv && typeof wv === 'object') {
      Object.assign(inputs, wv)
    }

    for (const inp of node.inputs ?? []) {
      if (inp.link == null) continue
      const src = resolveSource(nodeById, linkById, inp.link, new Set())
      if (src === null) {
        delete inputs[inp.name]
        continue
      }
      inputs[inp.name] = 'value' in src ? src.value : src.link
    }

    api[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title ?? node.type },
    }
  }
  return api
}
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `pnpm --filter @cwe/server test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/comfy/graph-convert.ts apps/server/test/graph-convert.test.ts
git commit -m "feat(server): graph-to-api workflow converter"
```

---

### Task 4: server — validate 模块 + `/api/comfy/*` 路由

**Files:**
- Create: `apps/server/src/comfy/validate.ts`
- Create: `apps/server/src/routes/comfy.ts`
- Modify: `apps/server/src/app.ts`(挂载路由)
- Test: `apps/server/test/comfy-routes.test.ts`

**Interfaces:**
- Consumes: `convertGraphToApi`/`ConvertError`(Task 3)、`ObjectInfoCache`(Task 2)、`AppDeps`
- Produces:
  - `POST /api/comfy/convert` → 200 `{ comfyJson }` | 400 `{error}`(非 graph 形状)| 503 `{error}`(离线)| 422 `{error, missingTypes}`
  - `POST /api/comfy/validate` → 200 `{ skipped: boolean, warnings: ValidationWarning[], enumInputs: EnumInputRef[] }`(离线时 `skipped:true` 且两数组为空)
  - `GET /api/comfy/input-options?classType=&inputName=[&refresh=1]` → 200 `{ options: string[] }` | 404(非枚举输入)| 503(离线)
  - `validate.ts` 导出 `validateApiJson(comfyJson, info)`、`enumOptions(info, classType, inputName): string[] | null`、类型 `ValidationWarning`、`EnumInputRef`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/comfy-routes.test.ts
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb } from '../src/db/index.js'
import { FakeComfy } from './fake-comfy.js'

const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

let comfy: FakeComfy
let app: ReturnType<typeof createApp>

function makeApp(withComfy = true) {
  return createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret' }),
    db: createDb(':memory:'),
    comfy: withComfy ? comfy : null,
    events: new EventEmitter(),
  })
}

beforeEach(() => {
  comfy = new FakeComfy()
  comfy.objectInfo = {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } },
    },
    CLIPTextEncode: {
      input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    },
  }
  app = makeApp()
})

describe('POST /api/comfy/convert', () => {
  const graph = {
    nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'] }],
    links: [],
  }

  it('转换 graph 为 API 格式', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify(graph),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.comfyJson['1'].class_type).toBe('CheckpointLoaderSimple')
    expect(body.comfyJson['1'].inputs.ckpt_name).toBe('a.safetensors')
  })

  it('非 graph 形状返回 400', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify({ '1': { class_type: 'X', inputs: {} } }),
    })
    expect(res.status).toBe(400)
  })

  it('comfy 未配置返回 503', async () => {
    const res = await makeApp(false).request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify(graph),
    })
    expect(res.status).toBe(503)
  })

  it('object_info 拉取失败返回 503', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('ECONNREFUSED')
    }
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H, body: JSON.stringify(graph),
    })
    expect(res.status).toBe(503)
  })

  it('缺节点定义返回 422 + missingTypes', async () => {
    const res = await app.request('/api/comfy/convert', {
      method: 'POST', headers: H,
      body: JSON.stringify({ nodes: [{ id: 1, type: 'CustomFoo' }], links: [] }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as any).missingTypes).toEqual(['CustomFoo'])
  })
})

describe('POST /api/comfy/validate', () => {
  it('返回警告与枚举输入清单', async () => {
    const comfyJson = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'missing.safetensors' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['4', 1] } },
      '9': { class_type: 'UnknownCustom', inputs: {} },
    }
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H, body: JSON.stringify(comfyJson),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.skipped).toBe(false)
    expect(body.enumInputs).toEqual([
      { nodeId: '4', classType: 'CheckpointLoaderSimple', inputName: 'ckpt_name' },
    ])
    expect(body.warnings).toHaveLength(2) // 值不存在 + 未知节点类型
    expect(body.warnings.map((w: any) => w.nodeId).sort()).toEqual(['4', '9'])
  })

  it('值合法时无警告', async () => {
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
      }),
    })
    const body = (await res.json()) as any
    expect(body.warnings).toEqual([])
    expect(body.enumInputs).toHaveLength(1)
  })

  it('离线时 skipped=true', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('down')
    }
    const res = await app.request('/api/comfy/validate', {
      method: 'POST', headers: H, body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skipped: true, warnings: [], enumInputs: [] })
  })
})

describe('GET /api/comfy/input-options', () => {
  it('返回枚举可选值', async () => {
    const res = await app.request(
      '/api/comfy/input-options?classType=CheckpointLoaderSimple&inputName=ckpt_name',
      { headers: H },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ options: ['a.safetensors', 'b.safetensors'] })
  })

  it('非枚举输入返回 404', async () => {
    const res = await app.request(
      '/api/comfy/input-options?classType=CLIPTextEncode&inputName=text',
      { headers: H },
    )
    expect(res.status).toBe(404)
  })

  it('离线返回 503', async () => {
    comfy.getObjectInfo = async () => {
      throw new Error('down')
    }
    const res = await app.request(
      '/api/comfy/input-options?classType=CheckpointLoaderSimple&inputName=ckpt_name',
      { headers: H },
    )
    expect(res.status).toBe(503)
  })

  it('需要认证', async () => {
    const res = await app.request(
      '/api/comfy/input-options?classType=CheckpointLoaderSimple&inputName=ckpt_name',
    )
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cwe/server exec vitest run test/comfy-routes.test.ts`
Expected: FAIL(路由 404)

- [ ] **Step 3: 实现 validate.ts**

```ts
// apps/server/src/comfy/validate.ts
import type { ObjectInfoMap } from './client.js'

export interface ValidationWarning {
  nodeId: string
  classType: string
  inputName: string
  value: string
  message: string
}

export interface EnumInputRef {
  nodeId: string
  classType: string
  inputName: string
}

/** classType.inputName 的枚举可选值;非枚举输入返回 null */
export function enumOptions(
  info: ObjectInfoMap,
  classType: string,
  inputName: string,
): string[] | null {
  const def = info[classType]
  for (const section of [def?.input?.required, def?.input?.optional]) {
    const spec = section?.[inputName]
    if (spec && Array.isArray(spec[0])) return (spec[0] as unknown[]).map(String)
  }
  return null
}

/** 对照 object_info 检查 API 格式 workflow:枚举值存在性 + 节点类型存在性 */
export function validateApiJson(
  comfyJson: Record<string, any>,
  info: ObjectInfoMap,
): { warnings: ValidationWarning[]; enumInputs: EnumInputRef[] } {
  const warnings: ValidationWarning[] = []
  const enumInputs: EnumInputRef[] = []
  for (const [nodeId, node] of Object.entries(comfyJson)) {
    const classType = String(node?.class_type ?? '')
    if (!info[classType]) {
      warnings.push({ nodeId, classType, inputName: '', value: '', message: '节点类型在服务器上不存在' })
      continue
    }
    for (const [inputName, value] of Object.entries(
      (node.inputs ?? {}) as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) continue // 连线
      const options = enumOptions(info, classType, inputName)
      if (!options) continue
      enumInputs.push({ nodeId, classType, inputName })
      if (!options.includes(String(value))) {
        warnings.push({
          nodeId, classType, inputName,
          value: String(value),
          message: '当前值不在服务器可选值中',
        })
      }
    }
  }
  return { warnings, enumInputs }
}
```

- [ ] **Step 4: 实现 routes/comfy.ts 并挂载**

```ts
// apps/server/src/routes/comfy.ts
import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { ConvertError, convertGraphToApi, type GraphJson } from '../comfy/graph-convert.js'
import { ObjectInfoCache } from '../comfy/object-info-cache.js'
import type { ObjectInfoMap } from '../comfy/client.js'
import { enumOptions, validateApiJson } from '../comfy/validate.js'

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

  return app
}
```

`apps/server/src/app.ts`:import 区加 `import { comfyRoutes } from './routes/comfy.js'`,在 `app.route('/api/templates', …)` 之前加一行:

```ts
  app.route('/api/comfy', comfyRoutes(deps))
```

- [ ] **Step 5: 运行确认通过 + 全量回归**

Run: `pnpm --filter @cwe/server test && pnpm --filter @cwe/server typecheck`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/comfy/validate.ts apps/server/src/routes/comfy.ts apps/server/src/app.ts apps/server/test/comfy-routes.test.ts
git commit -m "feat(server): /api/comfy convert, validate and input-options endpoints"
```

---

### Task 5: web — vitest 基建 + PNG 元数据提取 + 格式检测

**Files:**
- Modify: `apps/web/package.json`(vitest 依赖 + test 脚本)
- Create: `apps/web/src/lib/png-meta.ts`
- Modify: `apps/web/src/lib/comfy-parse.ts`(新增 `detectFormat`)
- Test: `apps/web/src/lib/png-meta.test.ts`、`apps/web/src/lib/comfy-parse.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `extractComfyMetadata(buf: ArrayBuffer): { prompt?: string; workflow?: string }`
  - `detectFormat(json: unknown): 'graph' | 'api' | 'unknown'`(导出类型 `WorkflowFormat`)

- [ ] **Step 1: 安装 vitest 并配置脚本**

```bash
pnpm --filter @cwe/web add -D vitest@^3.2.4
```

`apps/web/package.json` 的 `"test": "echo skip"` 改为 `"test": "vitest run --passWithNoTests"`。纯函数测试跑在 node 环境,无需 jsdom;vitest 独立跑 `src/**/*.test.ts`,不经 vite.config(不依赖 `@` 别名——测试内用相对导入)。

- [ ] **Step 2: 写失败测试**

```ts
// apps/web/src/lib/png-meta.test.ts
import { describe, expect, it } from 'vitest'
import { extractComfyMetadata } from './png-meta'

/** 手工构造最小 PNG:签名 + 若干 chunk + IEND(解析器不校验 CRC,填 0) */
function makePng(chunks: Array<{ type: string; data: Uint8Array }>): ArrayBuffer {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts: Uint8Array[] = [sig]
  for (const { type, data } of [...chunks, { type: 'IEND', data: new Uint8Array(0) }]) {
    const head = new Uint8Array(8)
    new DataView(head.buffer).setUint32(0, data.length)
    for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i)
    parts.push(head, data, new Uint8Array(4)) // 尾部 4 字节假 CRC
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out.buffer
}

function textChunk(keyword: string, text: string): { type: string; data: Uint8Array } {
  const enc = new TextEncoder()
  const kw = enc.encode(keyword)
  const body = enc.encode(text)
  const data = new Uint8Array(kw.length + 1 + body.length)
  data.set(kw, 0)
  data[kw.length] = 0
  data.set(body, kw.length + 1)
  return { type: 'tEXt', data }
}

function itxtChunk(keyword: string, text: string): { type: string; data: Uint8Array } {
  const enc = new TextEncoder()
  const kw = enc.encode(keyword)
  const body = enc.encode(text)
  // keyword\0 compFlag(0) compMethod(0) lang\0 translated\0 text
  const data = new Uint8Array(kw.length + 5 + body.length)
  data.set(kw, 0)
  // kw.length..kw.length+4 均为 0
  data.set(body, kw.length + 5)
  return { type: 'iTXt', data }
}

describe('extractComfyMetadata', () => {
  it('提取 tEXt 中的 prompt 与 workflow', () => {
    const png = makePng([
      textChunk('prompt', '{"1":{}}'),
      textChunk('workflow', '{"nodes":[]}'),
    ])
    expect(extractComfyMetadata(png)).toEqual({ prompt: '{"1":{}}', workflow: '{"nodes":[]}' })
  })

  it('提取 iTXt(未压缩)', () => {
    const png = makePng([itxtChunk('prompt', '{"2":{}}')])
    expect(extractComfyMetadata(png)).toEqual({ prompt: '{"2":{}}' })
  })

  it('忽略无关 keyword', () => {
    const png = makePng([textChunk('parameters', 'sd-webui 格式')])
    expect(extractComfyMetadata(png)).toEqual({})
  })

  it('非 PNG 返回空对象', () => {
    expect(extractComfyMetadata(new TextEncoder().encode('not a png').buffer as ArrayBuffer)).toEqual({})
  })

  it('截断的 chunk 不越界', () => {
    const good = makePng([textChunk('prompt', '{"1":{}}')])
    const truncated = good.slice(0, (good.byteLength / 2) | 0)
    expect(() => extractComfyMetadata(truncated)).not.toThrow()
  })
})
```

```ts
// apps/web/src/lib/comfy-parse.test.ts
import { describe, expect, it } from 'vitest'
import { detectFormat } from './comfy-parse'

describe('detectFormat', () => {
  it('识别 UI/graph 格式', () => {
    expect(detectFormat({ nodes: [], links: [], version: 0.4 })).toBe('graph')
  })

  it('识别 API 格式', () => {
    expect(
      detectFormat({
        '1': { class_type: 'KSampler', inputs: {} },
        '2': { class_type: 'SaveImage', inputs: {} },
      }),
    ).toBe('api')
  })

  it('其它 JSON 为 unknown', () => {
    expect(detectFormat({ foo: 1 })).toBe('unknown')
    expect(detectFormat([])).toBe('unknown')
    expect(detectFormat(null)).toBe('unknown')
    expect(detectFormat({})).toBe('unknown')
    expect(detectFormat({ '1': { inputs: {} } })).toBe('unknown') // 缺 class_type
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @cwe/web exec vitest run src/lib`
Expected: FAIL(`png-meta` 模块不存在、`detectFormat` 未导出)

- [ ] **Step 4: 实现**

```ts
// apps/web/src/lib/png-meta.ts
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 从 ComfyUI 生成的 PNG 提取内嵌元数据(tEXt/iTXt chunk 的 prompt=API 格式、workflow=UI 格式) */
export function extractComfyMetadata(buf: ArrayBuffer): { prompt?: string; workflow?: string } {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) return {}
  const view = new DataView(buf)
  const out: { prompt?: string; workflow?: string } = {}

  let pos = 8
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos)
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8))
    const dataStart = pos + 8
    if (dataStart + length > bytes.length) break
    if (type === 'IEND') break

    if (type === 'tEXt' || type === 'iTXt') {
      const data = bytes.subarray(dataStart, dataStart + length)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = new TextDecoder('latin1').decode(data.subarray(0, nul))
        if (keyword === 'prompt' || keyword === 'workflow') {
          let text: string | undefined
          if (type === 'tEXt') {
            text = new TextDecoder('latin1').decode(data.subarray(nul + 1))
          } else if (data[nul + 1] === 0) {
            // iTXt 未压缩:keyword\0 compFlag compMethod lang\0 translated\0 text
            let p = data.indexOf(0, nul + 3)
            if (p !== -1) p = data.indexOf(0, p + 1)
            if (p !== -1) text = new TextDecoder().decode(data.subarray(p + 1))
          }
          if (text) out[keyword] = text
        }
      }
    }
    pos = dataStart + length + 4 // 跳过 CRC
  }
  return out
}
```

`apps/web/src/lib/comfy-parse.ts` 追加:

```ts
export type WorkflowFormat = 'graph' | 'api' | 'unknown'

/** 区分 ComfyUI 的 UI/graph 导出与 API(prompt)导出 */
export function detectFormat(json: unknown): WorkflowFormat {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown'
  const obj = json as Record<string, any>
  if (Array.isArray(obj.nodes) && Array.isArray(obj.links)) return 'graph'
  const nodes = Object.values(obj)
  if (nodes.length > 0 && nodes.every((v) => v && typeof v === 'object' && typeof v.class_type === 'string')) {
    return 'api'
  }
  return 'unknown'
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @cwe/web test && pnpm --filter @cwe/web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/png-meta.ts apps/web/src/lib/png-meta.test.ts apps/web/src/lib/comfy-parse.ts apps/web/src/lib/comfy-parse.test.ts
git commit -m "feat(web): png metadata extraction, workflow format detection, vitest setup"
```

---

### Task 6: web — 常用参数智能预选

**Files:**
- Create: `apps/web/src/lib/suggest-params.ts`
- Test: `apps/web/src/lib/suggest-params.test.ts`

**Interfaces:**
- Consumes: `ParamType`(shared)
- Produces: `suggestParams(json: Record<string, any>): SuggestedParam[]`,其中 `interface SuggestedParam { nodeId: string; inputName: string; key: string; type: ParamType }`。key 全局唯一(冲突加 `_2` 后缀)。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/suggest-params.test.ts
import { describe, expect, it } from 'vitest'
import { suggestParams } from './suggest-params'

const txt2img = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 42, steps: 4, positive: ['6', 0], negative: ['7', 0], model: ['4', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
}

describe('suggestParams', () => {
  it('通过采样器连线区分正负提示词', () => {
    const out = suggestParams(txt2img)
    expect(out).toContainEqual({ nodeId: '6', inputName: 'text', key: 'prompt', type: 'text' })
    expect(out).toContainEqual({ nodeId: '7', inputName: 'text', key: 'negative_prompt', type: 'text' })
  })

  it('预选 seed', () => {
    expect(suggestParams(txt2img)).toContainEqual({
      nodeId: '3', inputName: 'seed', key: 'seed', type: 'seed',
    })
  })

  it('同一编码节点被两个采样器共享时不重复', () => {
    const json = {
      ...txt2img,
      '10': {
        class_type: 'KSamplerAdvanced',
        inputs: { noise_seed: 1, positive: ['6', 0], negative: ['7', 0] },
      },
    }
    const out = suggestParams(json)
    expect(out.filter((p) => p.nodeId === '6' && p.inputName === 'text')).toHaveLength(1)
    // 两个 seed 输入,key 去重
    const seedKeys = out.filter((p) => p.type === 'seed').map((p) => p.key)
    expect(new Set(seedKeys).size).toBe(seedKeys.length)
  })

  it('两组独立正提示词时 key 加后缀', () => {
    const json = {
      '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'y' } },
      '4': { class_type: 'KSampler', inputs: { positive: ['5', 0], negative: ['3', 0] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'z' } },
    }
    const keys = suggestParams(json).map((p) => p.key)
    expect(keys).toContain('prompt')
    expect(keys).toContain('prompt_2')
    expect(keys.filter((k) => k.startsWith('negative_prompt'))).toHaveLength(1)
  })

  it('无采样器/无 seed 时返回空数组', () => {
    expect(suggestParams({ '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } } })).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cwe/web exec vitest run src/lib/suggest-params.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// apps/web/src/lib/suggest-params.ts
import type { ParamType } from '@cwe/shared'

export interface SuggestedParam {
  nodeId: string
  inputName: string
  key: string
  type: ParamType
}

const TEXT_ENCODE_TYPES = new Set(['CLIPTextEncode', 'CLIPTextEncodeSDXL'])

/** 导入后自动预选的高价值参数:正/负提示词(经采样器连线回溯)与 seed */
export function suggestParams(json: Record<string, any>): SuggestedParam[] {
  const out: SuggestedParam[] = []
  const seen = new Set<string>()
  const used = new Map<string, number>()

  const push = (nodeId: string, inputName: string, base: string, type: ParamType) => {
    const id = `${nodeId}.${inputName}`
    if (seen.has(id)) return
    seen.add(id)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    out.push({ nodeId, inputName, key: n === 1 ? base : `${base}_${n}`, type })
  }

  // 1. 采样器的 positive/negative 连线 → CLIPTextEncode.text
  for (const node of Object.values(json)) {
    if (!/KSampler/.test(String(node?.class_type))) continue
    for (const role of ['positive', 'negative'] as const) {
      const link = node.inputs?.[role]
      if (!Array.isArray(link)) continue
      const targetId = String(link[0])
      const target = json[targetId]
      if (!target || !TEXT_ENCODE_TYPES.has(String(target.class_type))) continue
      if (typeof target.inputs?.text !== 'string') continue
      push(targetId, 'text', role === 'positive' ? 'prompt' : 'negative_prompt', 'text')
    }
  }

  // 2. 数值型 seed 输入
  for (const [nodeId, node] of Object.entries(json)) {
    for (const [inputName, value] of Object.entries(
      (node?.inputs ?? {}) as Record<string, unknown>,
    )) {
      if (typeof value === 'number' && inputName.toLowerCase().includes('seed')) {
        push(nodeId, inputName, 'seed', 'seed')
      }
    }
  }

  return out
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cwe/web test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/suggest-params.ts apps/web/src/lib/suggest-params.test.ts
git commit -m "feat(web): smart param preselection from workflow graph"
```

---

### Task 7: web — 导入页重构(多入口 + 分组 + 搜索 + 校验展示)

**Files:**
- Rewrite: `apps/web/src/pages/template-import.tsx`

**Interfaces:**
- Consumes: `detectFormat`/`parseNodeInputs`/`guessType`(comfy-parse)、`extractComfyMetadata`(png-meta)、`suggestParams`(suggest-params)、`POST /api/comfy/convert`、`POST /api/comfy/validate`(Task 4 的响应形状)、`ParamDef.enumRef`(Task 1)
- Produces: 保存模板时 `params` 中 enum 类型参数携带 `enumRef`;页面行为(供人工验收):文件/拖拽/粘贴/PNG 四种入口、分组卡片、搜索、预选、警告列表

- [ ] **Step 1: 重写页面**

完整替换 `apps/web/src/pages/template-import.tsx`:

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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { detectFormat, guessType, parseNodeInputs, type NodeInputRow } from '@/lib/comfy-parse'
import { extractComfyMetadata } from '@/lib/png-meta'
import { suggestParams } from '@/lib/suggest-params'

interface Selection {
  key: string
  type: ParamType
  enumRef?: { classType: string; inputName: string }
}

interface ValidateResponse {
  skipped: boolean
  warnings: Array<{ nodeId: string; classType: string; inputName: string; value: string; message: string }>
  enumInputs: Array<{ nodeId: string; classType: string; inputName: string }>
}

const rowId = (r: NodeInputRow) => `${r.nodeId}.${r.inputName}`

/** 组内排序:已选最前,然后按常用输入优先级 */
const PRIORITY = ['text', 'seed', 'steps', 'cfg', 'denoise', 'ckpt_name', 'sampler_name', 'scheduler', 'width', 'height']

function apiErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(msg) as { error?: string; missingTypes?: string[] }
    if (parsed.missingTypes?.length) return `${parsed.error}(缺少:${parsed.missingTypes.join('、')})`
    return parsed.error ?? msg
  } catch {
    return msg
  }
}

export default function TemplateImportPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [json, setJson] = useState<Record<string, any> | null>(null)
  const [rows, setRows] = useState<NodeInputRow[]>([])
  const [selected, setSelected] = useState<Record<string, Selection>>({})
  const [enumRefs, setEnumRefs] = useState<Map<string, { classType: string; inputName: string }>>(new Map())
  const [validation, setValidation] = useState<ValidateResponse | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function ingest(parsed: unknown, sourceName: string) {
    setError('')
    setValidation(null)
    setBusy(true)
    try {
      let comfyJson: Record<string, any>
      const format = detectFormat(parsed)
      if (format === 'graph') {
        try {
          const res = await api<{ comfyJson: Record<string, any> }>('/comfy/convert', {
            method: 'POST',
            body: JSON.stringify(parsed),
          })
          comfyJson = res.comfyJson
        } catch (e) {
          setError(apiErrorMessage(e))
          return
        }
      } else if (format === 'api') {
        comfyJson = parsed as Record<string, any>
      } else {
        setError('无法识别的 JSON 格式——需要 ComfyUI 导出的 workflow(UI 格式或 API 格式均可)')
        return
      }

      const inputs = parseNodeInputs(comfyJson)
      if (inputs.length === 0) {
        setError('未解析到任何节点输入')
        return
      }

      // 校验 + 枚举标注(端点不可用时静默跳过,不阻断导入)
      let refs = new Map<string, { classType: string; inputName: string }>()
      try {
        const v = await api<ValidateResponse>('/comfy/validate', {
          method: 'POST',
          body: JSON.stringify(comfyJson),
        })
        setValidation(v)
        refs = new Map(
          v.enumInputs.map((e) => [`${e.nodeId}.${e.inputName}`, { classType: e.classType, inputName: e.inputName }]),
        )
      } catch {
        /* 校验失败不阻断导入 */
      }

      const pre: Record<string, Selection> = {}
      for (const s of suggestParams(comfyJson)) {
        pre[`${s.nodeId}.${s.inputName}`] = { key: s.key, type: s.type }
      }

      setJson(comfyJson)
      setRows(inputs)
      setSelected(pre)
      setEnumRefs(refs)
      // 无预选参数的节点默认折叠
      setCollapsed(
        new Set(
          [...new Set(inputs.map((r) => r.nodeId))].filter(
            (id) => !Object.keys(pre).some((k) => k.startsWith(`${id}.`)),
          ),
        ),
      )
      if (!name && sourceName) setName(sourceName)
    } finally {
      setBusy(false)
    }
  }

  async function onFile(file: File) {
    if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
      const meta = extractComfyMetadata(await file.arrayBuffer())
      const text = meta.prompt ?? meta.workflow // 优先 API 格式,免转换
      if (!text) {
        setError('该 PNG 不含 ComfyUI 元数据')
        return
      }
      try {
        await ingest(JSON.parse(text), file.name.replace(/\.png$/i, ''))
      } catch {
        setError('PNG 内嵌的 workflow JSON 解析失败')
      }
    } else {
      try {
        await ingest(JSON.parse(await file.text()), file.name.replace(/\.json$/i, ''))
      } catch {
        setError('JSON 解析失败')
      }
    }
  }

  function importPaste() {
    try {
      void ingest(JSON.parse(pasteText), '')
      setPasteOpen(false)
    } catch {
      setError('JSON 解析失败')
    }
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
            ...(sel.type === 'enum' && sel.enumRef ? { enumRef: sel.enumRef } : {}),
          }
        })
      return api('/templates', {
        method: 'POST',
        body: JSON.stringify({ name, comfyJson: json, params }),
      })
    },
    onSuccess: () => navigate('/templates'),
    onError: (e) => setError(apiErrorMessage(e)),
  })

  const chosenCount = Object.keys(selected).length
  const keys = rows.filter((r) => selected[rowId(r)]).map((r) => selected[rowId(r)]!.key)
  const hasDuplicateKeys = new Set(keys).size !== keys.length

  const q = query.trim().toLowerCase()
  const nodeTitle = (nodeId: string, classType: string) =>
    String(json?.[nodeId]?._meta?.title ?? classType)
  const visibleRows = rows.filter(
    (r) =>
      !q ||
      [r.nodeId, r.classType, r.inputName, String(r.value), nodeTitle(r.nodeId, r.classType)].some(
        (s) => s.toLowerCase().includes(q),
      ),
  )
  const rank = (r: NodeInputRow) => {
    if (selected[rowId(r)]) return -1
    const p = PRIORITY.indexOf(r.inputName)
    return p === -1 ? PRIORITY.length : p
  }
  const groups: Array<[string, NodeInputRow[]]> = []
  {
    const m = new Map<string, NodeInputRow[]>()
    for (const r of visibleRows) {
      if (!m.has(r.nodeId)) {
        m.set(r.nodeId, [])
        groups.push([r.nodeId, m.get(r.nodeId)!])
      }
      m.get(r.nodeId)!.push(r)
    }
    for (const [, list] of groups) list.sort((a, b) => rank(a) - rank(b))
  }

  function toggleRow(r: NodeInputRow, checked: boolean) {
    const id = rowId(r)
    setSelected((prev) => {
      const next = { ...prev }
      if (checked) {
        const ref = enumRefs.get(id)
        next[id] = ref
          ? { key: r.inputName, type: 'enum', enumRef: ref }
          : { key: r.inputName, type: guessType(r) }
      } else {
        delete next[id]
      }
      return next
    })
  }

  return (
    <div
      className="space-y-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files?.[0]
        if (f) void onFile(f)
      }}
    >
      <h1 className="text-xl font-semibold">导入 Workflow</h1>
      <p className="text-sm text-muted-foreground">
        支持 UI 格式 / API 格式 JSON、ComfyUI 生成的 PNG(可直接拖拽到页面),或粘贴 JSON 文本。
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Input
          type="file"
          accept=".json,.png"
          className="w-72"
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
        />
        <Button variant="outline" onClick={() => setPasteOpen((v) => !v)}>
          粘贴 JSON
        </Button>
        <Input
          placeholder="模板名称"
          className="w-72"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {pasteOpen && (
        <div className="space-y-2">
          <Textarea
            rows={8}
            placeholder="粘贴 ComfyUI 导出的 workflow JSON(UI 或 API 格式均可)"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <Button size="sm" onClick={importPaste} disabled={!pasteText.trim() || busy}>
            解析
          </Button>
        </div>
      )}
      {busy && <p className="text-sm text-muted-foreground">解析中…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {validation?.skipped && (
        <p className="text-sm text-muted-foreground">⚠ 未校验(ComfyUI 离线),模型存在性将在运行时才能发现</p>
      )}
      {validation && validation.warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-yellow-600/50 bg-yellow-500/10 p-3 text-sm">
          {validation.warnings.map((w, i) => (
            <p key={i}>
              ⚠ 节点 {w.nodeId} {w.classType}
              {w.inputName ? `.${w.inputName}` : ''}:{w.value ? `“${w.value}” ` : ''}
              {w.message}
            </p>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex items-center gap-4">
            <Input
              placeholder="搜索节点 / 输入名 / 当前值…"
              className="w-72"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              勾选要作为批量参数的输入并命名(其余保持导入时的值)
            </p>
          </div>

          <div className="space-y-2">
            {groups.map(([nodeId, groupRows]) => {
              const title = nodeTitle(nodeId, groupRows[0]!.classType)
              const isCollapsed = !q && collapsed.has(nodeId)
              const chosenInGroup = groupRows.filter((r) => selected[rowId(r)]).length
              return (
                <div key={nodeId} className="rounded-md border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-4 py-2 text-left"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev)
                        if (next.has(nodeId)) next.delete(nodeId)
                        else next.add(nodeId)
                        return next
                      })
                    }
                  >
                    <span className="text-sm font-medium">
                      #{nodeId} · {title}
                      {title !== groupRows[0]!.classType && (
                        <span className="ml-2 text-xs text-muted-foreground">{groupRows[0]!.classType}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {chosenInGroup > 0 ? `已选 ${chosenInGroup} · ` : ''}
                      {isCollapsed ? '展开' : '收起'}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="divide-y border-t">
                      {groupRows.map((r) => {
                        const id = rowId(r)
                        const sel = selected[id]
                        const typeOptions: ParamType[] = enumRefs.has(id)
                          ? ['enum', 'text', 'number', 'seed', 'image']
                          : ['text', 'number', 'seed', 'image']
                        return (
                          <div key={id} className="flex items-center gap-3 px-4 py-2">
                            <input
                              type="checkbox"
                              checked={!!sel}
                              onChange={(e) => toggleRow(r, e.target.checked)}
                            />
                            <span className="w-40 truncate text-sm">{r.inputName}</span>
                            <span className="w-56 truncate text-sm text-muted-foreground" title={String(r.value)}>
                              {String(r.value)}
                            </span>
                            {sel && (
                              <>
                                <Input
                                  className="h-8 w-36"
                                  value={sel.key}
                                  onChange={(e) =>
                                    setSelected((prev) => ({ ...prev, [id]: { ...sel, key: e.target.value } }))
                                  }
                                />
                                <Select
                                  value={sel.type}
                                  onValueChange={(v) =>
                                    setSelected((prev) => ({
                                      ...prev,
                                      [id]: {
                                        ...sel,
                                        type: v as ParamType,
                                        enumRef: v === 'enum' ? enumRefs.get(id) : undefined,
                                      },
                                    }))
                                  }
                                >
                                  <SelectTrigger className="h-8 w-28">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {typeOptions.map((t) => (
                                      <SelectItem key={t} value={t}>
                                        {t}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {hasDuplicateKeys && <p className="text-sm text-destructive">参数 key 重复,请修改后再保存</p>}
          <Button
            disabled={!name || chosenCount === 0 || save.isPending || hasDuplicateKeys}
            onClick={() => save.mutate()}
          >
            保存模板({chosenCount} 个参数)
          </Button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 类型与构建验证**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/template-import.tsx
git commit -m "feat(web): multi-source import with grouped param selection and validation warnings"
```

---

### Task 8: web — 批量填参的枚举下拉/多选

**Files:**
- Create: `apps/web/src/hooks/use-input-options.ts`
- Modify: `apps/web/src/pages/batch-new.tsx`

**Interfaces:**
- Consumes: `GET /api/comfy/input-options`(Task 4)、`ParamDef.enumRef`(Task 1)
- Produces: `useInputOptions(param: ParamDef)` hook;batch-new 中 enum 参数在表格模式渲染下拉、矩阵模式渲染多选框、图片模式共享参数渲染下拉;拉取失败一律降级文本输入

- [ ] **Step 1: 实现 hook**

```ts
// apps/web/src/hooks/use-input-options.ts
import { useQuery } from '@tanstack/react-query'
import type { ParamDef } from '@cwe/shared'
import { api } from '@/lib/api'

/** enum 参数的实时可选值;非 enum 或离线时 query 不启用/报错,由调用方降级 */
export function useInputOptions(param: ParamDef) {
  const ref = param.enumRef
  return useQuery({
    queryKey: ['input-options', ref?.classType, ref?.inputName],
    enabled: param.type === 'enum' && !!ref,
    queryFn: () =>
      api<{ options: string[] }>(
        `/comfy/input-options?classType=${encodeURIComponent(ref!.classType)}&inputName=${encodeURIComponent(ref!.inputName)}`,
      ),
    staleTime: 60_000,
    retry: false,
  })
}
```

- [ ] **Step 2: batch-new 接入**

`apps/web/src/pages/batch-new.tsx` 修改三处,并在文件底部追加两个组件。

(a) import 区追加:

```tsx
import { useInputOptions } from '@/hooks/use-input-options'
import type { ParamDef } from '@cwe/shared'
```

(b) `TableEntry` 中单元格 `<Input …>`(原第 182-192 行)替换为:

```tsx
                <TableCell key={p.key}>
                  {p.type === 'enum' ? (
                    <EnumValueSelect
                      param={p}
                      value={String(row[p.key] ?? '')}
                      onChange={(v) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, [p.key]: v } : r))
                        update(next)
                      }}
                    />
                  ) : (
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
                  )}
                </TableCell>
```

(c) `MatrixEntry` 中 `<Textarea …>`(原第 262-266 行)替换为:

```tsx
            {p.type === 'enum' ? (
              <EnumAxisPick
                param={p}
                text={axes[p.key] ?? ''}
                onChange={(v) => setAxes((prev) => ({ ...prev, [p.key]: v }))}
              />
            ) : (
              <Textarea
                rows={4}
                value={axes[p.key] ?? ''}
                onChange={(e) => setAxes((prev) => ({ ...prev, [p.key]: e.target.value }))}
              />
            )}
```

(d) `ImagesEntry` 共享参数的 `<Input …>`(原第 336-340 行)替换为:

```tsx
            {p.type === 'enum' ? (
              <EnumValueSelect
                param={p}
                value={String(shared[p.key] ?? '')}
                onChange={(v) => setShared((prev) => ({ ...prev, [p.key]: v }))}
              />
            ) : (
              <Input
                placeholder={String(p.default ?? '')}
                value={String(shared[p.key] ?? '')}
                onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
              />
            )}
```

(e) 文件底部追加:

```tsx
/** enum 参数单选:可选值来自服务器;离线/失败降级为文本输入 */
function EnumValueSelect({
  param,
  value,
  onChange,
}: {
  param: ParamDef
  value: string
  onChange: (v: string) => void
}) {
  const { data, isError } = useInputOptions(param)
  if (!data || isError) {
    return (
      <Input
        className="h-8"
        placeholder={isError ? 'ComfyUI 离线,手动输入' : String(param.default ?? '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="h-8">
        <SelectValue placeholder={String(param.default ?? '选择…')} />
      </SelectTrigger>
      <SelectContent>
        {data.options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** enum 参数多选(矩阵轴):勾选项以换行拼接写回 axes,复用现有解析 */
function EnumAxisPick({
  param,
  text,
  onChange,
}: {
  param: ParamDef
  text: string
  onChange: (v: string) => void
}) {
  const { data, isError } = useInputOptions(param)
  if (!data || isError) {
    return (
      <Textarea
        rows={4}
        placeholder={isError ? 'ComfyUI 离线,一行一个值' : undefined}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  const chosen = new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
      {data.options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.has(o)}
            onChange={(e) => {
              const next = new Set(chosen)
              if (e.target.checked) next.add(o)
              else next.delete(o)
              onChange([...next].join('\n'))
            }}
          />
          <span className="truncate" title={o}>
            {o}
          </span>
        </label>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @cwe/web typecheck && pnpm --filter @cwe/web build && pnpm --filter @cwe/web test`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/use-input-options.ts apps/web/src/pages/batch-new.tsx
git commit -m "feat(web): enum param dropdown/multi-pick backed by server input-options"
```

---

### Task 9: README 更新 + 全仓验证

**Files:**
- Modify: `README.md`(使用流程一节)

**Interfaces:**
- Consumes: 前面全部任务
- Produces: 文档与最终验证

- [ ] **Step 1: 更新 README 使用流程**

README「使用流程」中关于导入的描述改为(保留上下文其余内容):

```markdown
2. **导入 workflow**:支持四种方式——选择/拖拽 UI 格式或 API 格式 JSON、拖入 ComfyUI 生成的 PNG(自动提取内嵌 workflow)、直接粘贴 JSON 文本。UI 格式会经服务器自动转换(需 ComfyUI 在线)。导入后按节点分组勾选批量参数,常用参数(正/负提示词、seed)会自动预选;checkpoint/sampler 等枚举输入自动识别为 enum 类型,建批次时可从服务器实时拉取可选值下拉选择。导入时会校验模型存在性并给出警告(不阻断保存)。
```

- [ ] **Step 2: 全仓验证**

Run: `pnpm -r test && pnpm -r typecheck && pnpm --filter @cwe/web build && pnpm --filter @cwe/server build`
Expected: 全部 PASS,无警告噪音

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: import flow update for multi-format import and enum params"
```

---

## Self-Review 记录

- Spec 覆盖:§1 入口与格式检测 → Task 5/7;§2 转换器与缓存与 503 → Task 2/3/4;§3 分组/搜索/预选 → Task 6/7;§4 enum 类型/validate 携带 enumInputs/input-options/降级 → Task 1/4/7/8;§5 校验警告 → Task 4/7;§6 测试策略 → 各任务 TDD 步骤;错误处理表逐条对应(bad JSON/unknown 格式/PNG 无元数据/503/422/skipped/降级)。
- 类型一致性:`ObjectInfoMap`(client.ts)被 graph-convert/validate/cache/fake-comfy 引用;`ValidateResponse` 前端形状与 Task 4 响应一致;`enumRef` 形状 `{classType, inputName}` 在 shared/validate/前端三处一致;`FakeComfy` 新增 `objectInfo`/`objectInfoCalls` 被 Task 2/4 测试使用。
- 无占位符;每个代码步骤均给出完整代码。
