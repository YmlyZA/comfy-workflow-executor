# UI 视觉与交互微调 设计文档

日期：2026-08-03
状态：已与用户确认方向（克制增强 / indigo 主色 / 三态明暗 / sonner），待 spec 评审

## 背景与目标

当前 web 端是 shadcn 默认中性灰主题（oklch 全消色），无暗色主题，无 motion 库（`tw-animate-css` 已装），操作反馈全部是页面内就地文字。目标：在**不引入 motion 运行时、不改信息架构**的前提下，统一设计 tokens、补全自动明暗主题、打磨高频交互反馈，让工具"更有质感"而非"更花哨"。

## 决策记录

| 决策点 | 结论 |
|---|---|
| 投入路线 | 克制增强：动效以 CSS/tw-animate-css 为主，不引 motion/framer-motion |
| 主色 | indigo 靛蓝（亮色 primary≈indigo-600，暗色≈indigo-500） |
| 明暗切换 | 三态：light / dark / system（默认 system），存 localStorage，Header 切换 |
| Toast | 引入 sonner（~7KB）；成功类一次性反馈走 toast，表单/持续性错误保持就地 |
| 范围 | Header/GPU 状态、列表与详情页、表单/新建页、全局反馈，四块全做 |

## 一、设计 tokens（重写 `apps/web/src/index.css`）

暗色采用 `.dark` class 策略（Tailwind v4 `@custom-variant dark (&:is(.dark *))`）。圆角保持 `--radius: 0.625rem`。新增语义色 `--success`/`--warning` 与时长 token，全部映射进 `@theme inline` 供工具类使用（`bg-success`、`duration-fast` 等）。

```css
@import 'tailwindcss';
@import 'tw-animate-css';

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: oklch(0.985 0.002 247.839);
  --foreground: oklch(0.208 0.042 265.755);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.208 0.042 265.755);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.208 0.042 265.755);
  --primary: oklch(0.511 0.262 276.966);          /* indigo-600 */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.968 0.007 247.896);        /* slate-100 */
  --secondary-foreground: oklch(0.208 0.042 265.755);
  --muted: oklch(0.968 0.007 247.896);
  --muted-foreground: oklch(0.554 0.046 257.417); /* slate-500 */
  --accent: oklch(0.962 0.018 272.314);           /* indigo-50:hover 淡主色 */
  --accent-foreground: oklch(0.457 0.24 277.023); /* indigo-700 */
  --destructive: oklch(0.577 0.245 27.325);
  --success: oklch(0.627 0.194 149.214);          /* green-600 */
  --warning: oklch(0.681 0.162 75.834);           /* amber-600 */
  --border: oklch(0.929 0.013 255.508);           /* slate-200 */
  --input: oklch(0.929 0.013 255.508);
  --ring: oklch(0.585 0.233 277.117);             /* indigo-500 */
}

.dark {
  --background: oklch(0.129 0.042 264.695);       /* slate-950 */
  --foreground: oklch(0.968 0.007 247.896);       /* slate-100 */
  --card: oklch(0.208 0.042 265.755);             /* slate-900 */
  --card-foreground: oklch(0.968 0.007 247.896);
  --popover: oklch(0.208 0.042 265.755);
  --popover-foreground: oklch(0.968 0.007 247.896);
  --primary: oklch(0.585 0.233 277.117);          /* indigo-500 */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.279 0.041 260.031);        /* slate-800 */
  --secondary-foreground: oklch(0.968 0.007 247.896);
  --muted: oklch(0.279 0.041 260.031);
  --muted-foreground: oklch(0.704 0.04 256.788);  /* slate-400 */
  --accent: oklch(0.257 0.09 281.288);            /* indigo-950 */
  --accent-foreground: oklch(0.785 0.115 274.713);/* indigo-300 */
  --destructive: oklch(0.704 0.191 22.216);       /* red-400 提亮 */
  --success: oklch(0.723 0.219 149.579);          /* green-500 */
  --warning: oklch(0.769 0.188 70.08);            /* amber-500 */
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.673 0.182 276.935);             /* indigo-400 */
}

@theme inline {
  /* 既有 radius/color 映射保持,新增: */
  --color-success: var(--success);
  --color-warning: var(--warning);
}
```

动画时长不引入自定义 token（Tailwind v4 对自定义 duration 命名空间不生成工具类），改为**全站两档约定**：即时交互（hover/按压/行背景）用内建 `duration-150`，面板/卡片过渡用 `duration-250`；实现时排查现有 `transition-*` 类统一到这两档。

