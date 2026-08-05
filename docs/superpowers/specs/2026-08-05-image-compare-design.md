# 预览详情「对比原图」设计

日期：2026-08-05
状态：已确认（悬停跟随 / 自实现零依赖 / 默认第一个 image 参数+可切换）

## 背景与目标

图片编辑类工作流（模板含 `type: 'image'` 参数）的产出需要和输入原图对照才能评估效果。目标：在 batch 详情页的 Lightbox（预览详情）中加入对比模式——开启后分割线跟随鼠标左右移动，线左侧显示原图、右侧显示生成图，与 ComfyUI workflow 常见的 image compare 交互一致。

**仅改前端。** 原图的两个来源端点（`/api/uploads/:name`、`/api/comfy/input-image`）均已存在，服务端零改动。

## 触发条件

- 判定当前 job 的可对比输入：对每个 `type === 'image'` 的参数定义，解析实际值 `v = job.params[p.key] ?? p.default`（与执行器取值逻辑一致），`typeof v === 'string' && v !== ''` 的参数进入 `imageParams`（保持模板定义顺序）。原图文件名即该解析值。
- `imageParams.length > 0` 时，Lightbox 底部工具条显示「对比原图」开关按钮；否则不渲染该按钮。
- 对比模式开启状态下翻页（←/→ 或按钮）到 `imageParams.length === 0` 的 job 时，自动退出对比模式。
- 画廊缩略图、job 表格均不改动。

## 对比组件

新建 `apps/web/src/components/image-compare.tsx`，自实现、零新依赖，约 70 行：

```
<ImageCompare
  beforeCandidates={string[]}   // 原图候选 URL，按序回退
  afterSrc={string}             // 生成图 URL
  afterAlt={string}
/>
```

- 生成图为底图：`max-h-[70vh] w-full object-contain`（沿用现有 Lightbox 尺寸）。
- 原图绝对定位叠放，同框同 `object-contain`，`clip-path: inset(0 X% 0 0)` 裁掉右侧 → 分割线左边原图、右边生成图。
- 交互：容器 `onPointerMove` 由指针 X 计算分割百分比（state 驱动，0–100 夹紧）；`onPointerLeave` 回弹 50%。不需要按住，悬停即跟随。
- 分割线：1px 竖线 `bg-primary`，随分割位置移动。
- 左上/右上角落小标签「原图」「生成图」（半透明底、`text-xs`），提示当前两侧内容。
- 尺寸/比例不一致时两图各自 `object-contain` 留白，不做对齐拉伸（像素级对齐仅同尺寸编辑流程有意义，明确不做）。

## 原图双源回退与降级

复用 FileThumb 的分级回退思路，在 ImageCompare 内部实现：

1. `beforeCandidates[0] = uploadFileUrl(name)`（本地 uploads）
2. `onError` 回退 `beforeCandidates[1] = comfyInputFileUrl(name)`（当前 active 主机 input 代理）
3. 全部失败：隐藏叠加层与分割线，生成图正常显示，图下方显示一行提示：
   「原图不可用（可能已被清理或在其他主机）」。
   对比按钮保持可点（进入后即见此提示），不做预检请求。
- 候选列表变化（切换 job / 切换参数）时重置回退阶段。

## 多 image 参数切换

- 默认取 `imageParams[0]`。
- `imageParams.length > 1` 时，对比模式下在图下方显示一组小按钮（显示参数 `label`，当前项高亮）切换对比的原图。
- 翻页切换 job 后重置为新 job 的 `imageParams[0]`。

## Lightbox 改造

- `Lightbox` 新增 prop：`imageParamDefs: ParamDef[]`（模板中 `type === 'image'` 的参数定义；父组件已有 `template`，传入筛选结果）。
- 组件内状态：`compare: boolean`、`compareKey: string | null`。
- 「对比原图」按钮置于 footer 左侧按钮组（与 ←/→ 同排），开启态用 `variant="secondary"` 区分。
- 开启时用 `<ImageCompare>` 替换现有 `<img>`；关闭或无可对比输入时保持现状。

## 测试

- 参数筛选纯函数 `imageParamsOf(defs: ParamDef[], values: ParamValues): ParamDef[]` 放 `apps/web/src/lib/image-params.ts`，Vitest 单测覆盖：无 image 参数 / 值为空串 / 值缺失但有 default / 多个 image 参数保序。
- 组件交互按项目惯例不写渲染测试，PR 描述附手动验收清单（开关显隐、悬停跟随、双源回退、404 降级、多图切换、翻页重置、明暗主题下分割线与标签可见性）。

## 明确不做

- 服务端任何改动（含按 job 记录「当时跑在哪台主机」以精确回源——现状双源回退已覆盖主要场景）。
- 拖动滑杆 / 点击锁定交互（选定悬停跟随）。
- 两图像素级对齐、缩放同步、放大镜。
- 画廊缩略图上的对比入口。
- 引入 react-compare-slider 等新依赖。
