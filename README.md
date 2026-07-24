# comfy-workflow-executor

批量执行 ComfyUI workflow 的轻量执行器：导入 API-format workflow JSON、圈选参数保存为模板，
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

1. ComfyUI 开启 Dev Mode，用 **Save (API Format)** 导出 workflow JSON
2. Templates → 导入 Workflow → 勾选要批量变化的输入（prompt/seed/image…）并命名
3. New Batch → 三种方式生成任务：表格/CSV、矩阵组合、批量图片
4. Batches 详情页看实时进度与画廊，完成后下载 zip

## 边界（V1）

单 ComfyUI 实例、串行执行；不自动重试（提供手动「重试失败任务」）；
不管理 ComfyUI 生命周期；无多用户。
