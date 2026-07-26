# 删除 batch 可选清理 GPU 主机输出文件 — 设计

日期：2026-07-26
状态：已与用户对齐（三期规划第 ②/3；方案「自定义 ComfyUI 扩展」在 PR ① 立项时已确认）

## 背景与目标

删除 batch 时可勾选「同时删除输出文件」，但只删服务端本地 `outputs/<batchId>/`；GPU 主机上 ComfyUI 生成的原始输出文件持续堆积。原版 ComfyUI 的 HTTP API 没有任何删除文件的端点，因此需要在 GPU 主机装一个仓库自带的迷你扩展提供受限删除能力，并让执行器开始把 GPU 侧输出引用入库——没有引用就不知道该删哪些文件。

已确认决策：

- 方案：**自定义 ComfyUI 扩展**（GPU 主机在用户控制下，拷贝目录+重启即可）
- 只在**删除 batch** 时清理，且只删 **output 目录**内该 batch 的文件；GPU input 目录的源图不动（可能被多个 batch 共用）
- 旧 batch（引用未入库）自动跳过 GPU 侧删除，不报错

## 1. 输出引用入库

### 1.1 shared（packages/shared/src/types.ts）

```ts
export interface OutputFile {
  /** 相对 outputs 根目录的路径，如 "3/0-cat-00001.png" */
  path: string
  filename: string
  /** GPU 侧引用(type 恒为 output 不存);旧数据无此字段 → GPU 侧删除跳过 */
  gpu?: { filename: string; subfolder: string }
}
```

可选字段，SQLite JSON 列新旧结构共存，无迁移。

### 1.2 executor（apps/server/src/executor.ts）

`collectOutputs` 为每个下载的输出写入 `gpu: { filename: ref.filename, subfolder: ref.subfolder }`。`recover()` 路径复用同一函数，自动获得引用。

## 2. ComfyUI 扩展（仓库新目录 comfyui-cwe/）

纯 HTTP 路由扩展（无节点定义），单文件 `comfyui-cwe/__init__.py`（约 60 行）+ `comfyui-cwe/README.md`：

- `GET /cwe/ping` → `{"ok": true, "version": 1}`——供服务端探测扩展已安装
- `POST /cwe/delete-output-files`，body `{"files": [{"filename": "x.png", "subfolder": ""}]}`：
  - 目标路径 = `folder_paths.get_output_directory()` + subfolder + filename
  - 守卫：`os.path.realpath(目标)` 必须以 `realpath(output目录) + os.sep` 开头，否则该项计入 `failed`（防 `..`/绝对路径/符号链接穿越）
  - 逐项删除普通文件；不存在计 `missing`；目录/删除异常计 `failed`
  - 返回 `{"deleted": n, "missing": n, "failed": ["subfolder/filename", ...]}`
- 无鉴权：部署前提是 ComfyUI 仅本机/SSH 隧道可达（用户现状），README 明确写出这一前提与风险
- `NODE_CLASS_MAPPINGS = {}` 保持 ComfyUI 加载器满意
- 安装（README）：`cp -r comfyui-cwe <ComfyUI>/custom_nodes/` 或 symlink，重启 ComfyUI；`curl http://localhost:8188/cwe/ping` 验证

Python 代码无仓库内测试设施：逻辑保持极简（一个守卫函数+一个循环），靠代码审查与手动验收覆盖。

## 3. 服务端

### 3.1 ComfyClient（apps/server/src/comfy/client.ts）

```ts
/** 扩展是否安装(GET /cwe/ping);离线/404/异常均 false */
cwePing(): Promise<boolean>
/** 删除 GPU 侧 output 文件;扩展缺失/离线抛错由调用方兜 gpuPurgeFailed */
cweDeleteOutputFiles(refs: Array<{ filename: string; subfolder: string }>): Promise<{ deleted: number; missing: number; failed: string[] }>
```

FakeComfy 同步实现（记录调用、可配置返回/抛错）。

### 3.2 路由

- `GET /api/comfy/cwe-status` → `{ installed: boolean }`：comfy 未配置 / 离线 / ping 非 ok 均 `false`（不用 503——这是能力探测不是错误）
- `DELETE /api/batches/:id` 新增 query `purgeGpu=1`：
  1. 删 DB 前先 `getBatchDetail` 收集所有 jobs 的 `outputs[].gpu` 引用（去重按 subfolder+filename）
  2. 现有流程不变：deleteBatch → 可选本地 purge
  3. 引用非空时调 `cweDeleteOutputFiles`；抛错或 `failed` 非空 → 响应加 `gpuPurgeFailed: true`
  4. 引用为空（旧 batch 或无输出）→ 不调用、不置 flag，响应加 `gpuSkipped: <无引用的输出文件数>`（为 0 时省略）
  5. `purgeGpu` 与 `purgeOutputs` 独立，可任意组合

## 4. 前端（apps/web/src/pages/batches.tsx）

删除对话框（BatchesBulkActions 内 AlertDialog）：

- 现有「同时删除输出文件」勾选框下方加第二个勾选框「同时删除 GPU 主机上的输出文件」
- 新 hook `useCweStatus()`（`['cwe-status']`，staleTime 30s，retry false）：`installed === false` 时勾选框禁用，旁注「需在 GPU 主机安装 cwe 扩展」
- 对话框关闭时两个勾选状态都复位（沿用现有 onOpenChange 模式）
- 结果横幅：`gpuPurgeFailed` 的 batch 汇总为「…GPU 侧清理失败」；`gpuSkipped` 的 batch 汇总为「…GPU 侧引用缺失已跳过（旧批次）」——与现有 purgeFailures 后缀拼接模式一致

## 5. 测试策略

- **server**（vitest，扩展 FakeComfy）：
  - executor：成功 job 的 `outputs[0].gpu` 等于提交结果的 `{filename, subfolder}`
  - cwe-status：未配置 comfy → false；ping true → true；ping 抛错 → false
  - DELETE ?purgeGpu=1：引用收集正确并传给 client（含多 job 去重）；client 抛错 → `gpuPurgeFailed: true` 且 DB 已删；旧数据（outputs 无 gpu 字段）→ 不调 client、`gpuSkipped` 计数正确；不带 purgeGpu → 不调 client
- **web**：无渲染测试约定；手动验收清单：
  1. GPU 主机装扩展（README 步骤），`curl /cwe/ping` 通
  2. 跑一个新 batch → 勾选两个删除选项删除 → 本地 outputs 目录与 GPU output 目录文件都消失
  3. 不勾 GPU 选项删除 → GPU 侧文件保留
  4. 删除 PR ② 之前创建的旧 batch（勾 GPU 选项）→ 横幅提示旧批次跳过
  5. 停掉 ComfyUI（或未装扩展）→ 勾选框禁用+提示
- **Python 扩展**：无自动测试；审查覆盖穿越守卫，手动验收覆盖删除路径

## 6. 边界（本期不做）

- GPU input 目录源图清理
- 扩展鉴权（依赖隧道内网前提）
- 非删 batch 场景的维护式批量清理
- 矩阵 UI 重设计（PR ③）
