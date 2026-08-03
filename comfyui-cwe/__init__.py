"""cwe 扩展:受限的 output 文件删除端点(配套 comfy-workflow-executor)。

无鉴权——部署前提是 ComfyUI 仅本机/SSH 隧道可达,详见本目录 README。
"""
import os

import folder_paths
from aiohttp import web
from server import PromptServer

VERSION = 2

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
    if not isinstance(files, list):
        files = []
    deleted, missing, failed = 0, 0, []
    for item in files:
        if not isinstance(item, dict):
            failed.append(str(item))
            continue
        subfolder = str(item.get("subfolder") or "")
        filename = str(item.get("filename") or "")
        label = f"{subfolder}/{filename}" if subfolder else filename
        target = _resolve_output_file(subfolder, filename)
        if target is None:
            failed.append(label)
            continue
        if not os.path.exists(target):
            missing += 1
            continue
        if not os.path.isfile(target):
            failed.append(label)
            continue
        try:
            os.remove(target)
            deleted += 1
        except OSError:
            failed.append(label)
    return web.json_response({"deleted": deleted, "missing": missing, "failed": failed})


@routes.get("/cwe/list-output-files")
async def cwe_list_output_files(request):
    """递归列举 output 目录普通文件(孤儿扫描用);符号链接逃逸出根的条目跳过。"""
    out_root = os.path.realpath(folder_paths.get_output_directory())
    files = []
    for dirpath, _dirnames, filenames in os.walk(out_root):
        for name in filenames:
            real = os.path.realpath(os.path.join(dirpath, name))
            if not real.startswith(out_root + os.sep):
                continue
            if not os.path.isfile(real):
                continue
            try:
                st = os.stat(real)
            except OSError:
                continue
            sub = os.path.relpath(dirpath, out_root)
            files.append({
                "filename": name,
                "subfolder": "" if sub == "." else sub,
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            })
    return web.json_response({"files": files})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
