# comfyui-cwe

comfy-workflow-executor 配套的 ComfyUI 扩展：提供受限的 output 文件删除端点，
供执行器在删除 batch 时清理 GPU 侧输出文件。无节点定义，纯 HTTP 路由。

## 端点

- `GET /cwe/ping` → `{"ok": true, "version": 1}`（供服务端探测扩展已安装）
- `POST /cwe/delete-output-files`，body `{"files": [{"filename": "x.png", "subfolder": ""}]}`
  → `{"deleted": n, "missing": n, "failed": ["subfolder/filename", ...]}`
  只允许删除 ComfyUI output 目录内的普通文件（realpath 前缀校验，防路径穿越）。

## 安装

1. 拷贝本目录到 GPU 主机：`cp -r comfyui-cwe <ComfyUI>/custom_nodes/`
   或软链接：`ln -s <repo>/comfyui-cwe <ComfyUI>/custom_nodes/comfyui-cwe`
2. 重启 ComfyUI
3. 验证：`curl http://localhost:8188/cwe/ping`

## 安全前提

端点**无鉴权**。仅在 ComfyUI 只有本机 / SSH 隧道可达时使用；
若你的 ComfyUI 暴露于局域网或公网，请勿安装本扩展。
