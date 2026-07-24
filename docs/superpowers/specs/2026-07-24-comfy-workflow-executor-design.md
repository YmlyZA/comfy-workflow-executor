# comfy-workflow-executor 设计文档

日期：2026-07-24
状态：已确认

## 定位

批量执行 ComfyUI workflow 的轻量执行器。核心场景：**同一 workflow 模板 × 参数矩阵**，
生成一个 batch 的任务串行跑完并收集结果。全 TypeScript，单容器部署，通过 HTTP/WebSocket
连接一个已运行的 ComfyUI 实例（本地或 GPU 主机），自身不含任何 GPU/Python 依赖。

理念借鉴隔壁 `comfy-workflow-gateway`（生产级 Python 网关）：

- **数据库是队列的唯一事实源**——重启不丢任务
- **只连接已运行的 ComfyUI**——不管理其生命周期
- **claim 语义**——原子领取任务，恢复逻辑简单可靠

刻意不照搬的部分：api/dispatcher 进程分离（单实例串行场景无收益）、workflow package
compiler（UI 圈选参数替代）、多数据库后端（只用 SQLite）。

## 需求决策记录

| 维度 | 决策 |
| --- | --- |
| 任务模型 | 同一 workflow × 参数矩阵（batch → jobs） |
| ComfyUI 拓扑 | 单实例，URL 可配置，串行执行 |
| 参数化方式 | 导入 API-format JSON + UI 圈选参数保存为模板 |
| 参数来源 | 表格编辑/CSV 导入、笛卡尔积矩阵生成、批量图片输入 |
| 结果管理 | 结构化落盘 + Web 画廊 + zip 打包下载 |
| 可靠性 | SQLite 持久化 + 重启恢复；不自动重试（提供手动批量重试） |
| 访问控制 | 单 Bearer Token（环境变量配置） |
| 部署 | docker compose 单 service，本地与 VPS/GPU 主机同一份配置 |

## 架构：单服务 Monolith

pnpm monorepo，生产环境单进程单容器：

```
comfy-workflow-executor/
├── apps/
│   ├── server/          # Hono API + 进程内 executor loop + 托管前端产物
│   └── web/             # React + Vite + shadcn/ui + TanStack Query
├── packages/
│   └── shared/          # Zod schemas + TS 类型（API 契约单一事实源）
├── compose.yaml
├── Dockerfile           # 多阶段构建 → node:22-slim
└── .env.example
```

- 开发：`pnpm dev` 并行起 Vite dev server（`/api` 代理到后端）+ `tsx watch` Hono
- 生产：Hono serve 前端 build 产物，单端口单进程

技术选型：Hono（`@hono/node-server`）、Drizzle ORM + better-sqlite3、React 19 + Vite、
shadcn/ui + Tailwind、TanStack Query、SSE 进度推送、Vitest。

## 数据模型（SQLite + Drizzle）

三张表：

### templates

| 列 | 说明 |
| --- | --- |
| id, name, created_at | 基础字段 |
| comfy_json | 原始 API-format workflow JSON |
| params | 圈选结果：`[{ key, label, nodeId, inputName, type, default }]`，type ∈ text \| number \| seed \| image |

### batches

| 列 | 说明 |
| --- | --- |
| id, template_id, name, created_at | 基础字段 |
| status | pending \| running \| completed \| canceled |

### jobs

| 列 | 说明 |
| --- | --- |
| id, batch_id, sort_order | 基础字段 |
| params | 该任务的具体参数值（键值对） |
| status | pending \| running \| succeeded \| failed \| canceled |
| comfy_prompt_id | 提交 ComfyUI 后返回的 prompt id |
| error | 失败原因 |
| outputs | 结果文件清单 JSON |
| started_at, finished_at | 时间戳 |

文件布局：输入图片存 `data/uploads/`，输出存
`data/outputs/{batchId}/{jobIndex}-{参数摘要}.{ext}`。文件系统只是产物仓库，
队列真相永远在 SQLite。

## Executor（进程内串行循环）

1. 原子 claim 最早的 pending job（`UPDATE ... SET status='running' WHERE status='pending'`）
2. 组装 prompt：模板 JSON 深拷贝 + 按 params 定义注入参数值；`image` 类型参数先通过
   ComfyUI `/upload/image` 上传
3. `POST /prompt` 取得 `prompt_id`；WS 监听 `progress / executing / executed` 事件，
   经 SSE 转发给前端
4. 完成后从 `/history/{prompt_id}` + `/view` 拉回输出文件落盘，job 标记 succeeded
5. 失败标记 failed 并记录错误，不自动重试；batch 详情页提供「重试失败任务」
6. ComfyUI 掉线：指数退避等待重连，batch 保持 running 不失败

**重启恢复**：启动时扫描 `running` 状态 job——有 `prompt_id` 的查 `/history`
收割结果或重置为 pending；没有的直接重置 pending，循环自然继续。

**取消语义**：cancel batch 将其 pending jobs 置为 canceled；当前 running job
调用 ComfyUI `/interrupt` 尽力中断。

## API 面

全部 `/api/*`，Bearer Token 中间件保护（`GET /api/health` 除外）：

| 端点 | 说明 |
| --- | --- |
| `POST/GET/DELETE /api/templates` | 导入/列表/删除模板 |
| `POST /api/templates/:id/batches` | 创建 batch，请求体带展开好的扁平任务参数列表 |
| `GET /api/batches`、`GET /api/batches/:id` | 列表/详情（含 jobs） |
| `POST /api/batches/:id/cancel` | 取消 |
| `POST /api/batches/:id/retry-failed` | 失败任务重置为 pending |
| `GET /api/events` | SSE：job 状态变化 + 节点级进度 |
| `GET /api/outputs/*` | 画廊图片直出 |
| `GET /api/batches/:id/download` | zip 流式打包 |
| `POST /api/uploads` | 批量图片上传 |
| `GET /api/health` | 自身 + ComfyUI 连通性 |

矩阵展开在前端完成（提交前所见即所得预览任务清单），后端只接收扁平列表。

## 前端（4 个页面）

- **Templates**：模板列表 + 导入向导——上传 JSON → 平铺展示所有节点输入 →
  勾选并命名参数 → 保存
- **New Batch**：选模板后三个参数入口 Tab——表格编辑（粘贴/CSV 导入）、矩阵生成
  （每参数给值列表，实时预览组合数）、图片批量（拖入一批图，每图一任务）；
  提交前预览任务清单
- **Batches**：列表 + 详情——任务表格（状态/参数/错误）、SSE 实时进度、结果画廊
  （缩略图 + 参数对照）、zip 下载、取消/重试
- **Login**：输入 Token 存 localStorage

## 部署

- `compose.yaml`：单 service + `data` named volume
- 环境变量：`COMFYUI_URL`（默认 `http://host.docker.internal:8188`）、`AUTH_TOKEN`、`PORT`
- 本地 Mac 与 VPS/GPU 主机使用同一份 compose，只改 `.env`

## 测试策略

Vitest 单测覆盖三块核心逻辑：

1. 矩阵展开（前端 shared 逻辑）
2. 参数注入 / prompt 组装
3. Executor 状态机（mock ComfyUI client：提交、进度、完成、失败、掉线、恢复）

不做浏览器 E2E，保持轻量。测试默认离线，不连接真实 ComfyUI（借鉴 Gateway 的安全门禁理念）。

## 边界（V1 不做）

- 多 ComfyUI 实例池 / 并行执行
- 自动重试、任务优先级
- 多用户账号体系
- workflow 编辑能力（只导入执行，编辑仍在 ComfyUI 里做）
- S3 / 远程对象存储
