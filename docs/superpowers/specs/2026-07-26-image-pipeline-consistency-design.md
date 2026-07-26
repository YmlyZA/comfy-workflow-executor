# UI 打磨与 image 输入一致化 — 设计

日期：2026-07-26
状态：已与用户对齐（三块工作拆三个 PR，本篇为 PR ①；PR ② GPU 文件清理、PR ③ 矩阵重设计另行立项）

## 背景与目标

四个体验问题：

1. **Templates 列表**：参数列把所有参数逐个渲染成 Badge，参数多的模板撑出横向滚动。
2. **批量图片 tab 只能本机上传**：表格模式（ImageValueControl）和矩阵模式（ImageAxisPick）都支持「服务端已上传 / GPU 主机已有」双来源选择，批量图片 tab 缺失。
3. **重复上传堆积**：`POST /uploads` 每次都写 `随机hex-原名`，同内容重复上传在服务端堆副本；这些副本各自上传到 GPU 侧后同样堆积（`uploadImage` 已带 `overwrite=true`，GPU 堆积的根源就是服务端存了多份不同名的同内容文件）。
4. **选文件靠文件名盲选**：双来源列表没有缩略图预览。

## 1. Templates 列表列宽（apps/web/src/pages/templates.tsx）

只改列定义 cell，不动共享 DataTable 组件：

- 名称列：`max-w-48 truncate`，`title` 悬停看全名
- 参数列：单行不换行，只渲染**前 3 个** Badge（每个 Badge 自身限宽截断），超出部分折叠为一个 `+N` Badge，`title` 悬停列出全部 `key:type`
- 创建时间列不动

无服务端改动；按 web 约定无渲染测试。

## 2. ImageMultiPick 共享组件 + 批量图片 tab 双来源

### 2.1 组件抽取（apps/web/src/components/image-multi-pick.tsx）

把 `ImageAxisPick` 的核心抽成共享组件：

```
ImageMultiPick({ value: string[], onChange: (next: string[]) => void })
```

- 「服务端已上传」「GPU 主机已有」双组勾选列表（数据源沿用 useUploadFiles / useComfyInputFiles，GPU 组离线时隐藏——现状语义）
- 「上传本机图片」按钮：上传成功的文件**自动追加进已选**并 invalidate upload-files
- 每个列表项带缩略图（见 §4）

矩阵 tab 的 `ImageAxisPick` 变薄壳：换行文本 ↔ string[] 适配 + 保留手填 textarea。批量图片 tab 直接用 `ImageMultiPick`，不提供手填（表格模式已覆盖任意手填场景）。

### 2.2 批量图片 tab 改为声明式派生（ImagesEntry）

- 状态：`selected: string[]`（勾选顺序即任务顺序），替换「上传即生成 jobs」的命令式流程
- jobs 由 `selected + shared + sizeMode + driver/driverValue + cap` **自动派生**，任一变化即重算：
  - `default` 模式：不探测，直接 `selected.map(s => ({ ...shared, [imageKey]: s }))`
  - `ratio` / `source` 模式：用 `useQueries` 按文件名并行探测尺寸（react-query 缓存自动去重）；**任一查询仍在加载时 `onChange([])`**（提交按钮消失）并显示「探测尺寸中…」；全部 settled 后写入 jobs
  - 探测失败的图：删宽高键回落模板默认 + 汇总横幅「N 张图未能获取尺寸，已用模板默认宽高」（沿用现有文案与降级路径）
  - `ratio` 模式且 driver 值无效（空 / 非数字 / ≤0）：`onChange([])` + 提示「锁定比例后需先填写有效的宽或高数值」（沿用现有文案，从提交时报错改为实时提示）
- **行为变化（有意为之）**：
  - 多次上传/勾选是**累积**的，不再是"最后一次上传覆盖全部"
  - 上传后再改共享参数，jobs 跟着更新（修复现状快照缺陷：ImagesEntry 的 jobs 是 onFiles 时刻的快照，之后改 shared 不生效）

## 3. hash 去重 + executor 传输缓存

### 3.1 服务端去重（apps/server/src/routes/files.ts）

`POST /uploads` 每个文件：

