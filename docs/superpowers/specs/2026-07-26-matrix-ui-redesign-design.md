# 矩阵组合 UI 重设计 — 设计

日期：2026-07-26
状态：已与用户对齐（三期规划第 ③/3；「共享参数+显式变化轴」方向在 PR ① 立项时确认，值列表卡片/实时派生+软上限/seed 随机快捷三项交互本轮确认）

## 背景与目标

现有矩阵 tab 把模板所有参数一律铺成 2 列 textarea/勾选网格——「所有参数都像轴」，自由高度堆砌、不雅观，长 prompt 还受「一行一个值」限制（值内不能换行）。真实用法是「选 1-3 个参数变化、其余固定」。本期重写为「共享参数 + 显式变化轴」结构，并把生成时机改为与其他两个 tab 一致的实时派生。

已确认决策：

- 轴值编辑器：**值列表卡片**（每值一行可单独编辑/删除，text 用自适应 textarea——长 prompt 可含逗号换行）
- 生成时机：**实时派生 + 软上限**（组合数 > 1000 不生成并提示）
- 随机快捷：**仅 seed 轴**加「＋随机×5」

## 1. 交互结构（重写 MatrixEntry）

### 1.1 共享参数区

默认所有参数在此，单值控件与批量图片 tab 共享区同构：

- enum → `EnumValueSelect`（离线降级文本输入，现状语义）
- image → `ImageValueControl`（单值三来源控件，表格模式在用）
- 其余 → `Input`
- 留空 → 提交时用模板默认（不写入 jobs，现状语义）
- 已提升为轴的参数从共享区消失

### 1.2 变化轴区

初始为空；「+ 添加变化轴」按钮（Select 列出所有未提升参数，全部提升后按钮禁用）。每轴一张卡片：

- 卡片头：`key（type）` + 「移除」按钮；移除 → 参数回到共享区，轴值丢弃
- **text 轴**：值列表——每值一个自适应高度 textarea（`rows={2}`，`field-sizing: content` 或等效）+ 行删除按钮；底部「+ 加一个值」
- **number / seed 轴**：值列表，每值一个窄 `Input`；**seed 轴**卡片额外「＋随机×5」按钮：追加 5 个 `Math.floor(Math.random() * 2 ** 31)` 随机整数
- **enum 轴**：勾选列表（沿用现 EnumAxisPick 的 useInputOptions 勾选核心）；服务器离线/失败降级为值列表手填
- **image 轴**：`ImageMultiPick`（PR ① 共享组件：双来源勾选+上传+缩略图，`value: string[]` 直接对上）

### 1.3 底部状态行

- 实时「共 N 个任务」（N = 有值轴的值数乘积；无有值轴时 N = 0）
- `N > MAX_COMBOS(1000)` → 红字「组合数 N 超过上限 1000，请减少轴值」+ jobs 置空（提交按钮消失）

## 2. 状态与派生

- `shared: ParamValues`；`axes: Record<string, string[]>`（仅被提升参数；值统一存 string）
- jobs 声明式派生（同 ImagesEntry 模式；`onChange` = 父级稳定的 `setJobs`，任一状态变化即重算）：
  1. 轴解析：number/seed 轴值 `Number()` 转换并滤 NaN；text/enum/image 轴 trim 后滤空串
  2. `combos = expandMatrix(解析结果)`（shared 包 `expandMatrix` 不动：空轴自动过滤，全空返回 `[]`）
  3. `jobs = combos.map(combo => ({ ...共享非空值, ...combo }))`；共享非空值 = shared 中 `!== ''` 的项
  4. 组合数超上限或 combos 为空 → `onChange([])`
- 无任何有值轴 → jobs 为 `[]`：矩阵没轴等于没任务，单任务场景走表格 tab（有意语义，不视为缺陷）
- 模板切换由外层 `Tabs key={template.id}` 重挂载兜底（现状机制）

## 3. 代码组织

`batch-new.tsx` 已约 950 行，本次重写移出而非追加：

- 新建 `apps/web/src/components/matrix-entry.tsx`：`MatrixEntry`（默认导出给 batch-new 用）+ 轴卡片 + 各类型值编辑器（文件内部组件，不导出）
- 抽取 `apps/web/src/components/enum-value-select.tsx`：`EnumValueSelect` + `optionsErrorText`（batch-new 的表格/批量图片与 matrix-entry 三处共用，避免页面↔组件环形引用）
- batch-new.tsx 删除旧 `MatrixEntry`、`EnumAxisPick`、`ImageAxisPick`（重写后无消费者）及其独占 import
- `ImageMultiPick`、`ImageValueControl`、`useInputOptions` 等既有共享件原样复用

## 4. 服务端

**零改动**。`expandMatrix` 已有单测覆盖，不动。

## 5. 测试与验收

web 按惯例无渲染测试；手动验收清单：

1. prompt 轴 3 个值（含逗号与换行的长 prompt）× seed 轴「＋随机×5」→ 实时显示「共 15 个任务」，预览组合正确
2. 共享参数修改实时反映到所有已生成组合；留空的共享参数不出现在预览（用模板默认）
3. enum 轴勾选、image 轴双来源勾选（带缩略图）生效；enum 离线降级为手填值列表
4. 移除轴 → 参数回到共享区；再次提升 → 轴值为空重新开始
5. 组合数超 1000 → 红字提示、提交按钮消失；降回上限内恢复
6. 三个 tab 互切不残留状态（现状机制）
7. 全部参数提升为轴后「+ 添加变化轴」禁用

## 6. 边界（本期不做）

- number 轴范围生成器（起-止-步长）
- 轴排序 / 组合预筛选 / 组合去重
- 「＋随机×N」的 N 可配置（固定 5）
