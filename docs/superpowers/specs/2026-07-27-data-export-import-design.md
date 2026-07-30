# 数据导出导入 设计（七期规划 ⑦）

日期：2026-07-27
状态：已与用户确认（全量 zip、thumbs 除外；导入=整体替换+进程内热切换）

## 背景

所有数据都在 `dataDir`（默认 `./data`）：`db.sqlite`（WAL 模式）+ `uploads/`（输入图）+ `outputs/<batchId>/`（产出图）+ `thumbs/`（可再生缩略图缓存）。需要一键备份与恢复，用于迁移和防丢。

## 目标

1. `GET /api/export`：流式下载整个数据目录的 zip（排除 thumbs 与 WAL 附属文件）
2. `POST /api/import`：上传 zip 整体替换现有数据，进程内热切换，无需重启服务
3. 前端「数据备份」入口：导出下载 + 导入（带整体替换确认）

非目标：选择性导出（勾选范围）；增量/合并导入；自动定时备份；跨版本 schema 迁移（导入的库由 `createDb` 的 DDL/迁移逻辑照常兜底）。

## 设计

### 导出 `GET /api/export`

1. `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合回主库（否则 zip 里的 db.sqlite 缺最近写入）
2. `archiver` 流式打 zip：
   - `db.sqlite` 在包根部
   - `uploads/`、`outputs/` 整目录（不存在则跳过）
   - 排除：`thumbs/`、`db.sqlite-wal`、`db.sqlite-shm`
3. 响应头：`Content-Type: application/zip` + `Content-Disposition: attachment; filename="cwe-backup-<YYYY-MM-DD>.zip"`
4. 流式写出（archiver stream → Response），GB 级 outputs 不占内存

### 导入 `POST /api/import`

**上传方式：raw body**（`Content-Type: application/zip`，请求体即 zip 字节流），不用 multipart——Hono 的 `parseBody` 会把整个文件读进内存，GB 级包会炸；raw body 直接流式落到临时文件。

流程：

1. 请求体流式写入 `dataDir` 同级的 `<dataDir>.import-<时间戳>.zip`
2. `yauzl` 流式解压到同级临时目录 `<dataDir>.import-<时间戳>/`：
   - 每个 entry 路径校验：拒绝绝对路径与 `..`（zip-slip 防护），违规 → 400，清理临时文件，原数据不动
3. 校验：临时目录根部必须有 `db.sqlite` 且能被 better-sqlite3 只读打开（查 `sqlite_master` 成功即可），否则 400 `{ error: 'zip 内缺少有效的 db.sqlite' }`，原数据不动
4. **热切换**（进入前置并发闸：进行中再来一个导入 → 409）：
   - 暂停 executor 并等待当前任务收尾（可能等数分钟，请求挂着）
   - 关闭现有 sqlite 句柄
   - `rename(dataDir, <dataDir>.bak-<时间戳>)`；`rename(临时目录, dataDir)`
   - `mkdir -p` `uploads/`、`outputs/`（导入包可能缺）
   - `createDb` 重开 → 替换 `deps.db` 引用 → executor 换库并重启
5. 返回 `{ ok: true }`；任何一步失败尽力回滚（bak 目录移回）并 500

### 配套改造

- `createDb` 返回值附带原生 better-sqlite3 句柄（导出 checkpoint、导入 close 都要用）——改为返回 drizzle 实例上挂 `$client`（drizzle 自带）或显式导出 `{ db, sqlite }`，取现有代码改动最小的方式，测试同步调整
- `Executor`：`db` 去掉 `readonly`；新增 `pause(): Promise<void>`（置停止标志并等 loop 退出/当前任务收尾）与 `resume(db)`（换库后重新 `start()`）。现有 `stop()` 行为不变
- `AppDeps` 增加 `executor: Executor | null`（测试与无 comfy 场景传 null，导入时跳过暂停/重启步骤）；路由本就每请求读 `deps.db`，替换引用即生效

### 前端

导航底部（或设置区）「数据备份」：

- 导出：`<a>` 直链 `/api/export`（带 token query，同现有下载模式）
- 导入：文件选择（.zip）→ 确认弹窗写明「将整体替换现有全部数据，且不可撤销（旧数据保留在服务端 bak 目录）」→ `fetch` raw body 上传 → 成功后 `location.reload()`（作废全部 react-query 缓存）
- 导入进行中显示忙态（上传+等待切换可能较久）

### 新依赖（apps/server）

`archiver`（流式打包）+ `yauzl`（流式解压），纯 JS 无原生编译，不动 pnpm-workspace.yaml 的 allowBuilds。

### 测试（服务端）

1. 导出：小型临时 dataDir（db + uploads/1 文件 + outputs/1/1 文件 + thumbs/1 文件）→ zip 内含 db.sqlite/uploads/outputs、不含 thumbs 与 -wal/-shm
2. 导出前 checkpoint：写入一条数据后立即导出，解包后的 db 能读到该数据
3. 导入：构造合法 zip → 200，替换后 GET 列表返回 zip 内库的数据；uploads 文件落位
4. 导入非法：非 zip 字节流 → 400；zip 缺 db.sqlite → 400；zip-slip 路径 → 400——三者之后原数据完好
5. 导入后 bak 目录存在且含旧 db
6. 并发闸：导入进行中再发导入 → 409（用慢流模拟或直接测闸变量）
7. executor 为 null 时导入照常成功（测试环境路径）

web 按惯例不写渲染测试，手动验收清单（放 PR 描述）：

1. 导出下载的 zip 用系统工具能打开，含 db.sqlite/uploads/outputs、无 thumbs
2. 导入刚导出的 zip → 页面刷新后数据一致；服务端出现 bak 目录
3. 导入期间 UI 忙态；完成自动刷新
4. 选非 zip 文件导入 → 报错且数据不变
5. 有任务运行中导入 → 等当前任务完成后切换，任务不丢
6. 导入后新建批次、跑图正常（executor 换库后工作正常）

## 修订（2026-07-29，验收反馈）

- **热切换不再 rename dataDir 自身**：Docker 部署时 dataDir 是 volume 挂载点，`rename(dataDir, bak)` 报 EBUSY；且挂载点外的临时目录与 dataDir 跨文件系统，rename 会 EXDEV。改为：临时 zip / 解压目录 / bak 全部放在 dataDir 内部（`.import-<stamp>.zip`、`.import-<stamp>/`、`.bak-<stamp>/`），切换时目录内逐项搬移（旧条目 → bak，新条目 → dataDir），失败按已搬清单回滚。导出与 `.import-*`/`.bak-*` 互不可见（导出只取 db.sqlite/uploads/outputs）。
- **前端导入期间锁定 UI**：全屏遮罩阻断页内一切操作 + `beforeunload` 拦截刷新/关闭，完成后自动刷新。导出为浏览器托管下载，开始后离开页面不影响，页面文案说明。

## 已知取舍

- bak 目录只增不删，磁盘占用靠手动清理——备份安全优先，工具单用户可接受
- 导入等待当前任务收尾期间请求一直挂着（无进度反馈）——简单可靠，忙态文案说明即可
- 导入的 db 若来自更新版本的 schema（未来字段），旧代码可能报错——单用户工具不做版本协商，导入包与服务版本由用户自行对应
- raw body 上传无断点续传——局域网场景可接受
