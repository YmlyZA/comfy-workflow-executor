# 图片选择器 v2 设计（七期规划 ④）

日期：2026-07-26
状态：已与用户确认（形态=统一弹窗；分页=客户端；交互=点选+拖拽框选）

## 背景与问题

当前 image 参数有两个选择入口：

- **多选** `ImageMultiPick`（矩阵 image 轴、批量图片 tab）：内嵌 checkbox 列表 + 32px 缩略图
- **单选** `ImageValueControl`（表格 tab 行内）：下拉菜单 + 缩略图

两处的缩略图 `src` 直接指向原图端点（`/api/uploads/:name`、`/api/comfy/input-image`），**每个缩略图都下载完整原图**——图多时传输量巨大，这是性能瓶颈。交互上，列表式勾选在图片多时难浏览、无法批量选取，两处体验也不一致。

## 目标

1. 服务端缩略图端点（sharp），缩略图只传缩小后的字节
2. 统一弹窗选择器：Tab 双来源 + 缩略图网格 + 文件名过滤 + 客户端分页 + 点选/框选
3. 多选、单选两入口共用同一弹窗组件，体验一致

非目标：列表端点分页（几百个文件名仅几十 KB，不是瓶颈）；outputs 作为图片来源；移动端触屏框选。

## 设计

### 1. 服务端缩略图端点

`GET /api/thumbs?source=uploads|comfy&name=<文件名>`

- 新依赖 **sharp**（@cwe/server）。sharp ≥0.33 通过 `@img/sharp-*` optional deps 分发预编译二进制，无 postinstall 构建脚本，**不需要改 pnpm-workspace.yaml allowBuilds**（安装后需实际验证）
- 输出：**192px 最长边**（`fit: 'inside'`，`withoutEnlargement: true`）、**webp** 格式。网格 96px 格子 ×2 DPR 足够
- 数据来源：
  - `source=uploads`：读 `dataDir/uploads/<name>`
  - `source=comfy`：经现有 comfy client 拉 GPU 侧 input 图（与 `/api/comfy/input-image` 同一底层）
- **磁盘缓存**：`dataDir/thumbs/<source>/<name>.webp`
  - uploads 文件名是内容寻址（sha256 前 16 hex 前缀），内容不可变 → 缓存命中即直接回吐，永久有效
  - comfy 文件按名缓存，接受「同名换内容」的陈旧（我们自己的上传链路用 hash 命名，同名覆盖场景极少）
  - 响应头 `Cache-Control: max-age=86400`（两种 source 都加）
- 名称校验按 source 区分（与现有端点对齐）：
  - `uploads`：仅裸文件名（含 `..` 或路径分隔符 → 400，与 `/api/uploads/:name` 一致）
  - `comfy`：允许子目录相对名（LoadImage COMBO 会列 `subdir/file.png`），禁 `..` 与绝对路径（与 image-dims 守卫一致）
  - 缓存落盘路径对 name 做安全编码（如替换路径分隔符或取 hash 作 key），并加 thumbs 根目录前缀守卫，防止借 name 写出目录外
- 错误语义：
  - 名称校验不过 / source 非法 → 400
  - GPU 离线（source=comfy 拉不到）→ 503
  - 源文件不存在 → 404
  - sharp 解码失败（非图片文件）→ 415
- 现有原图端点 `/api/uploads/:name`、`/api/comfy/input-image` **保留**（回退与后续 Lightbox 用）

### 2. 前端 `FileThumb` 回退链

`FileThumb` 改为优先请求缩略图端点；缩略图请求失败（onError）时**回退请求对应原图 URL 一次**；原图也失败才隐藏（保位占位，不破版式，沿用现状）。

### 3. 统一弹窗 `ImagePickerDialog`（新组件）

```
ImagePickerDialog({
  mode: 'single' | 'multi',
  open, onOpenChange,
  value: string[],            // multi=已选列表；single=[当前值] 或 []
  onConfirm: (next: string[]) => void,   // single 模式点击即 onConfirm([name]) 并关闭
})
```

- **Tab 双来源**：「服务端已上传」（useUploadFiles）/「GPU 主机已有」（useComfyInputFiles）。GPU 拉取失败时 tab **禁用并提示**（不再整组消失）
- **网格**：96px 缩略图卡片，底部一行截断文件名（title 全名）；选中态高亮描边 + 角标勾
- **工具栏**：文件名过滤输入框（子串匹配、实时生效）+「上传本机图片」按钮（上传到服务端、成功自动选中、自动切到服务端 tab；multi 追加选中，single 直接确认）
- **客户端分页**：每页 60，底部页码控件；过滤后重新分页并回到第 1 页
- **multi 交互**：
  - 点击卡片：切换选中
  - **拖拽框选**：mousedown 落在网格容器空白处（非卡片）启动，pointermove 渲染半透明矩形覆盖层，pointerup 时用各卡片 `getBoundingClientRect()` 与矩形求交，交到的**批量加选**（不取消已选）；拖拽过程中不高频 setState，只在 up 时提交一次
  - 底部操作条：「已选 N 张」计数 + 清空 + 确定 + 取消；**确定才调 onConfirm**，取消丢弃弹窗内改动
- **single 交互**：点击卡片即 `onConfirm([name])` 并关闭；无底部操作条
- **孤儿值**（已选但两个列表都不含，如 GPU 离线后）：底部已选条以 chip 形式显示、可单个移除——沿用 ImageMultiPick 孤儿组思路，保证任何已选值都能被取消

### 4. 两个入口改造

- **`ImageMultiPick`** 瘦身：内嵌 checkbox 列表、内联上传按钮删除；改为「已选缩略图 chip 行（每个带 × 移除）+『选择图片…』按钮」唤起 multi 弹窗。对外 props（`value: string[]`, `onChange`）不变，矩阵轴与批量图片 tab 无需改动
- **`ImageValueControl`**：保留手填 `Input`（CSV/手写 GPU 路径场景不变）；下拉菜单 + 内联上传按钮替换为一个图标按钮唤起 single 弹窗。对外 props 不变

### 5. 测试

- **服务端 vitest**（thumbs 端点）：缓存写入与命中（第二次请求不再触 sharp/源读取，可用 fake 计数验证）、`..` 穿越与非法 source 400、非图片 415、GPU 离线 503、不存在 404、webp Content-Type
- **web 按项目惯例不写渲染测试**，手动验收清单（放 PR 描述）：
  1. 双 tab 切换、GPU 离线时 tab 禁用带提示
  2. 文件名过滤 + 分页（>60 张时翻页）
  3. multi：点选切换、空白处拖拽框选批量加选、清空/确定/取消语义
  4. single（表格行内）：点击即选中关闭；手填 Input 不受影响
  5. 弹窗内上传自动选中并切 tab
  6. 孤儿 chip 显示与移除（GPU 断开后）
  7. 缩略图明显变快（网络面板确认走 /api/thumbs webp），非图片文件回退→隐藏不破版式

## 已知取舍

- comfy 缩略图按名缓存：同名换内容会看到旧缩略图（低概率，接受；必要时手动清 `dataDir/thumbs`）
- 框选只做鼠标（pointer）交互，不做触屏
- 列表端点不分页：文件名总量在几十 KB 量级，客户端过滤/分页足够
