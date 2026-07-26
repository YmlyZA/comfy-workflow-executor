"""cwe 扩展:受限的 output 文件删除端点(配套 comfy-workflow-executor)。

无鉴权——部署前提是 ComfyUI 仅本机/SSH 隧道可达,详见本目录 README。
"""
import os

import folder_paths
from aiohttp import web
from server import PromptServer

VERSION = 1

routes = PromptServer.instance.routes


def _resolve_output_file(subfolder: str, filename: str):
    """解析到 output 目录内的绝对路径;越界(../绝对路径/符号链接逃逸)返回 None。"""
    out_root = os.path.realpath(folder_paths.get_output_directory())
    target = os.path.realpath(os.path.join(out_root, subfolder or "", filename or ""))
    if not target.startswith(out_root + os.sep):
        return None
    return target


@routes.get("/cwe/ping")
async def cwe_ping(request):
    return web.json_response({"ok": True, "version": VERSION})


@routes.post("/cwe/delete-output-files")
async def cwe_delete_output_files(request):
    body = await request.json()
    files = body.get("files") or []
    deleted, missing, failed = 0, 0, []
    for item in files:
        subfolder = str(item.get("subfolder") or "")
        filename = str(item.get("filename") or "")
        label = f"{subfolder}/{filename}" if subfolder else filename
        target = _resolve_output_file(subfolder, filename)
        if target is None:
            failed.append(label)
            continue
        if not os.path.isfile(target):
            missing += 1
            continue
        try:
            os.remove(target)
            deleted += 1
        except OSError:
            failed.append(label)
    return web.json_response({"deleted": deleted, "missing": missing, "failed": failed})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
