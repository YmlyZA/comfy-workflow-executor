# Templates / Batches 列表表格交互增强 — 设计

日期：2026-07-24
状态：已与用户对齐（拖拽范围、批量操作语义、能力清单、技术方案、三节设计均逐项确认）

## 目标

两个列表页（Templates、Batches）从静态展示表升级为支持常规表格操作的数据表：

- 多项选择、全选，以及基于选中项的批量操作
- 名称搜索 + 列过滤（Batches：状态多选、按模板）
- 列排序、客户端分页、列显隐控制
- 拖拽上下移动持久化排序（**仅 Templates**；Batches 保持时间序）
- 尽量使用 shadcn 官方 data-table 模式与其生态组件

## 技术选型（方案 A，已确认）

- **@tanstack/react-table**：shadcn data-table 文档的官方 headless 底座，管理选择/排序/过滤/分页/列显隐状态
- **@dnd-kit/core + @dnd-kit/sortable + @dnd-kit/modifiers**：shadcn 官方拖拽行示例所用库
- 补装 shadcn 组件：`checkbox`、`dropdown-menu`、`alert-dialog`
- 数据全量在客户端（单用户本地工具、数据量百级），排序/过滤/分页均为客户端行为，不加服务端查询参数

## 1. 服务端

### 1.1 Templates 排序持久化

- `templates` 表加列 `sort_order INTEGER NOT NULL DEFAULT 0`；迁移时现有行按 `id` 顺序初始化（保持当前展示顺序）
- `GET /api/templates` 按 `sort_order ASC, id ASC` 返回
- 新增 `PATCH /api/templates/order`，body `{ ids: number[] }`（完整新顺序）：
  - 事务内依次写 `sort_order = index`
  - 含未知 id → 404；ids 数量与现有模板总数不符 → 400（防并发下漏排）
- 创建模板时 `sort_order = max + 1`（排到末尾）

### 1.2 Batch 删除（新端点）

- `DELETE /api/batches/:id`，可选 query `?purgeOutputs=1`
- `running` 状态 → 409 `{ error: 'batch is running' }`（先取消再删）
- 状态检查与 DB 删除在同一事务内，避免"检查时 pending、删除时已被执行器认领转 running"的竞态
- 删除顺序：先删 DB（batch + jobs 级联）；purgeOutputs 时再删磁盘 `outputs/<batchId>/` 目录
- 目录删除失败不回滚 DB：返回 200 + `{ purgeFailed: true }`（记录删除是主语义，孤儿文件可接受，V1 跟进清单已有孤儿清理项）

### 1.3 批量操作策略

不做服务端批量端点。客户端对选中项并发调用单项接口（`Promise.allSettled`），逐项汇报失败。

## 2. 前端

### 2.1 共享基建 `apps/web/src/components/data-table/`

| 文件 | 职责 |
|---|---|
| `data-table.tsx` | 包装 `useReactTable`：行选择（勾选列+表头全选，全选作用于**过滤后的行**）、列排序、全局搜索、列过滤、客户端分页（默认 20/页，可切 50）、列显隐；渲染复用现有 shadcn `Table` |
| `data-table-toolbar.tsx` | 搜索框 + 列过滤下拉 + 列显隐下拉 + 选中计数与批量操作按钮 slot |
| `data-table-pagination.tsx` | 页码 / 每页条数 |
| `sortable-rows.tsx` | dnd-kit 行拖拽包装：行首拖拽手柄列；**列排序、搜索或过滤任一激活时手柄禁用**（tooltip 说明原因）；松手调 `onReorder(ids)` |

`rowSelection` 以实体 id 为 key（`getRowId`），不用行索引——SSE 刷新/重新拉取后选中不丢。

### 2.2 Templates 页

- 列：拖拽手柄 / 勾选 / 名称(可排序) / 参数 badges / 创建时间(可排序) / 行操作(新建 Batch、删除)
- 批量删除：alert-dialog 确认；逐项 DELETE；409（有 batch）项跳过，结果汇总列出未删项及原因
- 拖拽：乐观更新顺序 → `PATCH /order`；失败回滚 + 错误横幅

### 2.3 Batches 页

- 列：勾选 / 名称(链接,可排序) / 模板(可过滤) / 状态(Badge,多选过滤) / 进度 / 创建时间(可排序)
- 批量操作按选中项状态启用：
  - **取消**：pending/running 项生效
  - **重试失败**：有 failed job 的项生效
  - **删除**：alert-dialog 确认，含"同时删除输出文件"勾选项（**默认不勾**——默认只删记录，保留结果画廊文件；勾选则带 `purgeOutputs=1`）；running 项 409 跳过并列出"先取消再删"
- SSE 事件刷新列表时保留选中与过滤状态

### 2.4 批量结果反馈

`Promise.allSettled` 汇总为一条横幅："成功 N 个，失败 M 个"，失败项逐条列原因；部分失败不中断其余项。

## 3. 错误处理

| 场景 | 行为 |
|---|---|
| 拖拽 PATCH /order 失败 | 回滚拖拽前顺序 + 错误横幅 |
| PATCH /order ids 不完整 / 含未知 id | 400 / 404；前端提示后 invalidateQueries 重拉 |
| 批删模板遇 409（有 batch） | 该项跳过，汇总列出 |
| 批删 batch 遇 running | 409 跳过，汇总提示"先取消再删" |
| purgeOutputs 磁盘清理失败 | 200 + `purgeFailed: true`；前端提示"记录已删，输出目录清理失败" |
| 批量操作部分失败 | allSettled 汇总，不中断其余 |

## 4. 测试策略

**服务端**（vitest，延续现有风格）：
- repo：sort_order 迁移初始化、排序读取、新建排末尾
- 路由：PATCH /order 正常 / 缺 id 400 / 未知 id 404；DELETE batch running 409 / 正常删 / purgeOutputs 真删目录 / purge 失败 200+标记

**web**（纯逻辑测试，不引入组件渲染测试基建）：
- 批量结果汇总函数（allSettled 结果 → 汇总文案）
- 选中项可用操作判定函数（状态集合 → 取消/重试/删除按钮启停）

**手动验收清单**：
- 拖拽持久化，刷新后顺序保持
- 列排序/搜索/过滤任一激活时拖拽手柄禁用
- SSE 刷新（batch 运行中状态变化）不丢选中、不丢过滤
- 批删混合选择（含 running）：running 跳过其余删除，汇总正确
- purge 勾选后磁盘目录确实清理

## 5. 边界（本期不做）

- 无服务端分页/查询参数（数据量不需要）
- 无 DataTable 组件渲染测试（testing-library + jsdom 基建成本超出收益）
- Batches 不做拖拽排序（保持时间序）
- 无列宽拖拽调整、行展开
