# 输入历史 设计（七期规划 ⑤）

日期：2026-07-27
状态：已与用户确认（覆盖=表格行+矩阵共享区，仅 text 型；键=按参数 key 全局共享）

## 背景

text 型参数（prompt 类）常在多个批次间复用相近的值，目前每次都要重新输入或去旧 batch 复制。需要自动记录历史并在输入框旁一键回填。

立项已定方向：服务端存储，上限走 .env 配置。

## 目标

1. 建批时**服务端自动记录** text 参数值（前端零参与），按参数 key 全局共享（同名 key 跨模板共享）
2. 输入框旁历史下拉：回填、单条删除
3. 每个 key 的历史条数上限走 `INPUT_HISTORY_LIMIT` 环境变量（默认 100），超限按最近使用修剪

非目标：number/seed/enum/image 参数；矩阵 text 轴值列表与 CSV（列表类交互不同，留给 ⑥ Prompt 库）；历史的导入导出；按模板隔离。

## 设计

### 存储

`apps/server/src/db/index.ts` 的 DDL 追加：

```sql
CREATE TABLE IF NOT EXISTS input_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  param_key TEXT NOT NULL,
  value TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT NOT NULL,
  UNIQUE(param_key, value)
);
CREATE INDEX IF NOT EXISTS idx_input_history_key ON input_history(param_key, last_used_at);
```

无既有数据迁移（新表）。drizzle schema 同步加 `inputHistory` 表定义。

### 配置

`Config` 加 `inputHistoryLimit: number`，`loadConfig` 读 `INPUT_HISTORY_LIMIT`，默认 100；非法/非正数回退 100。

### 记录（repo.recordInputHistory）

`POST /api/batches` 建批成功后调用：

- 输入：模板 params 中 `type === 'text'` 的 key 集合 + 提交的 `jobs: ParamValues[]`
- 对每个 (key, value)：value 非 string 或 `value.trim() === ''` 跳过；值**原样存**（不 trim 存储，只用 trim 判空）
- 同批内相同 (key, value) 只记一次（去重后 upsert）
- upsert：`INSERT ... ON CONFLICT(param_key, value) DO UPDATE SET use_count = use_count + 1, last_used_at = <now>`
- 随后按 key 修剪：保留 `last_used_at` 降序前 `inputHistoryLimit` 条，其余删除
- 整个记录过程 try/catch 包裹：失败 `console.error`，**不影响建批响应**
- 重roll（PR #14 端点）不记录——其值复制自历史 job，建批时已入库

### API（新路由文件 input-history.ts，挂 /api/input-history）

- `GET /api/input-history?key=<paramKey>` → 200 `{ values: string[] }`，按 `last_used_at` 降序，最多 `inputHistoryLimit` 条；缺 key → 400 `{ error: '缺少 key 参数' }`
- `DELETE /api/input-history?key=<paramKey>&value=<value>` → 200 `{ ok: true }`（不存在也返回 ok，幂等）；缺 key 或 value → 400

### 前端：TextValueControl（新组件）

`TextValueControl({ paramKey, value, onChange, placeholder })`：

- `Input`（h-8，与现有行内控件一致）+ 右侧 History/时钟图标小按钮（h-8 px-2 outline，与 ImageValueControl 的按钮样式对齐）
- 点按钮开 `DropdownMenu`：打开时才查询 `GET /input-history?key=...`（`queryKey: ['input-history', paramKey]`，`staleTime: 30_000`，`enabled: open`）
- 每项：截断显示历史值（`max-w-72 truncate`，title 全文），点击 `onChange(value)` 回填并关闭
- 行尾 × 小按钮：`stopPropagation`，DELETE 该条后 invalidate `['input-history', paramKey]`
- 历史为空显示禁用项「（无历史）」
- 接入两处，**对外行为不变**：
  - `batch-new.tsx` 表格行：`p.type === 'text'` 分支改用 TextValueControl（number/seed 维持裸 Input）
  - `matrix-entry.tsx` 共享区：text 分支改用 TextValueControl

### 测试

服务端（新 input-history.test.ts）：

1. 建批后 GET 返回记录的 text 值，`last_used_at` 降序（后用的在前）
2. 仅 text 参数入历史（number/seed/image 值不出现）
3. 空串/纯空白值不记录；非 string 值不记录
4. 同批重复值只计一次 use_count；跨批重复 upsert 累加并刷新排序
5. 超过 `INPUT_HISTORY_LIMIT`（测试用小值如 3）按最近使用修剪
6. GET 缺 key → 400；DELETE 删除后 GET 不再返回；DELETE 不存在值幂等 200；DELETE 缺参 → 400
7. 建批响应不受记录影响（正常 201）

web 按惯例不写渲染测试，手动验收清单（放 PR 描述）：

1. 表格行 text 参数出现历史按钮；建一批后再新建，下拉能看到上批的值，点击回填
2. 矩阵共享区 text 参数同样可用
3. 历史按 key 跨模板共享（另一模板同名 key 能看到）
4. 单条 × 删除后立即从下拉消失
5. 无历史时显示「（无历史）」
6. number/seed 输入框无历史按钮（未挂）

## 已知取舍

- 值原样存储（不 trim），同一内容首尾空白不同会成两条——接受，可用 × 清理
- 历史全局共享无鉴权隔离（单用户工具，与其余 API 同一 token 保护）
- 修剪按 `last_used_at`，不考虑 use_count 权重——简单可预期
