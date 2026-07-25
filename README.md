# comfy-workflow-executor

批量执行 ComfyUI workflow 的轻量执行器：导入 workflow（API/UI 格式 JSON 或 PNG）、圈选参数保存为模板，
用表格/CSV、笛卡尔积矩阵或批量图片生成一批任务，串行提交给一个已运行的 ComfyUI，
结果落盘 + Web 画廊 + zip 下载。SQLite 持久化队列，重启自动恢复。

设计文档：`docs/superpowers/specs/2026-07-24-comfy-workflow-executor-design.md`

## 本地开发

需要 Node >= 22 与 pnpm 11：

```bash
pnpm install
pnpm test          # 全部离线单测
pnpm dev           # server :8080 + web :5173（/api 自动代理）
```

开发模式 Token 默认 `dev-token`；ComfyUI 地址用 `COMFYUI_URL` 覆盖（默认 `http://127.0.0.1:8188`）。

## Docker Compose 部署（本地 / VPS / GPU 主机）

```bash
cp .env.example .env   # 修改 AUTH_TOKEN 和 COMFYUI_URL
docker compose up -d --build
```

打开 `http://<host>:8080`，输入 `.env` 里的 `AUTH_TOKEN` 登录。

- ComfyUI 在宿主机时保持默认 `http://host.docker.internal:8188`
- SQLite 与输出文件在 named volume `data` 中，容器重建不丢
- 执行器重启后未完成的 batch 自动继续

## 使用流程

1. 从 ComfyUI 导出 workflow：**Save (API Format)**、普通 **Save**（UI 格式）或直接用生成的 PNG 均可
2. **导入 workflow**：支持四种方式——选择/拖拽 UI 格式或 API 格式 JSON、拖入 ComfyUI 生成的 PNG（自动提取内嵌 workflow）、直接粘贴 JSON 文本。UI 格式会经服务器自动转换（需 ComfyUI 在线）。导入后按节点分组勾选批量参数，常用参数（正/负提示词、seed）会自动预选；checkpoint/sampler 等枚举输入自动识别为 enum 类型，建批次时可从服务器实时拉取可选值下拉选择。导入时会校验模型存在性并给出警告（不阻断保存）
3. New Batch → 三种方式生成任务：表格/CSV、矩阵组合、批量图片。image 参数支持三种来源：本机上传（表格/矩阵内联控件）、服务端已上传文件、GPU 主机 input 目录已有文件（CSV/手填直接写文件名即可——服务端没有该文件时会原样传给 ComfyUI 解析）。含图片输入且模板有 width/height 参数时，「输出尺寸」有三种模式：模板默认；锁定比例——填一维按源图比例自动算另一维；跟随源图——宽高直接取源图尺寸（可设最长边上限，超限等比缩小），表格模式选图即自动填充。计算维均就近取整到 8 的倍数
4. Batches 详情页看实时进度与画廊，完成后下载 zip
5. 列表管理：Templates / Batches 均支持搜索、列排序、分页、列显隐与多选批量操作（模板批量删除、batch 批量取消 / 重试失败 / 删除——删除默认保留输出文件，可勾选一并清理）；Templates 支持拖拽调整顺序

## 边界（V1）

单 ComfyUI 实例、串行执行；不自动重试（提供手动「重试失败任务」）；
不管理 ComfyUI 生命周期；无多用户。
