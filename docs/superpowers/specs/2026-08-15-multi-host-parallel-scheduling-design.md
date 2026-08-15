# 多主机并行调度 设计文档

**日期**：2026-08-15
**状态**：待实施

## 背景与目标

当前执行器是**单循环单任务**：`Executor` 一个实例、一个循环、`claimNextJob` 一次认领一个 job，配合 `hosts.active=1` 的单活跃主机手动热切换（PR #20）。结果是即便注册了多台 GPU 主机，同一时刻也只有一台在干活——这是整个工具的吞吐天花板。

本期目标：**让所有「参与调度」的主机同时干活**，并把 `active` 这个已经被并行化淘汰的概念改造成它实际承担的角色（参考主机）。

同时确立一个新的数据模型事实：**主机有形态之分**（常驻 / 按小时租用），底层一视同仁地调度，UI 按形态呈现不同信息。

### 为什么现在做

每新增一个功能都在「单主机」假设上加码（`deps.comfy` 单例已被 5 处共用），越晚改造迁移成本越高。

## 核心洞察：认领已经是原子的

`repo.claimNextJob` 用的是 better-sqlite3 的**同步**事务，函数体内没有任何 `await`：

```ts
return db.transaction((tx) => {
  const row = tx.select(...).where(status='pending').orderBy(...).limit(1).get()
  ...
  const job = tx.update(jobs).set({status:'running', ...}).where(id=? AND status='pending').returning().get()
})
```

在 Node 单线程 + 同步 SQLite 驱动下，两个 worker 的认领事务**无法交错执行**——一个 worker 的「查 pending → UPDATE → 返回」整段跑完，下一个才能开始。

因此并行调度中通常最棘手的部分（无锁任务认领、防重复派发）在本代码库中已经免费成立。**约束**：`claimNextJob` 必须保持同步、不得引入 `await`，否则这个性质立即失效。此约束必须写进代码注释。

## 架构：每主机一个 Executor 实例 + ExecutorPool

保留现有 `Executor` 类，从「单例」变为「每台参与调度的主机一个实例」，各自持有自己的 `comfy` client、`clientId`、`gpuUploads`、`currentJobId`、循环与 WS 连接。新增 `ExecutorPool` 只负责生命周期。

### 为什么不是「单循环 + N 个并发槽」

两个性质会因此免费获得，换成并发槽方案则要额外写代码维护：

1. **进度事件天然正确**。`progress` 事件靠 `this.currentJobId` 单值定位任务；每主机一个实例后，每个实例有自己的 WS 连接与 `currentJobId`，这段代码一行不动。共享实例则必须改为按 promptId 路由。
2. **`gpuUploads` 天然按主机隔离**。它是「本地 uploads 文件名 → GPU 侧返回名」的映射，本来就必须 per-host（同一张图上传到不同主机得到不同的引用），实例化正好把它切对。

且 `waitForHistory`、`recover`、`collectOutputs` 这些被多轮 bug 打磨过的逻辑完全不动。

### 每主机固定 1 个 worker

不提供每主机并发数配置。ComfyUI 单实例串行执行 prompt，同一主机并发提交只会堆在它自己的队列里，不会更快。

### ExecutorPool 职责

```
ExecutorPool
  ├── workers: Map<hostId, Executor>
  ├── syncFromDb()      — 按 hosts 表 enabled 状态增删 worker（幂等，可反复调用）
  ├── pauseAll()        — 数据导入热切换用（换 db 句柄前停全部）
  ├── resumeAll(db)     — 数据导入后恢复
  ├── stopWorker(hostId, {abandon})  — 停用主机：graceful / 放弃重排
  └── reclaimOrphans()  — 启动时重置无主的 running job
```

`AppDeps.executor` 的类型由现在的 `{pause, resume}` 改为 `ExecutorPool`。数据导入（PR #18）继续调用 `pauseAll/resumeAll`，语义不变。

### 启动顺序

1. `reclaimOrphans()`：把 `status='running'` 且 `host_id` 不在当前启用主机集合中的 job 重置回 pending（含 `host_id IS NULL` 的历史数据，以及指向已删除主机的 job）
2. `syncFromDb()`：为每台 `enabled=1` 的主机起一个 worker
3. 每个 worker 各自 `recover()`，只收割 `host_id = 自己` 的 running job

