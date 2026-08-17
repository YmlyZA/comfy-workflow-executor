# 代码审查记录：2026-08-18

## 背景与基线

本次对 `comfy-workflow-executor` 做了一次全面静态代码审查，范围包括：

- `apps/server`：Hono API、SQLite/Drizzle 数据层、ComfyUI 客户端、执行器、主机热切换、备份/维护。
- `apps/web`：React + TanStack Query 页面、表格/图片控件、Prompt 补全、主题与 SSE。
- `packages/shared`：类型、prompt 构建、矩阵展开、尺寸计算。
- `comfyui-cwe`：ComfyUI 扩展的受限文件删除端点。

检查基线：

- `pnpm typecheck` 通过。
- `pnpm test` 通过：shared 30、web 43、server 249，共 322 个测试。

整体评价：工程质量较好，类型严格、事务边界和热切换锁处理细致，测试覆盖较完整。没有发现会导致当前测试失败或常规主流程崩溃的严重 bug，但存在若干需要优先处理的可靠性、前端渲染和边界校验问题。

## 建议优先修复

### 1. 执行器重启恢复时可能重复提交任务

位置：`apps/server/src/executor.ts`

`recover()` 只调用 `getHistory()`。如果服务重启时 ComfyUI 仍在线且任务还在其队列里执行，此时 `getHistory()` 可能返回 `null`，代码会把该 job 重置为 `pending`，随后主循环再次 claim 并提交同一任务，造成重复执行。

`waitForHistory()` 已经有“history 未写入时再看 queue”的逻辑，但 `recover()` 没有复用这套语义。

处理建议：

- 恢复时同时查询 `getQueuedIds()`。
- 如果 prompt 仍排队或执行中，应保留/接管该 job，而不是 reset 后重新提交。

### 2. GPU 孤儿缩略图存在重复 React key

位置：`apps/web/src/pages/maintenance.tsx`

`scan.orphans.map()` 中每个 `GpuOrphanThumb` 的 key 都是 `scanGen`，兄弟节点 key 完全相同。React 会告警，且缩略图、勾选状态可能被错误复用。

处理建议：

- key 必须包含文件身份，例如 `` `${scanGen}:${k}` ``。

### 3. “以此新建”的预填存在竞态

位置：`apps/web/src/pages/batch-new.tsx`

`TableEntry` 的 `useState` 只在首次挂载时读取 `initialRows`，但 `initialRows` 来自异步 `fromBatch`。如果 templates 列表先加载完成，`TableEntry` 先用空行挂载，后续 `initialRows` 到达不会回填，导致预填失效。

处理建议：

- 增加 `useEffect` 同步 `initialRows`。
- 或在 `from` 场景下等 `initialRows` 到位后再挂载表格。

### 4. 多处路径参数没有数字校验

位置：`apps/server/src/routes/templates.ts`、`apps/server/src/routes/prompts.ts`、`apps/server/src/routes/batches.ts` 等

`/api/templates/abc`、`/api/prompts/abc` 这类请求会 `Number('abc')` 得到 `NaN`，再交给 better-sqlite3 查询，容易产生 500，而不是 400/404。

`hosts.ts` 已有 `idParam` 校验模式。

处理建议：

- 统一路径参数数字校验，非纯数字直接返回 400。
- 或使用 Hono validator 统一处理。

## 需要关注的中等问题

### 5. ComfyClient 大量网络请求没有超时

位置：`apps/server/src/comfy/client.ts`

以下方法缺少 `AbortSignal.timeout`：

- `interrupt()`
- `uploadImage()`
- `submit()`
- `getHistory()`
- `getQueuedIds()`
- `getObjectInfo()`
- `getInputImage()`
- `downloadOutput()`
- `getOutputImage()`

其中 `getHistory()` 和 `interrupt()` 直接影响执行器 loop 与 `pause()`。ComfyUI 半开连接或假死时，可能永久卡住执行器或主机切换。

处理建议：

- 为除大文件下载外的请求统一加合理超时。
- 大文件下载也应设置较长超时，避免无限挂起。

### 6. ComfyUI 返回的文件名直接拼接本地路径

位置：`apps/server/src/executor.ts`

`collectOutputs()` 直接使用 `ref.filename` 拼接输出路径，没有做 `basename` 或 `..` 过滤。正常 ComfyUI 返回的是纯文件名，但自定义节点或异常响应可能返回路径片段。

处理建议：

- 落地前对 `ref.filename` 做 sanitize，例如只取 `basename`。
- 保留防御性路径校验。

### 7. 数据导入重开数据库失败时仍返回成功

位置：`apps/server/src/routes/backup.ts`

导入流程中如果 `createDb()`、`ensureActiveHost()` 或 `reconnectComfy()` 失败，代码只打印日志，然后仍返回 `{ ok: true }`。此时 `deps.db` 可能已关闭，executor 永久暂停，但前端会提示导入成功并刷新。

处理建议：

- 重开失败时返回 500。
- 前端收到失败时不要执行自动 reload。

### 8. 批量操作并发无上限

位置：`apps/web/src/lib/bulk.ts`

`runBulk()` 使用 `items.map(fn)` 一次性并发所有请求。批量删除/取消大量 batch 时会瞬间打满连接，也可能触发 SQLite 锁竞争或 HTTP 限流。

处理建议：

- 增加并发上限，例如每次 5–10 个请求。
- 对失败项保留当前“部分成功不中断”的语义。

### 9. 主机 URL 校验过弱

位置：`apps/server/src/routes/hosts.ts`

`urlSchema` 只检查前缀 `http(s)://`，`http://` 这类没有 hostname 的值也能通过校验。

处理建议：

- 使用 `new URL()` 并检查 hostname 非空。
- 或在 zod 中补充 host 部分约束。

### 10. canceled batch 可能被 retry/reroll 复活

位置：`apps/server/src/db/repo.ts`

`retryFailedJobs()` 和 `rerollJob()` 不检查 batch 当前状态。已取消的 batch 如果仍残留 failed/succeeded job，相关接口会把 batch 改回 `running`。

处理建议：

- 明确产品语义：`canceled` 批次是否允许重新进入执行队列。
- 如果不允许，在 repo 或 route 层加状态守卫。

## 优化与加固建议

- 主机 `active` 唯一性最好落到数据库约束：目前只靠代码保证单活，历史脏数据可能造成多个 active。可加 partial unique index，或让 `ensureActiveHost()` 清理多余 active。
- 上传/导入缺少大小和类型限制：`POST /api/uploads` 接受任意大文件、任意类型；备份导入同理。建议加体积上限和图片魔数校验。
- 模板排序拖拽与分页并存：当前只在当前页显示行却允许拖拽，超过 20 个模板时无法跨页重排。可禁用重排并提示，或重排时关闭分页。
- ComfyUI output 引用可去重：同一文件被多个输出节点引用时会重复下载。
- 前端 SSE 全量失效：`useEvents` 在每次 `job-updated` 时 invalidate 所有 `batches` 查询，大批次运行中会比较频繁；可按 `batchId` 精确失效。
- 登录/删除历史的小异常处理：`login.tsx` 网络失败没有 catch；`TextValueControl.remove()` 删除历史失败没有错误提示。

## 结论

没有发现会破坏当前测试或常规主流程的严重 bug，但建议按以下顺序处理：

1. 执行器 `recover()` 重复提交。
2. GPU 孤儿缩略图重复 React key。
3. “以此新建”预填竞态。
4. ComfyClient 请求超时。
5. 路径参数数字校验。

其余问题可纳入后续迭代的技术债清单。
