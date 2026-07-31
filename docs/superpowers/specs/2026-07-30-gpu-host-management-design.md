# GPU 主机管理 设计（八期 ①）

日期：2026-07-30
状态：已与用户确认（主机注册表+手动切换；切换弹窗等待/中断二选一；Header 指示灯+主机管理页；URL 可编辑+连通测试）

## 背景

现状是单一 `COMFYUI_URL` 环境变量 → `createComfyClient` 单例注入 executor 与路由。GPU 掉线时 executor 静默退避重试，UI 完全无感知；`/api/health` 已返回 `comfy: boolean` 但前端无人消费。用户场景正在扩展：本地 / 局域网 / 按小时计费的云端租用主机（每次租用地址会变），需要在同一 executor 上登记多台主机并手动切换。

## 目标

1. 主机注册表：可增删改多台 GPU 主机（名称/URL/备注），任一时刻恰有一台「当前主机」
2. 一键切换当前主机，executor 热切换；有任务运行时弹窗选「等它跑完」或「立即中断重排」
3. Header 常驻在线指示灯 + 当前主机名；「GPU 主机」管理页含主机详情卡（GPU 型号/显存/版本/队列/cwe 扩展状态）与每条目连通测试
4. batch 列表/详情页在主机离线且有 running/pending 任务时显示横幅提示
5. job 记录实际执行主机（盖章 hostId），批次跑一半换主机后可追溯

非目标（YAGNI）：多主机并行调度；每主机自定义请求头/鉴权；自动故障转移；计费时长提醒。

## 设计

### 数据模型

`db/index.ts` DDL 新增（`CREATE TABLE IF NOT EXISTS` 风格与现有一致）：

