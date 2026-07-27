# Prompt 管理库 设计（七期规划 ⑥）

日期：2026-07-27
状态：已与用户确认（扁平点分 key；$key 插入即展开；导入导出；覆盖 text 单值框+矩阵轴值列表；独立管理页）

## 背景

常用 prompt 片段（质量词、人物设定、风格串）散落在输入历史里，无法命名、组织与复用。需要一个可管理的片段库：给片段起 key，输入时用 `$key` 快速展开插入。

立项已定方向：扁平点分 key；$key 插入即展开（不保留引用）；库支持导入导出。

## 目标

1. Prompt 片段 CRUD：key（扁平字符串，点分仅用于展示分组）+ content（多行文本）
2. 输入 `$` 触发补全下拉，选中后把 `$片段` 替换为库内容（纯文本展开）
3. 覆盖两类输入位置：text 单值框（三个 tab 的 TextValueControl）+ 矩阵 text 轴的多行值编辑
4. 库整体导入导出（JSON 文件）

非目标：层级文件夹模型（点分只是展示分组）；`$key` 引用语义（展开后与库脱钩，改库不回溯）；片段内嵌套引用其他 `$key`；CSV 粘贴域支持；使用统计。

## 设计

### 存储

`apps/server/src/db/index.ts` DDL 追加（新表，无迁移）：

```sql
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

drizzle schema 同步加 `prompts` 表定义。

key 规则：trim 后非空、不含空白字符（`$key` 捕获遇空白截止，含空白的 key 永远选不中）；其余字符不限。content 规则：非空（空片段无意义）。

### API（新路由文件 prompts.ts，挂 /api/prompts）

- `GET /` → 200 `{ prompts: [{ id, key, content, updatedAt }] }`，按 key 升序
- `POST /` body `{ key, content }` → 201 返回该行；key 校验失败 → 400；key 已存在 → 409 `{ error: 'key 已存在' }`
- `PUT /:id` body `{ key?, content? }` → 200 返回更新后行；不存在 → 404；改 key 撞已有 → 409
- `DELETE /:id` → 200 `{ ok: true }`（不存在也 ok，幂等）
- `GET /export` → 200 JSON 下载：`{ version: 1, prompts: [{ key, content }] }`，`Content-Disposition: attachment; filename="cwe-prompts-<YYYY-MM-DD>.json"`
- `POST /import` body 同导出格式 → 200 `{ created, updated }`；按 key upsert（同 key 覆盖 content）；格式非法（缺 prompts 数组/条目缺 key 或 content/key 不合规）→ 400，整体不写入

### 前端：Prompt 库管理页（新页面 /prompts）

侧边导航新增「Prompt 库」。页面：

- 按 key 第一个点分段分组展示（无点号的归「未分组」），组内按 key 排序
- 每行：key + content 单行截断预览（title 全文）+ 编辑/删除按钮
- 编辑/新建共用弹窗：key Input + content 多行 Textarea（`field-sizing-content` 自适应，同矩阵轴样式）；409/400 错误就地显示
- 删除有确认（AlertDialog 或二次点击均可，取现有代码风格）
- 页头：「新建」+「导入」（文件选择读 JSON 后 POST /import，完成后提示 created/updated 数）+「导出」（直链下载，带 token query，同现有下载模式）

### 前端：$key 补全展开

新共享组件（如 `prompt-complete.tsx`）封装补全逻辑，包装 Input 与 Textarea 两种形态：

- 触发：光标处输入 `$` 进入捕获态，持续捕获后续非空白字符为过滤片段
- 下拉：锚在输入框下方，列出 key 含片段（大小写不敏感）的条目，显示 key + content 截断预览；片段为空时列全部
- 键盘：↑↓ 移动高亮，Enter 选中，Esc 退出捕获；鼠标点击同 Enter；失焦关闭
- 选中：把 `$` 到光标之间的文本整体替换为该条 content，光标落在插入内容末尾
- 数据：`GET /api/prompts`（`queryKey: ['prompts']`，staleTime 30_000，进入捕获态才 enabled）
- 库为空或无匹配：下拉显示禁用项「（无匹配）」，Enter 不动作

接入两处，对外 props 不变：

1. `TextValueControl` 的 Input（表格行/矩阵共享区/批量图片共享区三处自动获得，与历史下拉并存互不干扰）
2. `matrix-entry.tsx` `ValueList` 的 `multiline` 分支 Textarea（即 text 轴值编辑）；number 轴的 Input 不接

### 测试

服务端（新 prompts.test.ts）：

1. CRUD 全链路：POST→GET 可见→PUT 改 content/改 key→DELETE 幂等
2. POST key 重复 → 409；PUT 改 key 撞已有 → 409
3. key 校验：空串/纯空白/含空格/含制表符 → 400；content 空 → 400
4. export 返回全量且格式 `{ version: 1, prompts: [...] }`
5. import upsert：新 key 创建、旧 key 覆盖 content，返回 `{ created, updated }` 计数正确
6. import 非法格式 → 400 且库不变（含条目 key 不合规的整体拒绝）

web 按惯例不写渲染测试，手动验收清单（放 PR 描述）：

1. Prompt 库页增删改查、点分分组正确
2. 导出 JSON 可下载；导入合法文件提示计数、库更新
3. 表格行 text 输入 `$` 出补全，Enter 展开插入内容
4. 矩阵 text 轴 Textarea 同样可用
5. 与历史下拉并存：同一输入框历史按钮照常工作
6. `$` 后输入空格退出捕获，正常输入不受干扰

## 已知取舍

- 展开即纯文本插入，改库不影响已展开内容——即「插入即展开」的确认语义
- key 全局唯一不分模板——与输入历史同哲学，单用户工具
- import 整体事务：一条非法全部拒绝——宁可让用户改文件，不做部分成功的模糊状态
- 补全下拉用简单子串匹配，不做模糊评分——库规模（几十至几百条）下够用
