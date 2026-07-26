# Batch 详情增强：复制新建 + 上下翻 + Lightbox — 设计

日期：2026-07-26
状态：已与用户对齐（七期规划第 ②/7；复制范围=全部 jobs 在立项时确认）

## 背景与目标

详情页三个使用痛点：① 想以某个已结束 batch 为起点（模板+实参）再跑一批，只能手动重填；② 相邻 batch 之间跳转必须回列表；③ 画廊点图跳新页面，浏览一个 batch 的所有图很割裂。

已确认决策：

- 复制新建复制**全部 jobs**（成功/失败/取消都带上——目的是完整重现原 batch，提交前可删改）
- 复制统一落**表格 tab**（矩阵展开不可逆）
- prev/next 固定按 id 相邻，UI 用「更早/更新」措辞避免列表倒序歧义
- 重roll 不满意图片是独立的 PR ③，本期不做

## 1. 服务端（仅 prev/next）

- `GET /api/batches/:id` 详情响应加 `nav: { prevId: number | null, nextId: number | null }`
  - `prevId` = 小于当前 id 的最大 id（更早）；`nextId` = 大于当前 id 的最小 id（更新）；不存在为 null
- repo 新函数 `getBatchNav(db, id): { prevId: number | null; nextId: number | null }`（两条单行查询）
- 未知 id 仍 404（现状不变）

## 2. 前端

### 2.1 详情页（batch-detail.tsx）

- 标题栏左侧加两个小按钮：「← 更早」（prevId）与「更新 →」（nextId），对应 id 为 null 时禁用；点击跳 `/batches/<id>`
- 操作区加「以此新建」按钮 → `/batches/new?from=<batchId>`
- **Lightbox**：画廊 `<a>` 改为按钮打开查看器（不再默认新开页）
  - 复用 PR ① 的 `components/ui/dialog.tsx`，大图定制 content 样式
  - 内容：大图（`max-h-[80vh] object-contain`）+ 信息条（`#job.sortOrder · 文件名 · 参数 JSON`）+ 计数「i / N」+「查看原图」链接（`outputUrl` 新开页，保留原能力）
  - 导航：←/→ 键盘与两侧按钮（首尾钳制禁用），Esc 关闭（Dialog 自带）
  - 纯前端，遍历已有 gallery 数组（`succeeded` jobs 的 outputs 平铺），零服务端改动

### 2.2 新建页（batch-new.tsx）

- 读 `?from=<batchId>`：fetch 详情（react-query `['batches', from]`，与详情页共享缓存），一次性预填（ref 守卫，同导入页 `?from=` 模式）：
  - `setTemplateId(String(detail.template.id))`——有 batch 的模板受 FK 保护删不掉，必然存在
  - Batch 名称预填「`{原名} 副本`」（仅当名称为空）
  - `initialRows` = 全部 jobs 的 `params`（按详情返回顺序 = sortOrder）
- `TableEntry` 加 `initialRows?: ParamValues[]` prop：`useState(initialRows ?? [{}])`；不传时行为与现状完全一致
- 预填走表格 tab（Tabs 默认值即 table）；image 参数值为服务端文件名，直接可提交（源文件已删则走执行器现有回退语义，不额外校验）
- `from` 无效（非数字/不存在）→ 错误提示，页面照常手动使用

## 3. 测试与验收

- **server**（vitest）：3 个 batch 时中间者 `nav.prevId/nextId` 正确；最早者 `prevId: null`；最新者 `nextId: null`；单 batch 双 null
- **web**：按惯例无渲染测试；手动验收清单：
  1. 详情页「以此新建」→ 新建页预填模板、名称「原名 副本」、全部 jobs 行（含失败/取消的），删改后提交成功
  2. 含 image 参数的 batch 复制后直接提交可运行
  3. `/batches/new?from=99999` → 错误提示，手动流程不受影响
  4. 详情页「← 更早 / 更新 →」跳转正确，首尾对应禁用
  5. 画廊点图打开 Lightbox：大图、信息条、i/N 计数；←/→ 键盘与按钮导航、首尾钳制；Esc 关闭
  6. Lightbox 内「查看原图」新开页仍可用

## 4. 边界（本期不做）

- 复制到矩阵/批量图片 tab；跨模板复制
- Lightbox 缩放/拖拽/缩略图条
- prev/next 与列表筛选排序联动（固定按 id）
- 手动标记重roll(PR ③)