实施时以上值为基准，允许在人工目检时对个别值做 ±0.03 L / ±0.02 C 内微调（微调结果直接改 css，不回写本 spec）。全站排查散落的硬编码色（`text-green-*`、`text-red-*`、`bg-green-*` 等）替换为语义 token。

## 二、三态主题切换

**`apps/web/src/components/theme-provider.tsx`**（新建）：

- `type Theme = 'light' | 'dark' | 'system'`；localStorage key `cwe-theme`；非法/缺失值一律按 `system`。
- `resolveTheme(pref: Theme, systemDark: boolean): 'light' | 'dark'` 抽成**纯函数导出**（连同 `parseTheme(raw: string | null): Theme`），进 `apps/web/src/lib/theme.ts`，配单测。
- Provider 持有 pref 状态，effect 中：向 `document.documentElement` 挂/摘 `dark` class；pref 为 system 时监听 `matchMedia('(prefers-color-scheme: dark)')` change。
- `useTheme(): { theme: Theme; setTheme: (t: Theme) => void }`。

**防闪烁**：`apps/web/index.html` `<head>` 加内联脚本（渲染前执行）：

```html
<script>
  (function () {
    var t = localStorage.getItem('cwe-theme')
    var dark = t === 'dark' || ((t !== 'light') && matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.documentElement.classList.add('dark')
  })()
</script>
```

**Header 切换按钮**：导航右侧（HostStatus 左边）一个 ghost 图标按钮，DropdownMenu 三选项「浅色 / 深色 / 跟随系统」，当前项打勾；图标随生效主题显示 Sun/Moon（system 态显示 Monitor 图标）。

## 三、Header / GPU 状态

- **HoverCard 详情卡**：新增 shadcn `hover-card.tsx`（radix-ui 包已含 HoverCard）。HostStatus 的指示灯+主机名整块作为 trigger：hover（openDelay 200ms）弹出详情卡，内容 = 现 `/hosts` 详情卡精简版：GPU 型号、显存占用条（used/total，Progress 复用）、ComfyUI 版本、队列 running/pending、cwe 状态。数据用 react-query `['host-stats']` 拉 `GET /api/hosts/current/stats`，`staleTime: 30_000`，仅卡片打开时启用（`enabled: open`）。离线时卡片只显示「离线」与主机 URL。
- **点击**：整块 trigger 点击 → `navigate('/hosts')`（触屏无 hover 时自然降级为直接进管理页）。
- **指示灯动效**：离线红灯加 CSS 呼吸（`animate-pulse`）；从离线翻转为在线的一瞬，绿灯外圈 ping 一次（监听 `['comfy-status']` 数据 online 由 false→true 时挂一次性 ping 元素，600ms 后移除）。
- **导航高亮**：`NavLink` 当前路由主色文字 + 底部 2px 短横线（`aria-current` 驱动样式）；非当前项 `muted-foreground`，hover 过渡 `duration-fast`。

## 四、列表页与详情页

- **状态 Badge 统一**：`statusVariant` 映射改为语义 token（新增 Badge variant `success`/`warning`）：
  | 状态 | 样式 |
  |---|---|
  | pending | secondary 灰 |
  | running | 主色底/主色字 + 前置脉冲圆点（CSS animate-pulse） |
  | succeeded / completed | success 绿 |
  | failed | destructive |
  | canceled | outline 描边灰 |
  batches 列表与 batch 详情 jobs 表共用同一映射（现状已共用 `statusVariant`，只改实现）。
- **表格**：行 hover 背景 `transition-colors duration-fast`；表头字重/颜色统一 `muted-foreground`。
- **画廊卡片**（batch 详情 + 维护页 GPU 孤儿网格）：hover 时 `shadow-md` 浮起 + 缩略图轻微 scale(1.02)，`duration-normal`；`<img>` 加载完成淡入（`onLoad` 切 opacity，初始 0）。
- **Lightbox**：Dialog overlay 加 `backdrop-blur-sm`。
- **进度条**：Progress 指示色用 `--primary`（当前默认即 primary，确认暗色下对比度）。

## 五、表单 / 新建 batch 页

纯一致性打磨，不动交互逻辑：

