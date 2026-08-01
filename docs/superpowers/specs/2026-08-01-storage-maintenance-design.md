# 存储维护中心 设计（九期 ①）

日期：2026-08-01
状态：已与用户确认（GPU 孤儿清单确认式：默认全不勾、勾选后删；维护页 = 各类占用统计 + 一键清理）

## 背景

四类孤儿文件只增不删，散落在历代已知取舍里：

1. **GPU 侧无引用文件**（PR #9 取舍）：失败/取消/中断 job 在 GPU output 目录写出的文件没有 DB 引用，永远没人删
2. **导入备份残留**（PR #19 取舍）：`<dataDir>/.bak-<ts>/` 只增不删；异常中断可能残留 `.import-*`
3. **thumbs 孤儿缓存**（PR #21 遗留）：缩略图缓存按主机 id 隔离后，旧的未分主机文件成为孤儿；被删图片的缓存也不回收
4. **本地孤儿输出目录**（V1 跟进清单）：删 batch 不勾「删除输出文件」时 `outputs/<id>/` 整目录留存

## 目标

1. cwe 扩展 v2：新增 output 文件列举端点（配套 GPU 孤儿扫描）
2. `/api/maintenance`：本地三类占用统计与清理；GPU 孤儿扫描（按主机）与勾选删除
3. 前端 `/maintenance` 维护页：本地区块（统计+清理）+ GPU 区块（扫描→带缩略图预览的清单→勾选删除）

非目标（YAGNI）：uploads 清理（内容寻址被模板/历史参数引用，判定复杂、体积小）；自动定时清理；本地 outputs 的文件级孤儿（只做目录级）；bak 保留最近 N 份策略（清理即全清，要保留就先别点）。

## 设计

### cwe 扩展 v2（`comfyui-cwe/__init__.py`，合并后需重新部署+重启 ComfyUI）

- `VERSION = 2`；`GET /cwe/ping` → `{"ok": true, "version": 2}`（形状不变）
- 新增 `GET /cwe/list-output-files` → `{"files": [{"filename", "subfolder", "size", "mtime"}]}`：
  - `os.walk` 递归 output 目录，只列普通文件；`subfolder` 为相对目录（根为 `""`），`mtime` 取整秒 epoch
  - 与删除端点同款 realpath 前缀守卫（防符号链接逃逸出 output 根）
  - 无鉴权前提不变（仅本机/SSH 隧道可达）

### ComfyClient 扩展（`comfy/client.ts`）

- `cwePing(): Promise<number>`——语义从 boolean 改为版本号：`0` = 未装/离线/异常，`1`/`2` = 对应版本（响应无 version 字段的旧扩展按 1）。消费方同步调整：
  - `routes/comfy.ts` `/cwe-status` → `{ installed: v > 0, version: v }`；web `useCweStatus` 类型加 `version`（删除勾选框仍看 `installed`）
  - `routes/batches.ts` purgeGpu 不感知版本（删除端点 v1 就有）
- `cweListOutputFiles(): Promise<Array<{ filename: string; subfolder: string; size: number; mtime: number }>>`——`GET /cwe/list-output-files`，10s 超时（大目录）；非 200 抛错
- `getOutputImage(name: string): Promise<ArrayBuffer | null>`——与 `getInputImage` 同构但 `type=output`（GPU 孤儿缩略图预览用）

### 服务端 `routes/maintenance.ts`（挂 `/api/maintenance`）

- `GET /summary` → `{ bak: { count, bytes }, thumbs: { count, bytes }, orphanOutputs: { count, bytes } }`
  - bak：dataDir 顶层 `.bak-*` 与 `.import-*` 条目（目录递归计字节）；count = 顶层条目数
  - thumbs：`dataDir/thumbs` 全量（可再生缓存，不做孤儿判定）；count = 递归文件数
  - orphanOutputs：`outputs/<name>` 中 name 不是现存 batch id 的目录（含非数字命名）；count = 目录数
- `POST /clean` body `{ targets: Array<'bak' | 'thumbs' | 'orphan-outputs'> }` → `{ results: { [target]: { freedBytes, failed: string[] } } }`
  - 逐条 `rm -rf`，单条失败计入 failed 不中断
  - **bak 清理与进行中导入的并发守卫**：`.import-*` 条目仅当 mtime 距今超过 1 小时才删（进行中导入的临时文件不会存活这么久）；`.bak-*` 无此限制。清理动作整体放进 `deps.switchLock`（与导入热切换互斥，绝不删到正在换入的目录）
  - orphan-outputs 判定与删除在同一请求内重算（不信任前端传来的清单）