`recover()` 需要从「收割全部 running job」改为「收割本主机的 running job」——这是并行化下唯一会误伤的既有逻辑（否则 A 主机启动时会去收割 B 主机正在跑的任务）。

## 数据模型

### hosts 表新增 5 列

沿用现有迁移模式（`PRAGMA table_info` 探测 + `ALTER TABLE ADD COLUMN`，幂等，随 `createDb` 执行，数据导入的候选库演练会自动补列）：

| 列 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | INTEGER NOT NULL | 1 | 是否参与调度。存量主机默认全部参与 |
| `kind` | TEXT NOT NULL | `'resident'` | `resident` \| `rental` |
| `rented_at` | TEXT NULL | — | 租用型起租时间（ISO） |
| `hourly_rate` | REAL NULL | — | 时薪，选填；不填只显示时长不显示费用 |
| `disabled_reason` | TEXT NULL | — | 自动停用原因（熔断写入，手动启用时清空） |

`active` 列保留，**语义改为「参考主机」**（见下）。

### batches 表新增 1 列

| 列 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `pinned_host_id` | INTEGER NULL | — | 锁定主机；非空时该批次只在此主机执行 |

### jobs 表

`host_id` 已存在（PR #21 加的），无需改动。

## 调度

### claimNextJob 签名变更

```ts
claimNextJob(db: Db, hostId: number): { job, template } | undefined
```

- `hostId` 显式传入并写入 `jobs.host_id`，替换原先写死的 `(SELECT id FROM hosts WHERE active=1)`
- 查询条件增加锁定过滤：`(batches.pinned_host_id IS NULL OR batches.pinned_host_id = :hostId)`
- 排序保持不变（`batches.id ASC, jobs.sort_order ASC`），即先来的 batch 先做完；多个 worker 自然从同一有序队列头部取活

### 主机离线

worker 循环中已有的 `isUp()` 指数退避保持不变。一台离线不影响其他 worker 继续认领。正在该主机上跑的 job 仍走现有 `waitForHistory` 的无限等待重连逻辑（batch 保持 running）——并行后这不再阻塞其他主机，可接受。

## `active` 退位为参考主机

`deps.comfy` 目前被 5 处共用，本期只拆开执行器那一处，其余仍需一台确定的主机：

| 用途 | 位置 |
|---|---|
| `/api/health` 的 comfy 布尔 | `app.ts` |
| `/object_info` 节点缓存（模板导入的 enum 取值） | `ObjectInfoCache` |
| GPU 侧 input 文件列表（图片选择器） | `routes/comfy.ts` |
| GPU 输出缩略图代理 | `routes/thumbs.ts` |
| 图片尺寸探测 | `routes/comfy.ts` |

这些继续使用 `active` 主机的 client。

### 参考主机离线时不自动回退

**明确决定：不回退到任意在线主机。** 不同主机装的模型与自定义节点可能不同，静默换一台去问「有哪些 checkpoint」，会让用户选到目标主机上并不存在的模型——错误要到执行时才炸，且表现为随机失败。

改为明确降级：UI 显示「参考主机离线，模板导入与图片选择暂不可用」。用户想换手动换。

### activate 简化

由于 `active` 不再影响任何 worker，`POST /api/hosts/:id/activate` **不再需要 pause/abandon**，`mode: wait|interrupt` 参数移除，请求体为空。实现降为：换 `deps.comfy`、`objectInfo.invalidate()`、广播事件。

该模式选择迁移到「停用主机」对话框（见下）——切换与停用的语义正好互换位置。

前端「切换主机」按钮改名「设为参考主机」。

## 熔断

### 判定口径

该 worker **连续** N 个 job 以 `failed` 收场即触发。

- `AbandonError`（主动放弃 / 停用重排）**不计**
- 主机不可达导致的等待**不计**——那不是失败，由退避逻辑管
- 成功一个即清零

**N = 3**（常量，不进 .env）。

### 触发动作

