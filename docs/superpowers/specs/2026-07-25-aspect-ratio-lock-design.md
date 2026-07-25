# 锁定源图长宽比 — 设计

日期：2026-07-25
状态：已与用户对齐（生效范围、尺寸来源、取整规则、两节设计均确认）

## 背景与目标

img2img 类 workflow 建批次时，期望输出尺寸与输入图片等比，否则变形/裁剪。新增「锁定源图长宽比」：锁定后用户只填宽或高之一，另一维按源图实际比例自动计算。

已确认决策：
- 生效范围：**批量图片 tab + 表格模式**（矩阵模式不做，语义混乱）
- 尺寸来源：**三种全覆盖**——统一 `GET /api/image-dims` 端点，uploads 本地读取 → ComfyUI `/view` 代理拉取 GPU 侧文件
- 取整：计算维**就近取整到 8 的倍数**，下限 8

## 1. 服务端

### 1.1 ComfyClient.getInputImage（新方法）

- `getInputImage(name: string): Promise<ArrayBuffer | null>`：GET `<COMFYUI_URL>/view?filename=<file>&type=input&subfolder=<sub>`；`name` 含 `/` 时按最后一个 `/` 拆为 subfolder 与 filename；HTTP 404 → 返回 null；其他非 2xx → 抛错
- FakeComfy 加成员 `inputImages: Record<string, Buffer> = {}` 与对应实现（无则返回 null）

### 1.2 GET /api/image-dims?name=<文件名>（新端点，挂 comfy 路由同级、受 /api/* 鉴权）

判定顺序（与执行器存在性回退一致）：
1. `name` 含 `..` 或为绝对路径 → 跳过本地检查
2. `uploads/<name>` 存在 → 读文件字节
3. 否则 ComfyUI 在线 → `getInputImage(name)`；返回 null → 404
4. 否则（本地没有且 ComfyUI 离线/未配置）→ 503 `{ error: 'ComfyUI 离线,无法探测 GPU 侧图片尺寸' }`

取到字节后用 **`image-size`**（新依赖，纯 JS）解析：成功 → 200 `{ width: number, height: number }`；解析失败 → 404 `{ error: '无法解析图片尺寸' }`

无服务端缓存（前端 react-query 按文件名缓存）。

### 1.3 shared — computeLockedDim（新纯函数 + 单测）

```
computeLockedDim(
  source: { width: number; height: number },
  driver: 'width' | 'height',
  value: number,
): { width: number; height: number }
```

- driver='width' → height = round8(value * source.height / source.width)；反之同理
- `round8(n) = max(8, round(n/8)*8)`；driver 侧的值原样保留（不取整——用户输入什么就是什么）
- source 宽或高 ≤0 时抛错（调用方保证不传）

### 1.4 维度参数识别（前端规则，记录于此）

模板 params 中 `type === 'number'` 且 `inputName === 'width'` / `inputName === 'height'` 的**第一对**（按 params 数组顺序）。凑不齐一对 → 锁定控件不渲染。多对宽高的模板本期只作用于第一对（已知限制）。

## 2. 前端

### 2.1 hooks

- `useImageDims(name: string | undefined)`：react-query，`queryKey: ['image-dims', name]`，enabled 仅当 name 非空，staleTime 5 分钟，retry false

### 2.2 表格模式（TableEntry）

- 模板同时有 image 参数与宽高对时，表格上方渲染「锁定源图比例」checkbox（表级开关，默认关）
- 开启后：某行编辑宽（或高）单元格，以最后编辑侧为驱动，取该行 image 参数的当前值 → useImageDims 探测（防抖 500ms）→ 成功则用 computeLockedDim 自动填另一格
- 该行 image 为空 / dims 404/503 → 不自动填，该行宽高单元格旁显示小提示（「无法获取源图尺寸」/「ComfyUI 离线」）
- 手动改被算出的格允许（手动值生效）；再次编辑驱动侧会重新覆盖

### 2.3 批量图片 tab（ImagesEntry）

- 有宽高对时共享参数区渲染：锁定 checkbox + 「按宽定高 / 按高定宽」Select + 单个数值输入；被计算维的输入框禁用显示「自动」
- 生成任务时：并发探测每张已上传图片的 dims（此时都是服务端 uploads 文件，端点必可达本地路径）→ 每个任务用 computeLockedDim 算出另一维写入该任务参数
- 某张图探测失败 → 该任务的宽高用模板默认值，生成后横幅提示「N 张图未能获取尺寸，已用默认值」

### 2.4 错误处理

| 场景 | 行为 |
|---|---|
| dims 404（不存在/解析失败） | 表格：不自动填+行内提示；批量：该图用默认值+汇总横幅 |
| dims 503（ComfyUI 离线且本地无） | 同上，文案标明离线 |
| 锁定但比例计算 <8 | round8 下限 8 |
| 未凑齐宽高对 | 锁定控件不渲染（无死 UI） |

## 3. 测试策略

- **shared**：computeLockedDim 单测——横图/竖图/方图、按宽/按高、取整到 8、下限 8、驱动侧不取整
- **server**：image-dims 四路径——本地真实 PNG 字节（构造最小 1×1 或固定尺寸 PNG）解析成功；GPU 路径（FakeComfy.inputImages 注入）；两边都没有 404；离线且本地无 503；`..` 值跳本地（FakeComfy 有则走 GPU、无则 404/503）
- **web**：无渲染测试（沿用约定）；手动验收：表格行级自动填（含改驱动侧重算）、批量 tab 逐图不同比例出不同高、离线/缺图降级提示

## 4. 边界（本期不做）

- 矩阵模式不支持锁定
- 多对宽高参数只作用第一对
- 不做比例预设（16:9 等）——只跟随源图
- 无服务端 dims 缓存