- 各配置区块统一卡片外观：`rounded-lg border bg-card p-4`（现状 `rounded-md`/`p-4` 混用、部分无卡片）。
- 控件高度统一：表格内联控件 `h-8`，独立表单控件 `h-9`，全页排查混用。
- Label 统一 `text-sm font-medium`；分组标题统一 `text-sm font-medium text-muted-foreground`。
- 聚焦 ring 自动随 `--ring` 变主色，无需逐控件改。

## 六、全局反馈

- **sonner**：新依赖 `sonner`；`<Toaster richColors position="bottom-right" theme={resolved} />` 挂 App 根（theme 取自 ThemeProvider 生效值）。
- **迁移准则**：一次性操作的**成功**结果 → `toast.success`；**表单校验/需持续可见的错误**（含离线横幅）→ 保持就地；列表页一次性操作的错误 → `toast.error`。
- **迁移点清单**（成功反馈改 toast，原就地 state 同步删除）：
  - batches 列表：批量删除/取消结果（含 gpuMissing/purgeFailed 等附注文案并入 toast description）
  - batch 详情：重roll「已追加 #N」、取消/重试 409 提示（409 属一次性操作错误 → `toast.error`）
  - 维护页：本地清理「已释放 X」、GPU 删除「已删除 N 个…」（`result`/`msg` 就地状态删除；扫描错误 scanErr 保持就地）
  - hosts 页：连通测试结果保持就地（在卡片内展示数据，非一次性通知）；激活/删除成功 → toast
  - prompts / templates / backup 页同准则逐一排查
- **Skeleton**：新增 shadcn `skeleton.tsx`；batches 与 templates 列表首屏 `isPending` 时表格骨架（表头 + 5 行灰条）；batch 详情画廊骨架（4×2 方块）。替换现「加载中……」文字。
- **弹层动画时长**：dialog/dropdown/select 等 tw-animate-css 类统一到 `duration-normal`。

## 七、明确不做

- 不引 motion/framer-motion 运行时；不上 Magic UI / Aceternity 装饰特效
- 不做页面级路由转场动画
- 不换字体、不改布局结构与信息架构
- 不迁移组件库（Ant/Mantine 不考虑）
- 新依赖仅 `sonner`；新 shadcn 组件仅 `hover-card.tsx`、`skeleton.tsx`

## 错误处理与边界

- localStorage 不可用（隐私模式）：try/catch 包裹读写，回退 system、不持久化。
- `cwe-theme` 存了非法值：`parseTheme` 回退 `system`。
- hover 卡片 stats 请求失败：卡片内显示「离线/不可达」，不弹错误。
- 触屏设备：HoverCard 不可用时点击直达 `/hosts`，无功能损失。

## 测试与验收

- **单测**：`lib/theme.ts` 的 `parseTheme`/`resolveTheme`（非法值、三态×系统明暗组合）。
- **typecheck + build** 全绿；web 按惯例不做渲染测试。
- **手动验收**（进 PR 描述）：
  1. 三态切换即时生效且刷新不闪白/闪黑；system 态跟随系统切换实时变
  2. 暗色下逐页过：batches / 详情+Lightbox / 新建 batch 三 tab / templates / prompts / hosts / 维护 / 备份，无白底残留、无不可读文字
  3. Header 指示灯 hover 出详情卡（GPU/显存/队列/cwe），点击进 /hosts；离线红灯呼吸、恢复绿灯 ping
  4. 状态 Badge 明暗两套下颜色语义正确，running 有脉冲点
  5. 删除/清理/重roll 等成功反馈以 toast 出现并自动消失，错误场景仍就地可见
  6. 列表首屏骨架屏出现后平滑替换为数据
  7. 画廊 hover 浮起、图片淡入、Lightbox 背景毛玻璃

## 文件清单

- 新建：`apps/web/src/components/theme-provider.tsx`、`apps/web/src/lib/theme.ts`（+测试 `apps/web/src/lib/theme.test.ts`）、`apps/web/src/components/ui/hover-card.tsx`、`apps/web/src/components/ui/skeleton.tsx`
- 重写：`apps/web/src/index.css`
- 修改：`apps/web/index.html`（防闪烁脚本）、`App.tsx`（Provider/Toaster/主题按钮/导航高亮）、`host-status.tsx`（HoverCard/动效）、`badge.tsx`（success/warning variant）、`batches.tsx`、`batch-detail.tsx`、`maintenance.tsx`、`hosts.tsx`、`prompts.tsx`、`templates.tsx`、`backup.tsx`、新建 batch 相关组件（表单一致化 + toast 迁移 + 骨架屏 + 硬编码色清理）
- 依赖：`sonner`（apps/web）