计数器在 `Executor` 实例内（内存，worker 重启即清零，符合预期）；达阈值时 worker **只上报**，写库与停机由 `ExecutorPool` 执行——保持「worker 不改自己的生命周期」这条边界，避免自杀式停机与 pool 的 `syncFromDb` 打架：

1. `hosts.enabled = 0` 且 `disabled_reason = '连续 3 次任务失败'` —— **持久化**，不是内存标记：否则容器一重启坏主机就复活，用户永远不知道曾经发生过
2. 停止该 worker（此刻没有在跑的任务，走 graceful）
3. SSE 广播 `host-disabled { hostId, hostName, reason }`
4. 前端 toast + hosts 页显著标注

### 恢复

仅手动：重新勾选「参与调度」，同时清空 `disabled_reason`。不做冷却自动重试——自动复活会让「坏主机反复烧任务」这个正要解决的问题重现。

### 必须处理的边界：全部熔断

若失败源自任务本身（例如模板引用了所有主机都没有的模型），每台主机各烧 3 个任务后**全部熔断**，剩余任务停在 pending 无人认领。

**必须有明确提示**：当存在 pending 任务但无任何启用主机时，batch 详情与 Batches 列表显示「所有主机均已停用调度，任务无人执行」并给出前往主机管理的入口。否则用户只会看到任务卡住不动、毫无线索。

## 停用主机：两种模式

停用对话框提供两个按钮：

| 模式 | 实现 | 语义 |
|---|---|---|
| **等当前任务跑完** | `enabled=0` + `pause()`（不带 abandon） | graceful drain：不再接新活，当前任务跑完自然结束。不浪费已算了一半的图 |
| **立即放弃并重排** | `pause({ abandon: true })` | 复用现有 abandon 链路：interrupt 旧主机 + `resetJobToPending`，任务回池由别的主机重跑 |

现有的无参 `pause()` 恰好就是 graceful drain 语义，直接复用。熔断触发的停用走 graceful。

## 主机形态

### 表单

添加/编辑主机表单增加「形态」选择，**默认常驻**。选「按小时租用」时额外显示：

- 起租时间（默认取创建时间，可改）
- 时薪（选填）

### hosts 页呈现

- **常驻**：与现在一致
- **租用**：额外显示「已运行 Xh Ym」；填了时薪则显示估算费用

### 空闲提醒

租用主机的 worker 满足「在线 且 连续 5 分钟无任务可领」时，SSE 广播 `host-idle { hostId }`，前端 toast：

> 租用主机 X 已空闲 5 分钟，仍在计费中，考虑下线

- 空闲计时只在**在线且认领返回空**时推进；离线不计（离线是另一个已被展示的问题，且无法判断是否仍在计费）
- 每次成功认领即清零
- 同一次空闲只提醒一次（重新有活再空闲才会再提醒）
- 阈值 5 分钟为常量

### 本期不做

自动下线、云厂商 API 集成（需要凭据管理，另行立项）、成本汇总报表、按成本智能派发。

## Batch 锁定主机

### 问题

image 参数有三种来源（PR #5）。执行时：**本地 uploads 存在的图会上传到目标主机**（`gpuUploads` per-worker 各自上传，无问题）；**直接引用 GPU 侧已有文件名**的图不会上传，派到没有该文件的主机必然失败。

单主机时代不存在此问题。并行后有恶性后果：**连续 3 个这样的任务会把一台完全健康的主机熔断**。

### 方案

建批时检测：若任一 job 的 image 参数值**不存在于本地 uploads**，则把该 batch 的 `pinned_host_id` 设为当时的参考主机 id，并在建批 UI 提示：

> 本批次引用了主机 X 上的文件，将只在该主机执行

`claimNextJob` 的锁定过滤条件保证只有该主机能认领。

### 锁定主机不可用时

`pinned_host_id` 指向的主机被删除或停用后，该 batch 会永远无人认领。**必须显式提示**：batch 详情显示「本批次锁定在主机 X，该主机当前不可用」，而不是静静卡住。

删除主机时，若存在锁定到它的未完成 batch，删除对话框显示数量警告，但**允许继续**（阻止删除会让用户被历史批次绑架）。