```sql
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`jobs` 旧库迁移（沿用 `PRAGMA table_info` 探测模式）：`ALTER TABLE jobs ADD COLUMN host_id INTEGER`。可空、**不加 FK**——主机删除后历史 job 的 host_id 悬挂，展示层 LEFT JOIN 查不到时显示「已删除主机」。盖章在 repo 的 `claimNextJob` 里完成：置 running 的同一条 UPDATE 里 `host_id = (SELECT id FROM hosts WHERE active = 1)`，executor 无需感知主机 id。

**单活不变量**：repo 层 `activateHost(db, id)` 在事务里 `UPDATE hosts SET active = 0` 全表清零后再置目标为 1。

**种子与自愈** `ensureActiveHost(db, comfyUrl)`（repo 层）：

- hosts 表为空 → 插入 `{ name: '默认主机', url: comfyUrl, active: 1 }`
- 表非空但无 active（如导入了旧版库）→ 激活 id 最小的一条
- 返回当前 active 行

调用点：进程启动（index.ts）与数据导入热切换 reopen 之后（backup.ts）。此后 `COMFYUI_URL` 仅作首次种子，运行期以表为准。

### ComfyClient 扩展

`comfy/client.ts` 接口补两个方法（现有实现模式照抄）：

- `getSystemStats(): Promise<SystemStats>` — `GET /system_stats`，3s 超时；返回 `{ system: { os, comfyui_version, python_version }, devices: [{ name, vram_total, vram_free }] }` 的声明子集
- `getQueueCounts(): Promise<{ running: number; pending: number }>` — 复用 `/queue` 响应计数

### 热切换（executor）

`deps.comfy` 从构造期固定改为**可替换引用**（与 `deps.db` 同模式）。Executor 改造：

- `private readonly comfy` → `private comfy`（可变）
- `resume(db, comfy?)`：可选新 client；传入时替换 `this.comfy`（`gpuUploads` 清空逻辑已有，保持）
- **中断模式**新增放弃机制：`pause(opts?: { abandon?: boolean })`
  - `abandon: true` 时置 `abandonRequested` 标志，并对旧主机 `comfy.interrupt()`（try/catch 吞掉——旧主机已死也照样切）
  - `waitForHistory` 每轮循环开头检查标志，命中则抛内部 `AbandonError`
  - `runPendingOnce` 的 catch 分支识别 `AbandonError` → `resetJobToPending`（而非 failJob），batch 保持 running
  - pause 在当前轮询周期内（≤pollMs）返回，不等 GPU 真正停下

等待模式即现有 `pause()` 不带参数：等当前 job 完成并下载产出。

### ObjectInfoCache 失效

现在 `comfyRoutes` 在 setup 期捕获 client 实例构造 cache。改为：构造参数从 `ComfyClient` 换成 getter `() => ComfyClient | null`（传 `() => deps.comfy`），并新增 `invalidate()` 清空缓存。切换主机与导入 reopen 后都调用——不同主机安装的节点集不同，模板校验/参数选项必须重新拉取。cache 实例提升到 `AppDeps`（`objectInfo: ObjectInfoCache`），hosts 路由与 comfy 路由共用。

### 状态监测与推送

新模块 `host-monitor.ts`：

- `startHostMonitor(deps, intervalMs = 5000)`：setInterval 调 `deps.comfy.isUp()`，维护上次状态；**翻转时**向 `deps.events` 发 `{ type: 'comfy-status', online, hostId, hostName }`（走现有 SSE `/api/events` 广播）；返回 stop 函数
- 主机切换成功后由 hosts 路由主动发一次当前状态事件（带新 hostId/hostName），前端即时更新主机名
- executor 离线退避自带的 `isUp()` 探测与 monitor 并存，双份轻量探测可接受

`/api/health` 响应扩为 `{ ok, comfy, host: { id, name } | null }`（host 取 active 行；异常场景 null）。

### 服务端路由 `routes/hosts.ts`

- `GET /api/hosts` → `{ hosts: [{ id, name, url, note, active, createdAt }] }`
- `POST /api/hosts` body `{ name, url, note? }`（zod 校验，url 去尾斜杠与 config 同处理）
- `PATCH /api/hosts/:id` body `{ name?, url?, note? }`；**改 active 主机的 URL** → 立即重建 `deps.comfy` + cache.invalidate() + `executor.resume(db, newClient)`（等待模式语义：先 `pause()`）——租用 pod 换地址的主路径
- `DELETE /api/hosts/:id`：active 主机 → 409 `{ error: '当前主机不可删除' }`
- `POST /api/hosts/:id/activate` body `{ mode: 'wait' | 'interrupt' }`：目标已 active → 幂等 200；否则 `executor.pause(mode === 'interrupt' ? { abandon: true } : undefined)` → repo.activateHost → 重建 client → cache.invalidate() → `executor.resume(db, newClient)` → 发 comfy-status 事件。等待模式请求挂到完成（与导入一致）
- `POST /api/hosts/:id/test`：对该条目 URL **临建**一次性 client，探 `getSystemStats()`（测延迟）+ `cwePing()`，返回 `{ reachable, latencyMs, cwe, gpuName, vramTotalMB }`；不影响当前连接——新 pod 填完 URL 先测再切
- `GET /api/hosts/current/stats`：当前主机 `getSystemStats()` + `getQueueCounts()` + `cwePing()` 汇总为详情卡数据；离线 → `{ online: false }`

executor 为 null（测试/无 GPU 场景）时 activate 跳过 pause/resume，只换表和 client 引用。

### 与数据导入的交互

backup.ts reopen 段（`finally` 内）追加：`ensureActiveHost(reopened, config.comfyUrl)` → 按导入库的 active 主机重建 `deps.comfy` → `cache.invalidate()` → `executor.resume(reopened, newClient)`。hosts 表在 db.sqlite 内，导出/导入天然随库走，无需动导出逻辑。

### 前端

- `lib/api.ts`：fetchHosts / createHost / updateHost / deleteHost / activateHost(id, mode) / testHost(id) / fetchHostStats / fetchHealth
- **Header**（App.tsx 的 nav，右侧新增 `<HostStatus />`）：状态点（绿在线/红离线/灰初始探测中）+ 当前主机名，点击跳 `/hosts`。初始 `GET /api/health`，之后订阅现有 SSE 的 `comfy-status` 事件即时翻转
- **`/hosts` 页**（导航加「GPU 主机」链接）：
  - 当前主机详情卡：GPU 型号、显存 总量/空闲、ComfyUI/Python 版本、队列 运行中/排队数、cwe 扩展已装/未装；离线时显示离线态
  - 主机列表：名称/URL/备注/active 徽标；行内操作：编辑（弹窗表单）、删除（active 禁用）、「测试」（行内即时显示 可达/延迟/GPU/cwe）、「切换到此主机」
  - 切换时若 health 显示有任务运行 → AlertDialog 二选一「等当前任务跑完再切换」/「立即中断，任务重新排队」；等待模式请求期间全屏忙态遮罩（复用导入样式，**不挂 beforeunload**——切换在服务端自会完成，离开无害）
- **batch 离线横幅**：batches 列表页与 batch 详情页，当 SSE/health 显示离线且页面数据里有 running/pending 任务时，顶部横幅「GPU 主机离线，任务将在恢复后自动继续」
- **batch 详情**：job 表格/详情展示执行主机名（hostId LEFT JOIN hosts；空显示「—」，悬挂显示「已删除主机」）

### 测试（服务端）

1. repo：ensureActiveHost 三分支（空表种子/无 active 自愈/正常返回）；activateHost 单活不变量
2. hosts CRUD：创建/改名改备注/删除；删 active → 409；PATCH active 主机 URL 触发 client 重建（fake 验证）
3. activate：幂等；wait 模式等 pause 完成后才换（fake executor 记录调用序）；interrupt 模式 `pause({ abandon: true })` 被调用
4. executor abandon：运行中 job 在 abandon pause 后回到 pending 且 batch 保持 running；旧主机 interrupt 抛错不影响切换
5. executor resume 换 client：gpuUploads 清空、后续 job 走新 client（fake 断言）
6. ObjectInfoCache：getter 化后 invalidate 生效、切换后重新拉取
7. host-monitor：isUp 翻转才发事件，稳定态不发
8. jobs.host_id：claim 后盖章为当前 active id；迁移对旧库幂等
9. test/current-stats 端点：可达/不可达两态响应形状
10. 导入 reopen 后 ensureActiveHost 被调用（导入含 hosts 表的库 → 按其 active 重建）

web 按惯例不写渲染测试，手动验收清单（放 PR 描述）：

1. Header 指示灯：正常绿；停掉 ComfyUI ≤5s 变红；恢复变绿
2. 离线时 batches/详情页出现横幅，恢复后消失
3. `/hosts` 详情卡显示 GPU 型号/显存/版本/队列/cwe 状态
4. 新增主机 → 测试按钮显示延迟与 GPU 信息；错 URL 显示不可达
5. 空闲时切换主机：无弹窗直接切，Header 主机名更新
6. 运行中切换（等待模式）：当前 job 跑完产出落地后切换，剩余 job 在新主机继续
7. 运行中切换（中断模式）：当前 job 回到排队，立即切到新主机重跑
8. 改 active 主机 URL（模拟租用换地址）：连接迁移，任务继续
9. 删除非 active 主机成功；删 active 被拒
10. 导出 → 导入后主机列表与当前主机保持
11. batch 详情能看到各 job 的执行主机

## 已知取舍

- 探测间隔固定 5s 不可配；executor 与 monitor 双份 isUp 探测（各自 3s 超时的轻请求）可接受
- 单活模型：切换期间（等待模式可能数分钟）请求挂着，无进度反馈，忙态文案说明
- test 端点对不可达主机等满 3s 超时才返回——可接受
- host_id 无 FK：换取删除主机零约束；悬挂 id 由展示层兜底
- WebSocket 进度事件随 client 重建自动重连到新主机（connectEvents 由 executor start 持有），切换瞬间可能丢一两帧 progress，无碍