- `GET /gpu-orphans?hostId=` → `{ host: { id, name }, orphans: [{ filename, subfolder, size, mtime }], totalBytes }`
  - hostId 缺省 = 当前 active 主机；非 active 主机经 `deps.comfyFactory(host.url)` 临建 client；主机不存在 404
  - 先 `cwePing`：离线/未装 → 503 `{ error: 'GPU 主机不可达或未安装 cwe 扩展' }`；版本 < 2 → 409 `{ error: '需将 cwe 扩展升级到 v2 并重启 ComfyUI' }`
  - 孤儿 = 列举结果 −（**全库所有 job 的 gpu 引用并集**，键 `subfolder/filename`）。跨主机取并集是刻意保守：hostId 为 null 的旧 job 引用不会被误判成孤儿；代价是「A 主机引用的同名文件恰好也在 B 上」不会被列出——可接受
  - repo 新增 `listAllGpuRefKeys(db): Set<string>`（扫 `jobs.outputs` 非空行，JS 侧抽 `gpu` 引用）
- `POST /gpu-clean` body `{ hostId, files: [{ filename, subfolder }] }` → `{ deleted, missing, failed: string[] }`
  - client 解析同上（含 v2 校验）；直接转发 `cweDeleteOutputFiles`；files 上限 1000（zod）

### 缩略图预览（`routes/thumbs.ts` 扩展）

- `source` 新增 `comfy-output`，可选 `hostId` query（缺省 active）：经对应主机 client 的 `getOutputImage(name)` 取图；`name` 允许 `subfolder/file.png` 相对写法，沿用 `..`/绝对路径守卫
- 缓存目录 `thumbs/comfy-output/<hostId>/`（与 #21 的按主机隔离一致）；主机离线 503、文件不存在 404，语义与 comfy 源对齐

### 前端 `/maintenance` 维护页（导航加「维护」）

- **本地区块**：三行（导入备份残留 / 缩略图缓存 / 孤儿输出目录），各显示 条目数+占用，「清理」按钮 → 确认弹窗（thumbs 文案注明「清理后缩略图将按需重新生成」）→ 调 `/clean` → 显示释放字节/失败项，refetch summary
- **GPU 区块**：主机下拉（数据来自 `/api/hosts`，默认 active）→「扫描」→ 孤儿清单（网格：`comfy-output` 缩略图 + 文件名 + 大小 + 修改时间）：
  - **默认全不勾**，提供全选/全不选；勾选统计（N 项 / X MB）
  - 「删除所选」→ 确认弹窗（写明「GPU output 目录里手动跑图的产物也会被判为孤儿，请确认勾选项」）→ `/gpu-clean` → 结果反馈（deleted/missing/failed）→ 自动重扫
  - 扩展 v1 → 提示「需升级 cwe 扩展到 v2 并重启 ComfyUI」；主机离线 → 提示不可达
- 字节格式化：MB/GB 自适应（web 侧小工具函数）

### 测试（服务端）

1. cwe v2 交互均走 FakeComfy：加 `outputFiles` 字段与 `cweListOutputFiles()`、`cwePingVersion`（cwePing 返回值）、`getOutputImage`
2. summary：构造 `.bak-*`/`.import-*`/thumbs/孤儿与合法 outputs 目录 → 统计正确
3. clean：各 target 删除与字节统计；`.import-*` 新鲜条目（mtime < 1h）跳过；单条失败不中断且计入 failed；与 switchLock 串行（复用 hosts 并发测试模式）
4. gpu-orphans：引用并集比对（含 gpu 字段缺失的旧 job、跨主机引用）；v1 → 409；离线 → 503；非 active 主机走 factory
5. gpu-clean：转发与结果透传；files 超限 400
6. thumbs comfy-output：按 hostId 隔离缓存；`subfolder/x.png` 相对名；越界名 400
7. cwePing 版本语义：v2/v1（无 version 字段）/离线 → 2/1/0；`/cwe-status` 响应形状

web 照惯例不写渲染测试，手动验收清单（放 PR 描述）：

1. GPU 主机部署 v2 扩展重启后，`/maintenance` 扫描列出孤儿（含缩略图预览）；勾选删除后 GPU 侧文件消失，重扫为空
2. 未升级扩展（v1）时 GPU 区块提示升级；主机离线提示不可达
3. 手动在 ComfyUI 跑一张图 → 扫描能看到它且默认未勾选（不误删）
4. 本地三类清理：统计数字合理，清理后归零，释放字节显示
5. 清理 thumbs 后浏览列表缩略图自动重新生成
6. 删除 batch（不勾本地清理）→ 维护页出现对应孤儿输出目录
7. 多主机：切到另一台主机扫描其孤儿（下拉选择）

## 已知取舍

- GPU 孤儿判定基于「全库引用并集」而非按主机精确匹配——保守方向的误差（少列不误删）
- 手动跑图的产物会出现在孤儿清单中，靠默认不勾+缩略图预览+确认文案防误删——单用户工具可接受
- `.import-*` 的 1 小时新鲜度守卫是启发式；极端长的导入（上传数十 GB）期间点清理仍可能受 switchLock 阻塞等待而非跳过——可接受
- 扫描大 output 目录（数万文件）为一次性全量列举，无分页——局域网/隧道场景可接受，慢就等