## 主机在线状态的来源

现有 `host-monitor` 每 5 秒只探测 `deps.comfy`（参考主机）一台，翻转时广播 `comfy-status`。并行后需要全部主机的在线状态，且有一个前端拿不到初始态的缺口：`comfy-status` 只在**翻转时**广播，前端的初始态来自 `/api/health`，而 health 只报参考主机。

改造：

- host-monitor 每轮探测**全部主机**（含未启用的，便于用户判断能否启用），在内存中维护 `Map<hostId, online>`，逐台翻转时各自广播 `comfy-status`
- `GET /api/hosts` 返回的每个 host 附带 `online: boolean | null`，**取自 monitor 缓存而非实时探测**（`null` = 尚未探测过）。这是前端的初始态来源
- `/api/health` 的 `comfy` 字段语义不变（仍指参考主机），供登录后的首屏与 SSE 断线兜底使用

探测并发：全部主机并行 `isUp()`，单台失败不影响其他。主机数量是个位数，无需限流。

### 前端状态结构重构

`hooks/use-comfy-status.ts` 现在把状态存成**单个对象** `{online, hostId, hostName}`，SSE 直接覆盖写入。并行后必须改为**按 hostId 的映射**：

- 查询缓存键 `['comfy-status']` 的值从单对象改为 `Record<hostId, {online, name}>`
- 初始态由 `GET /api/hosts` 的 `online` 字段填充（替代 `/health`）
- SSE `comfy-status` 事件按 `hostId` 局部更新该映射中的一项，不再整体覆盖
- 派生量（有几台在线 / 是否无可用主机 / 参考主机是否在线）抽成 `apps/web/src/lib/` 的纯函数并配单测

这是本期前端改动量最大的一处，且是所有依赖在线状态的组件（头部指示灯、离线横幅、batch 详情横幅）的共同底座，须先落地。

## 事件与前端

### SSE 事件变更

| 事件 | 变更 |
|---|---|
| `comfy-status` | 现有 `{online, hostId, hostName}` 保持结构，但改为**每台主机各自广播**（原先只有活跃主机一路） |
| `host-disabled` | 新增 `{hostId, hostName, reason}` |
| `host-idle` | 新增 `{hostId, hostName, idleMinutes}` |
| `job-updated` | 增加 `hostId` 字段，前端无需 refetch 即可显示任务落在哪台主机 |

### 前端受影响组件

| 组件 | 变更 |
|---|---|
| `hooks/use-comfy-status.ts` | 单对象 → 按 hostId 映射（见上），全站在线状态的底座，须先落地 |
| `components/host-status.tsx` | 头部指示灯从「单主机在线/离线」改为聚合「N/M 台在线」，HoverCard 列出每台状态；参考主机单独标注 |
| `components/offline-banner.tsx` | 从「主机离线」改为「无可用主机」（全部离线或全部停用时才显示） |
| `pages/hosts.tsx` | 「参与调度」勾选、形态字段与租用信息、停用双模式对话框、自动停用标注、每主机独立 stats |
| `pages/batch-detail.tsx` | 锁定主机不可用提示、无启用主机提示 |
| `pages/batch-new.tsx` | 锁定提示 |

### 每主机 stats

现有 `GET /api/hosts/current/stats` 只服务参考主机。新增 `GET /api/hosts/:id/stats`（同样的返回结构），供 hosts 页每张卡片显示各自的 VRAM / 队列 / cwe 扩展状态。`/current/stats` 保留给头部指示灯使用。

## API 变更汇总

