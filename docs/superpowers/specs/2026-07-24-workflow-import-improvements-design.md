# Workflow 导入体验改进 — 设计文档

日期:2026-07-24
状态:已确认
背景:V1 的导入页只接受手选的 API-format JSON 文件,参数圈选是平铺大表。用户反馈「僵化」。本设计借鉴 comfy-portal 的导入实践(多入口、格式检测、节点语义化、服务器枚举),但转换逻辑自研于后端,不依赖 ComfyUI 侧插件。

## 目标

1. **格式兼容**:接受 UI/graph 格式 JSON、剪贴板粘贴、ComfyUI 生成的 PNG(提取内嵌 workflow)
2. **参数圈选体验**:按节点分组 + 搜索 + 常见参数智能预选
3. **枚举参数**:checkpoint/sampler 等从服务器 `/object_info` 拉真实可选值,批量填参用下拉
4. **导入校验**:模型存在性检查,警告不阻断

非目标:模板保存后的参数再编辑;workflow 可视化图渲染;ComfyUI 插件生态支持之外的自定义节点转换兜底(缺定义就明确报错)。

## 1. 导入入口与格式处理

导入页三种入口,汇入同一解析管道:

- **文件选择 / 拖拽**:accept `.json` + `.png`,支持 drop zone
- **粘贴**:textarea 粘贴 JSON 文本
- **PNG 提取**(纯前端):解析 PNG tEXt/iTXt chunk,取 `prompt`(API 格式,优先)或 `workflow`(UI 格式,走转换)。两者皆无 → 报「该 PNG 不含 ComfyUI 元数据」

**格式自动检测**(前端函数 `detectFormat`):

- 顶层含 `nodes` 数组 + `links` 数组 → `graph`(UI 格式)→ 调 `POST /api/comfy/convert` 转换
- 顶层是 `{id: {class_type, inputs}}` 形状的 map → `api` 格式,直接用
- 都不是 → 报「无法识别的 JSON 格式」

## 2. graph→API 转换器(后端核心新模块)

新文件 `apps/server/src/comfy/graph-convert.ts`,纯函数:

```
convertGraphToApi(graph: GraphJson, objectInfo: ObjectInfoMap): ApiJson
```

- `widgets_values`(按位置数组)→ 按 `/object_info` 中该节点类型的 widget 名称顺序映射为命名 inputs;处理 `control_after_generate` 等伪 widget 占位(seed/int widget 后跟一个不属于 inputs 的控制位)
- `links` 数组解析为 `[sourceNodeId, sourceSlot]` 连线值
- **Reroute** 节点:透传,链路上游递归解析
- **PrimitiveNode**:其值下沉到所有被连接的目标输入
- **muted (mode=2) / bypassed (mode=4)** 节点:mute 的节点从图中剔除(其下游输入若因此悬空,按 ComfyUI 语义处理:bypass 透传同类型输入,mute 直接剔除)
- 节点类型在 `objectInfo` 中不存在(缺自定义插件)→ 抛错并**列出全部缺失的节点类型名**,不产出半坏 workflow

新端点 `POST /api/comfy/convert`:body 为 graph JSON,服务器拉(带缓存的)`/object_info` 执行转换,返回 API JSON。ComfyUI 离线 → 503 + 明确文案「UI 格式转换需要 ComfyUI 在线」;API 格式导入不受影响。

**`/object_info` 内存缓存**:模块 `apps/server/src/comfy/object-info-cache.ts`,TTL 5 分钟,转换、枚举、校验三处共用;提供手动刷新参数(`?refresh=1`)。

## 3. 参数圈选体验(前端重构)

`template-import.tsx` 重构:

- 平铺 Table → **按节点分组的折叠卡片**,标题 `_meta.title || class_type`,组内仍是行(输入名/当前值/勾选/key/类型)
- 顶部**搜索框**:按节点标题、class_type、输入名、当前值过滤;命中时自动展开对应分组
- **智能预选**(`suggestParams` 函数,前端纯函数):
  - `CLIPTextEncode.text`:通过 KSampler(及变体)的 `positive`/`negative` 连线回溯区分,预选并命名 `prompt` / `negative_prompt`
  - seed 类输入(输入名含 `seed`)→ 预选,type `seed`,key `seed`
  - `steps`、`cfg`、`denoise`、`ckpt_name` 等常见输入 → 排序靠前,不默认勾选(除 prompt/seed 外默认不勾,避免参数爆炸)
  - key 冲突时追加序号(`prompt`, `prompt_2`)
