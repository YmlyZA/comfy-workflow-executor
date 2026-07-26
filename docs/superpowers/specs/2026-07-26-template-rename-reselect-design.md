# 模板改名 + 从模板重选参数 — 设计

日期：2026-07-26
状态：已与用户对齐（七期规划第 ①/7；「从模板重选参数」方案替代「导入 JSON 文件记录」在立项时确认）

## 背景与目标

两个痛点：① 模板名称创建后无法修改；② 同一份 workflow JSON 想选不同参数组合做成多个模板时，必须重新找到原始文件走完整导入流程。由于模板本身存有完整 `comfyJson`（未删减），第二个需求不需要「导入文件记录」这个新实体——直接支持「从已有模板带入 JSON 重新圈选参数、另存新模板」即可等价覆盖。

已确认决策：

- 改名只改 `name`，不动 id / params / comfyJson（参数定义不可改是既有约束；历史 batch 的 templateId 关联不受影响）
- 重选参数**只支持另存新模板**，不支持覆盖回原模板
- 不做「导入 JSON 文件记录」实体

## 1. 服务端

- `PATCH /api/templates/:id`，body `{ name: string }`（zod：`name` 非空字符串）；模板不存在 → 404；成功返回更新后的模板行
- `repo.renameTemplate(db, id, name)`：更新 name，返回是否命中
- 重选参数**零新端点**：`GET /api/templates` 列表已返回完整 `comfyJson` 与 `params`

## 2. 前端

### 2.1 templates 列表（templates.tsx）

行操作新增两项（沿用现有行操作的展示形态）：

- **重命名**：Dialog + Input（预填当前名），保存调 PATCH，成功后失效 `['templates']` 缓存并关闭；空名禁用保存
- **重选参数**：跳转 `/templates/new?from=<id>`

### 2.2 导入页（template-import.tsx）

- 挂载时读 `?from=`：从模板列表数据中取该模板 → 复用现有 `ingest(comfyJson, ...)` 流程（comfyJson 为 API 格式，`detectFormat` 直接命中；在线校验/枚举标注照常执行）
- **预选来源改为源模板的 `params`**（key/type/enumRef 原样带入），替代 `suggestParams` 智能预选；折叠逻辑按预选结果照常计算
- 源模板 params 中的 `enumRef` 合并进 `enumRefs`——ComfyUI 离线时 enum 类型选项不丢
- 名称预填 `{原名} 副本`（仅当名称输入框为空时）
- `from` 无效（非数字/模板不存在）→ 错误提示，页面照常可手动导入
- 保存仍走 `POST /templates` 另存新模板，原模板不动

## 3. 测试与验收

- **server**（vitest）：PATCH 改名成功（返回新名、列表可见）/ 不存在 id → 404 / 空名 → 400
- **web**：按惯例无渲染测试；手动验收清单：
  1. 列表重命名生效，关联 batch 的模板显示同步变化，batch 数据不受影响
  2. 「重选参数」进入导入页：参数预选 = 源模板参数（key/type 一致）、名称预填「原名 副本」
  3. 改动圈选后另存 → 新模板入列表，原模板参数无变化
  4. ComfyUI 离线时重选：enum 参数类型与 enumRef 保留
  5. 手动导入流程（文件/PNG/粘贴）不受 `?from=` 改动影响

## 4. 边界（本期不做）

- 修改已有模板的参数定义（key/type/默认值）
- 重选参数覆盖保存回原模板
- 导入 JSON 文件历史记录