| 端点 | 变更 |
|---|---|
| `POST /api/hosts` | 请求体增加 `kind`、`rentedAt`、`hourlyRate`（均可选，kind 默认 resident） |
| `PATCH /api/hosts/:id` | 同上；另支持 `enabled: true` **启用**（并清空 `disabled_reason`）。**停用不走 PATCH**——它需要模式选择，必须走下面的 disable 端点，避免两条路径语义分叉 |
| `POST /api/hosts/:id/activate` | **移除 `mode` 参数**，请求体为空；不再 pause executor |
| `POST /api/hosts/:id/disable` | **新增**，`{ mode: 'wait' \| 'interrupt' }`，停用并按模式处理在跑任务 |
| `GET /api/hosts/:id/stats` | **新增**，按 id 探测任意主机（hosts 页每张卡片各自调用） |
| `GET /api/hosts` | 每个 host 附带 `online`（monitor 缓存）与锁定该主机的未完成 batch 数 |
| `DELETE /api/hosts/:id` | 删除前先停该主机 worker；**参考主机仍不可删（409，语义不变）**；返回锁定 batch 数量供前端警告 |

`GET /api/hosts/current/stats` 保留，服务头部指示灯里参考主机的详情卡。

`PATCH /api/hosts/:id` 改 URL 的重连逻辑收窄：只重建**该主机**的 worker 与 client，不再影响其他 worker（原先是全局 pause/resume）。

### 串行锁的新职责

`switchLock`（PR #20 引入，`host-switch.ts`）原先串起「activate / 改 URL / 删除 / 数据导入」四个入口，防止起出两个 executor loop。并行后职责调整：

- **仍需进锁**：数据导入（`pauseAll`/`resumeAll` 换 db 句柄）、改主机 URL、启用/停用、删除——它们都会增删或重建 worker
- **不再需要进锁**：`activate`（只换参考主机 client，不碰任何 worker）

`ExecutorPool.syncFromDb()` 设计为**幂等**（按 hosts 表状态对齐 worker 集合），即便多个入口先后调用也不会起出重复 worker——这是对锁的第二道防线，不是替代。

## 测试策略

服务端 249 个测试基于 `FakeComfy`；`deps.comfyFactory`（PR #21 引入）已经是可注入的按 URL 建 client 工厂，多主机测试直接复用。

必须覆盖：

1. **迁移**：旧库（无新列）经 `createDb` 后补齐列且默认值正确；存量主机 `enabled=1`、`kind='resident'`
2. **并行认领**：两个 worker 从同一队列取活，不重复、不遗漏；`host_id` 正确落到各自主机
3. **锁定**：pinned batch 只被指定主机认领，其他 worker 跳过它继续取后面的活
4. **熔断**：连续 3 次 failed → `enabled=0` + `disabled_reason` 写入 + 事件广播；中间成功一次则计数清零；AbandonError 不计入
5. **停用双模式**：graceful 让当前任务跑完；abandon 重置回 pending 且被另一主机接手
6. **orphan 回收**：`host_id` 为 NULL / 指向已删除主机的 running job 在启动时重置为 pending
7. **recover 隔离**：A 主机启动不收割 B 主机的 running job
8. **空闲提醒**：租用主机在线空转达阈值触发一次；认领后清零；常驻主机不触发
9. **参考主机**：activate 不再 pause executor（并行任务不中断）
10. **在线状态**：monitor 探测全部主机、逐台翻转各自广播；`GET /api/hosts` 的 `online` 取自缓存不触发实时探测；未探测过为 `null`
11. **幂等性**：`syncFromDb()` 连续调用两次不会为同一主机起出两个 worker

web 包**不写渲染测试**（既有约定）；纯逻辑抽 `apps/web/src/lib/` 纯函数配 node 环境单测，本期至少包括：在线状态映射的派生量（几台在线 / 是否无可用主机 / 参考主机是否在线）、租用主机的时长与费用计算。

## 部署与兼容

- **无新依赖**
- **comfyui-cwe 扩展无变更**
- 数据库迁移随 `createDb` 自动执行；旧备份导入后同样自动补列
- 存量单主机用户升级后行为不变：唯一的那台主机 `enabled=1` 且仍是 `active`，退化为单 worker

## 已知限制（不在本期解决）

- 每主机固定 1 worker，不支持单机多并发
- 不做跨主机的智能派发（按 VRAM / 速度 / 成本选主机）；取活是先到先得
- GPU 侧 input 文件引用仍是 host-scoped，本期用 batch 锁定规避而非消除
- 参考主机离线时模板导入 / 图片选择功能不可用（有意为之，见上）
- 租用主机只做提醒，不做自动下线
