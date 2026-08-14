# 手机版 UI/UX 设计

日期：2026-08-13
状态：已确认（监控+看图优先 / 底部 Tab 栏 / Batches 卡片化 / 触屏按住拖动对比 / PWA 轻量外壳）

## 背景与目标

手机场景以**监控与看图**为主：看批次进度、浏览结果画廊、Lightbox 预览/对比原图、重跑/取消。创建批次、导入模板等复杂表单在桌面完成，手机端只保证「能用不坏」（无横向溢出、控件可点）。

**仅改前端。** 服务端零改动。

## 总体技术路线

同一套代码 + Tailwind 响应式断点，以 `md`（768px）为分界：`<md` 手机布局，`≥md` 完全保持现状（桌面端零视觉改动）。不做独立移动路由、不做 UA 判断、不引入新依赖，现有 shadcn 组件全部沿用。

需要 JS 感知断点的地方（列表卡片/表格双形态）新增 `useMediaQuery(query: string): boolean` hook（`apps/web/src/hooks/use-media-query.ts`，约 15 行）：`matchMedia` + `change` 事件订阅，避免 CSS 双渲染两份 DOM。

## App 外壳：底部 Tab 栏

- `≥md`：现有顶栏导航原样保留。
- `<md`：
  - 顶栏精简为一行：App 图标 + `HostStatus` + 主题按钮（`NavLink` 链接组隐藏）。验收修订：原「文字标题+truncate」方案在 390/393px 机型间因几 px 之差导致主机名折行不一致，改为小屏只显 `icon.svg` 图标（桌面仍为文字标题），同时补充 favicon（svg + png 192）。
  - 验收修订（batch-detail 页头）：小屏改为固定分行（导航 / 名称+状态 / 模板 / 操作各一行），不再用 flex-wrap 自适应——断行点随名字长短漂移导致机型间不一致。
  - 验收修订（batch-new）：模板/Batch 名称表单行小屏全宽堆叠（`w-full md:w-64` + flex-wrap），原固定 `w-64` 并排在 375px 溢出右边界。
  - 新增 `apps/web/src/components/mobile-tab-bar.tsx`：`fixed bottom-0 inset-x-0` 四个入口 **Batches / Templates / Prompt 库 / 更多**，lucide 图标 + `text-xs` 文字，active 态 `text-primary`（`NavLink` 判定）。「更多」用现有 DropdownMenu 向上弹出（`side="top"`），收纳 数据备份 / GPU 主机 / 维护，三项中任一 active 时「更多」入口高亮。
  - Tab 栏 `padding-bottom: env(safe-area-inset-bottom)` 避开 iPhone Home Indicator；背景 `bg-background` + 顶部 border，明暗主题下均不透底。
  - 内容区 `<md` 加 `pb-20` 防止被 Tab 栏遮挡；根容器 `p-6` → `p-4 md:p-6`。

## Batches 卡片化

`DataTable`（`apps/web/src/components/data-table/data-table.tsx`）新增可选 prop：

```
renderCard?: (row: Row<TData>) => ReactNode
```

- 传入且 `useMediaQuery('(max-width: 767px)')` 为真时，表格主体替换为卡片列表（`space-y-2`），卡片仍从同一 TanStack Table 实例 `getRowModel()` 渲染——搜索/筛选/排序/批量选择状态与工具栏、批量操作栏原样复用，逻辑零重写。
- 未传 `renderCard` 或桌面断点时渲染现有 `<Table>`。

Batches 卡片内容（`batches.tsx` 内实现 renderCard）：

- 第一行：Checkbox（复用行选择状态）+ 名称（粗体）+ `StatusBadge`；
- 第二行：`Progress` 进度条 + `12/30（2 失败）` 文字（失败数 `text-destructive`）；
- 第三行：模板名 + 创建时间（`text-xs text-muted-foreground`）。
- 整卡包 `Link` 进详情；Checkbox 点击 `stopPropagation` 不触发跳转。

其他表格页不传 `renderCard`，走「其余页面兜底」的横滑方案。

## batch-detail：画廊 + Lightbox + 触屏对比

- 画廊网格与失败列表网格：`grid-cols-4` → `grid-cols-2 md:grid-cols-4`。
- Lightbox footer 按钮组 `flex-wrap` 允许换行；图片区 `max-h-[70vh]` 保留。
- **触屏对比**（`image-compare.tsx` 内改造，桌面行为不变）：
  - 交互容器加 `touch-action: none`（仅该容器，页面其余部分滚动不受影响）。
  - 现有 `onPointerMove` 天然支持触摸拖动；差异仅在回弹：`onPointerLeave` 中 `e.pointerType === 'mouse'` 才回弹 50%，触摸松手停留在当前位置（方便端详）。
  - 触屏无 hover 提示，分割线常显（现状已满足）。
- **滑动翻页**：Lightbox 非对比模式下，图片区横向快滑（pointerdown→pointerup X 位移绝对值 > 48px 且横向位移大于纵向）切换上一张/下一张，与 ←/→ 按钮等价；**对比模式开启时禁用**（避免与拖动分割线冲突）。自实现约 20 行，不引入手势库。

## 其余页面兜底（只保证不坏）

- `data-table` 表格容器统一包 `overflow-x-auto`（一处改动惠及所有表格页：模板/主机/维护等）。
- 排查 batch-new / template-import / hosts / maintenance / prompts / backup 中固定多列 `grid-cols-*` 与固定宽度（如 `w-40`），改 `grid-cols-1 md:grid-cols-*` 式响应；目标仅为无横向溢出、控件可点，不重设计矩阵录入交互。
- shadcn Dialog 小屏本身近全宽，不动。

## PWA 轻量外壳

- `apps/web/public/manifest.webmanifest`：`name` / `short_name` / `display: "standalone"` / `start_url: "/"` / 明暗 `theme_color`、`background_color` / 192 与 512 图标。
- 图标：简单 SVG 设计稿生成 `icon-192.png` / `icon-512.png` / `apple-touch-icon.png`（180px），放 `apps/web/public/`。
- `index.html`：viewport 加 `viewport-fit=cover`；`theme-color` meta 明暗两条（`media` 变体）；`<link rel="manifest">` 与 `apple-touch-icon`。
- **不做** Service Worker / 离线缓存（监控要实时数据）。iOS standalone 切回前台的数据刷新由 react-query `refetchOnWindowFocus` + SSE 重连覆盖。

## 测试

- `useMediaQuery` hook Vitest 单测（mock `matchMedia`：初值、change 事件更新、卸载取消订阅）。
- 布局改动按项目惯例不写渲染测试，PR 描述附手动验收清单：DevTools 375px 模拟 + 真机 iOS Safari——Tab 栏切页与 safe-area、「更多」菜单、Batches 卡片的搜索/筛选/批量操作、整卡跳转与 Checkbox 不冲突、触屏对比拖动停留、桌面悬停回弹不回归、滑动翻页（对比模式下禁用）、各页无横向溢出、standalone 安装与明暗主题。

## 明确不做

- 桌面端（`≥md`）任何视觉改动。
- Service Worker / 离线缓存。
- 手势库、动画库等新依赖。
- 矩阵录入（batch-new）的移动端交互重设计——挂账，需要时单独立项。
- 虚拟滚动、列表分页。
- 独立移动路由 / UA 嗅探。
