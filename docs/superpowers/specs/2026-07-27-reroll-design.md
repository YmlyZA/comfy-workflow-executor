# 重roll 不满意图片 设计（七期规划 ③）

日期：2026-07-27
状态：已与用户确认（入口=画廊卡片+Lightbox；粒度=点一次追加 1 个）

## 背景

批量出图后，部分成功图片不满意。现有「重试失败任务」只针对 failed；对 succeeded 但效果不好的图，用户只能「以此新建」整个 batch，太重。需要轻量的「换个 seed 再来一张」。

立项已定方向：独立语义（不复用 retry）、追加本 batch（不新建）、seed 换随机、不碰 failed。

## 目标

对画廊中任意一张成功输出，一键追加一个「同参数、新随机 seed」的任务到本 batch 队尾，由 executor 自动执行，新图完成后出现在画廊。

非目标：×N 数量选择；来源标记/血缘（新 job 就是普通 job，无 schema 变更）；对 failed job 的重roll（已有 retry-failed）；矩阵/CSV 层面的重roll。

## 设计

### 服务端：`POST /api/batches/:id/jobs/:jobId/reroll`

校验（依次）：

1. batch 不存在 → 404 `{ error: 'batch not found' }`
2. job 不存在或不属于该 batch → 404 `{ error: 'job not found' }`
3. job.status !== 'succeeded' → 400 `{ error: '只能重roll成功的任务' }`
4. 模板 params 中没有 `type === 'seed'` 的参数 → 409 `{ error: '模板没有 seed 参数,重roll 会生成相同图片' }`

通过后在**一个事务**内：

- 复制源 job 的 `params`；对模板中每个 `type === 'seed'` 的参数，把值替换为独立的新随机数 `Math.floor(Math.random() * 2 ** 31)`（源 params 里没有该 key 也要写入，保证覆盖模板默认值）
- 以 `批内 max(sortOrder) + 1` 插入新 job（status pending，其余字段空）
- batch status 置 `'running'`（completed / canceled 都会复活；与 retryFailedJobs 同模式——claimNextJob 只认领 `batches.status IN ('pending','running')` 的 job）

响应 201 `{ jobId, sortOrder }`；随后 emit `{ type: 'job-updated', jobId, batchId, status: 'pending' }` 与 `{ type: 'batch-updated', batchId, status: 'running' }`。

executor 零改动：轮询 claimNextJob 自动认领新 pending job；输出文件名带 `sortOrder-` 前缀，不与旧输出冲突。

### 前端：batch-detail 两个入口

- **画廊卡片**：右上角 hover 显示小按钮（Dices 图标，`onClick` 内 `stopPropagation` 避免触发 Lightbox）
- **Lightbox**：底部信息区加「重roll」按钮
- 两处共用一个 `useMutation`：`POST .../reroll`，成功后短暂提示「已追加 #<sortOrder>」（复用页面既有横幅/文本提示模式）；进度与新图靠既有 SSE 事件流自动刷新，不需要手动 invalidate 画廊
- **禁用态**：模板无 seed 参数时按钮禁用 + title「模板没有 seed 参数」（用 detail 响应中的 template.params 判断；服务端 409 双保险）
- mutation 进行中按钮禁用防连击（连点多次=追加多个是合法操作，但单次请求期间禁用避免重复提交同一次点击）

### 测试

服务端路由测试（fake executor 不参与，直接查 DB 断言）：

1. 成功重roll：201、新 job pending、params 除 seed 外与源一致、seed 已变化、sortOrder = 批内 max+1、batch 变 running
2. completed batch 重roll 后复活为 running；再跑 executor（runPendingOnce）能认领并完成，batch 回到 completed
3. 多个 seed 参数各自随机（两个 seed key 都被替换且写入）
4. 源 params 缺 seed key 时也写入新随机值
5. job 非 succeeded（failed/pending）→ 400
6. 模板无 seed 参数 → 409 且未插入 job
7. batch/job 不存在、job 不属于该 batch → 404

web 按惯例不写渲染测试，手动验收清单（放 PR 描述）：

1. 画廊卡片 hover 出现重roll 按钮，点击不打开 Lightbox，追加提示出现
2. Lightbox 内重roll 可用
3. 追加后进度条分母+1，新任务执行，新图自动出现在画廊尾部
4. completed batch 重roll 后状态回 running，全部完成后回 completed
5. 无 seed 参数的模板：两处按钮禁用带提示
6. 连点 3 次追加 3 个任务，seed 各不相同（表格/params 里核对）

## 已知取舍

- 随机 seed 用 `Math.random()`（与矩阵「+随机×5」一致），不追求加密强度
- 新 job 无血缘标记，画廊/表格中与普通任务无差别（参数可辨识）
- canceled batch 重roll 会把 batch 复活为 running，但其余 canceled job 保持 canceled 不会被执行（claimNextJob 只认 pending）——语义正确，无额外处理