- 对内容算 sha256，取**前 16 位 hex** 作前缀，存储名 = `<hash16>-<safe原名>`（safe 清洗规则不变）
- 写盘前扫描 uploads 目录：已存在以 `<hash16>-` 开头的文件 → 不写盘，直接返回该已有文件名（同内容不同原名也复用，返回名以先到者为准）
- 返回结构 `[{ name, stored }]` 不变
- 旧文件（`8位hex-原名`）前缀长度不同，不会被 16 位前缀误匹配，无需迁移

不建数据库表：文件系统是 uploads 唯一事实来源（列表、执行器回退、dims 探测都直接读目录），hash 编进文件名让去重退化为一次目录扫描，零新增状态。sha256 前 64 bit 碰撞概率对个人工具可忽略。

### 3.2 executor 进程内缓存（apps/server/src/executor.ts）

- Executor 实例持有 `Map<string, string>`（本地 stored 名 → GPU 侧返回名）
- `execute` 上传前查缓存，命中则直接复用 GPU 名，跳过重复传输（同图 N 个 job 只传一次）
- 生命周期 = 进程；重启后重传一次（`overwrite=true` 幂等覆盖）。GPU 侧 input 目录被手动清空的窗口期内缓存会指向已删文件——接受，重启 server 即恢复

`uploadImage` 的 `overwrite=true` 已存在，本期不动 client。

## 4. 缩略图预览

### 4.1 服务端两个只读端点

- `GET /api/uploads/:name`：serve uploads 目录文件流。守卫：`basename(name) !== name` 或含 `..` → 400；不存在/非文件 → 404。Content-Type 按扩展名给常见 image 类型，未知回 `application/octet-stream`
- `GET /api/comfy/input-image?name=`：代理已有 `getInputImage`。无 name → 400；comfy 未配置或离线 → 503；不存在 → 404（错误语义与 image-dims 对齐）

### 4.2 前端

- `lib/api` 新增 `uploadFileUrl(name)` / `comfyInputFileUrl(name)`，沿用现有 query-token 机制（同画廊 fileUrl）
- `ImageMultiPick` 列表项和 `ImageValueControl` 下拉项前加 `size-8 object-cover rounded` 缩略图：服务端组走 `/api/uploads/:name`，GPU 组走 `/api/comfy/input-image`；`loading="lazy"`，`onError` 隐藏该图（非图片/读取失败不破版式）
- **不做服务端缩放**：个人工具+本地网络，lazy 加载已够；避免引入 sharp（原生依赖，pnpm 11 构建脚本坑）。取舍：超大图首次加载解码稍慢，react/浏览器缓存后无感

## 5. 测试策略

- **server**（vitest，沿用 routes.test 模式）：
  - 去重：同内容两次上传返回同 stored 名且目录仅一份；不同内容不同名；同内容不同原名复用先到者
  - `GET /api/uploads/:name`：正常返回内容；`..`/带路径 → 400；不存在 → 404
  - `GET /api/comfy/input-image`：无 name 400；离线 503；正常代理返回 bytes
  - executor：两个 job 引用同一本地文件 → mock comfy 的 uploadImage 只被调用一次，两 job 的 prompt 都拿到 GPU 名
- **web**：无渲染测试约定；手动验收清单：
  1. 参数很多的模板在 Templates 列表不出现横向滚动，`+N` 悬停能看到全部参数
  2. 批量图片 tab 能勾选「GPU 主机已有」文件生成任务（不经过上传）
  3. 同一张图重复上传，返回同名且 uploads 目录不新增文件
  4. 双来源列表和表格下拉里能看到缩略图；坏文件不破版式
  5. 批量图片 tab：上传后修改共享参数，预览 jobs 跟着变；多次上传累积而非覆盖
  6. 尺寸三态在批量图片 tab 仍按 PR #7 语义工作（探测中提交按钮隐藏）

## 6. 边界（本期不做）

- 客户端预 hash 免传输（server 端去重已止住存储堆积；传输省流属优化，YAGNI）
- 服务端缩略图缩放（见 §4.2 取舍）
- uploads 列表分页 / 删除管理
- GPU 文件删除（PR ②）、矩阵 UI 重设计（PR ③）