- 连线输入(数组值)照旧不展示;预选仅是默认态,用户可全改

## 4. 枚举参数

- `@cwe/shared`:`ParamType` 增加 `'enum'`;`ParamDef` 增加可选字段 `enumRef?: { classType: string; inputName: string }`
- 导入时:枚举信息统一由 `POST /api/comfy/validate` 的响应携带——除 `warnings` 外增加 `enumInputs: [{ nodeId, classType, inputName }]`,列出该 workflow 中所有枚举型输入(`/object_info` 中 input 定义第一个元素是数组者)。前端据此把对应行的类型预设为 `enum` 并记录 `enumRef`。两种格式导入后都会调 validate,无需单独端点
- **批量建任务页**:enum 参数渲染为下拉(单选)/多选框(矩阵模式多选做笛卡尔积);可选值经新端点 `GET /api/comfy/input-options?classType=&inputName=` 实时拉取(读 `/object_info` 缓存);ComfyUI 离线 → 降级为文本输入并提示
- 执行注入不变:enum 值最终仍是字符串写入 inputs

## 5. 导入校验

新端点 `POST /api/comfy/validate`:body 为 API JSON,对照 `/object_info` 检查每个枚举型输入的当前值是否在服务器可选值中(覆盖 checkpoint/LoRA/VAE 文件存在性),返回警告列表:

```json
{ "warnings": [{ "nodeId": "4", "classType": "CheckpointLoaderSimple", "inputName": "ckpt_name", "value": "xxx.safetensors", "message": "服务器上不存在" }] }
```

前端导入解析成功后自动调用,警告以黄色列表呈现在保存按钮上方,**不阻断保存**。ComfyUI 离线 → 跳过校验,提示「未校验(ComfyUI 离线)」。

## 6. 测试策略

- **转换器**:纯函数离线单测。夹具:真实 UI 格式样例(含 Reroute、PrimitiveNode、muted 节点、多 widget 节点)+ 录制的 `/object_info` 片段(仅涉及的节点类型)。含「缺失节点类型报错」用例
- **PNG 提取**:前端 vitest 单测,内嵌样例 PNG(base64)覆盖 prompt-only / workflow-only / 无元数据三种
- **端点**:FakeComfy 增加 `objectInfo` 数据,convert/validate/input-options 端点各配正反用例
- **suggestParams**:纯函数单测(prompt 正负区分、seed、key 去重)
- 现有 51 个服务器测试与 9 个 web 测试保持绿

## 错误处理一览

| 场景 | 行为 |
|---|---|
| 粘贴/文件非法 JSON | 前端报「JSON 解析失败」 |
| 无法识别格式 | 前端报「无法识别的 JSON 格式(需 ComfyUI workflow)」 |
| PNG 无元数据 | 前端报「该 PNG 不含 ComfyUI 元数据」 |
| UI 格式 + ComfyUI 离线 | 503,「UI 格式转换需要 ComfyUI 在线」 |
| 缺自定义节点定义 | 422,列出缺失 class_type 清单 |
| 校验时 ComfyUI 离线 | 跳过校验并提示,不阻断 |
| 枚举拉取失败(建批次时) | 降级文本输入 |

## 借鉴与取舍(vs comfy-portal)

| comfy-portal 实践 | 本设计的取舍 |
|---|---|
| 文件 + 剪贴板双入口 | 采纳,另加 PNG 提取与拖拽 |
| graph→API 转换依赖服务器插件(CPE) | **不采纳**:自研后端转换器,保持零 ComfyUI 侧依赖 |
| 手写 ~40 个节点组件注册表 | 不采纳整套;仅取「常见节点语义预选」轻量子集 |
| `/experiment/models` 拉模型列表 | 改用更标准的 `/object_info`(枚举定义天然含全部可选值) |
| 未知节点按值类型推断兜底 | 已有等价实现,保留 |
