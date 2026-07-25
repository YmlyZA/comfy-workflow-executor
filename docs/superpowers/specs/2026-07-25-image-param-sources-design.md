# image 参数多来源支持 — 设计

日期：2026-07-25
状态：已与用户对齐（范围三项全选、存在性回退语义、三节设计均确认）

## 背景与问题

image 类型参数的值是文件名，当前语义：执行器从**服务端 `data/uploads/` 目录**读取该文件并上传到 ComfyUI。由此产生两个缺口：

1. 表格/CSV/矩阵录入模式下 image 参数只是文本框，没有本机上传入口（只有「批量图片」tab 能上传）
2. GPU 主机 input 目录已有的文件无法引用——执行器总是尝试本地读取，不存在即 ENOENT 失败

## 目标（三项，已确认）

1. 表格/矩阵内联上传：image 参数单元格/轴渲染为上传控件
2. 已上传文件选择器：服务端列出 uploads 目录供选择
3. 支持 GPU 主机已有文件：可选择/手填 GPU 侧 input 目录文件名

## 1. 服务端与执行器

### 1.1 执行器存在性回退（已裁决语义）

`apps/server/src/executor.ts` 的 image 分支改为：

- 值非空时，若值不含 `..` 且非绝对路径，检查 `join(dataDir, 'uploads', v)` 是否存在：
  - 存在 → 照旧 `comfy.uploadImage(...)` 并用返回名替换
  - 不存在 → **值原样保留注入 prompt**（引用 GPU 侧 input 已有文件，兼容 ComfyUI `subfolder/name.png` 子目录写法）
- 值含 `..` 或为绝对路径 → 跳过本地检查直接原样传（防路径穿越；此类值在 ComfyUI 侧自然失败）
- 打错文件名的失败方式：job 在 ComfyUI 执行时报错（错误信息来自 ComfyUI）——已确认可接受

### 1.2 GET /api/uploads（新）

- 返回 `{ files: string[] }`：`data/uploads/` 下的文件名，按修改时间倒序（最近上传在前）
- 目录不存在或为空 → `{ files: [] }`
- 只列普通文件（跳过子目录）

### 1.3 GET /api/comfy/input-files（新）

- 从 ObjectInfoCache 取 `LoadImage.image` 的 COMBO 选项（即 GPU 主机 input 目录文件清单），返回 `{ files: string[] }`
- ComfyUI 离线/未配置 → 503 `{ error: 'ComfyUI 离线,无法获取输入文件列表' }`
- object_info 中无 LoadImage 或其 image 非数组 → `{ files: [] }`
- 说明：PR #3 已把 image_upload 型 COMBO 从 enum 语义中排除（enumOptions 返回 null），本端点是专门通道，不改变 enum 判定

## 2. 前端

### 2.1 ImageValueControl（表格单元格）

`apps/web/src/components/image-value-control.tsx`，props `{ value: string; onChange: (v: string) => void; placeholder?: string }`：

- 文本框：仍可手填（受控）
- 下拉选择（DropdownMenu）：两组来源，组标题「服务端已上传」（GET /api/uploads）与「GPU 主机已有」（GET /api/comfy/input-files）；点击项填入值
- 上传按钮：隐藏 file input（accept="image/*"），选择后 POST /api/uploads（复用现有多文件端点，单文件），成功自动填入存储名并 invalidate uploads 列表
- ComfyUI 离线：GPU 组隐藏（input-files 请求失败即不渲染该组），其余功能不受影响
- batch-new.tsx TableEntry 单元格：`p.type === 'image'` → ImageValueControl（优先级在 enum 判断之前不冲突——image 与 enum 类型互斥）

### 2.2 ImageAxisPick（矩阵轴）

`apps/web/src/pages/batch-new.tsx` 内组件（仿 EnumAxisPick）：

- 两组来源的勾选列表（勾选项以换行拼接写回 axes，复用现有解析）
- 本机多选上传按钮：上传完成后把存储名追加为轴值行
- 保留手填 Textarea 入口（列表下方折叠或并排；实现从简：勾选列表 + 上传按钮 + 底部小 Textarea 同步显示当前值可直接编辑）
- MatrixEntry：`p.type === 'image'` → ImageAxisPick

### 2.3 不变项

- CSV 导入不变：存在性回退语义下，GPU 侧文件名/已上传名直接填即有效
- 「批量图片」tab 不变
- hooks：`use-upload-files.ts`、`use-comfy-input-files.ts`（react-query，staleTime 30s，retry false，失败降级为组隐藏）

## 3. 错误处理

| 场景 | 行为 |
|---|---|
| 本地 uploads 无该文件 | 原样注入 prompt，ComfyUI 侧解析（找不到则 job 失败，错误来自 ComfyUI） |
| 值含 `..`/绝对路径 | 不读本地，原样传（ComfyUI 侧失败） |
| GET /comfy/input-files 离线 | 503；前端隐藏 GPU 组 |
| GET /uploads 目录不存在 | 200 `{files:[]}` |
| 内联上传失败 | 控件旁错误提示，不清空已填值 |

## 4. 测试策略

**服务端**：
- executor：本地存在 → 上传替换（既有回归）；本地不存在 → 不调 uploadImage、原样注入；`../evil` → 原样传不读本地
- 路由：GET /uploads 空/有文件（mtime 倒序）；GET /comfy/input-files 正常（FakeComfy objectInfo 注入 LoadImage）/离线 503/无 LoadImage 空数组

**web**：组件不上渲染测试（沿用约定）；手动验收：内联上传自动填值、下拉两组来源、离线降级隐藏 GPU 组、矩阵勾选+上传追加、CSV 填 GPU 文件名端到端出图

## 5. 边界（本期不做）

- 不做 uploads 目录管理（删除/重命名）
- 不做图片预览缩略图
- 不做 GPU 侧文件的子目录浏览（值可手填 `subfolder/name` 但列表只显示 LoadImage COMBO 给出的项）
