import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { EnumRef, ParamDef, ParamType } from '@cwe/shared'
import type { TemplateDto } from '@/pages/templates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { detectFormat, guessType, parseNodeInputs, type NodeInputRow } from '@/lib/comfy-parse'
import { extractComfyMetadata } from '@/lib/png-meta'
import { suggestParams } from '@/lib/suggest-params'

interface Selection {
  key: string
  type: ParamType
  enumRef?: { classType: string; inputName: string }
}

interface ValidateResponse {
  skipped: boolean
  warnings: Array<{ nodeId: string; classType: string; inputName: string; value: string; message: string }>
  enumInputs: Array<{ nodeId: string; classType: string; inputName: string }>
}

const rowId = (r: NodeInputRow) => `${r.nodeId}.${r.inputName}`

/** 组内排序:已选最前,然后按常用输入优先级 */
const PRIORITY = ['text', 'seed', 'steps', 'cfg', 'denoise', 'ckpt_name', 'sampler_name', 'scheduler', 'width', 'height']

function apiErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(msg) as { error?: string; missingTypes?: string[] }
    if (parsed.missingTypes?.length) return `${parsed.error}(缺少:${parsed.missingTypes.join('、')})`
    return parsed.error ?? msg
  } catch {
    return msg
  }
}

export default function TemplateImportPage() {
  const navigate = useNavigate()
  const importSeq = useRef(0)
  const [name, setName] = useState('')
  const [json, setJson] = useState<Record<string, any> | null>(null)
  const [rows, setRows] = useState<NodeInputRow[]>([])
  const [selected, setSelected] = useState<Record<string, Selection>>({})
  const [enumRefs, setEnumRefs] = useState<Map<string, { classType: string; inputName: string }>>(new Map())
  const [validation, setValidation] = useState<ValidateResponse | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [searchParams] = useSearchParams()
  const from = searchParams.get('from')
  const fromTemplates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
    enabled: from !== null,
  })
  const fromLoaded = useRef(false)
  useEffect(() => {
    if (from === null || fromLoaded.current) return
    if (fromTemplates.isError) {
      fromLoaded.current = true
      setError(`加载模板失败:${apiErrorMessage(fromTemplates.error)}`)
      return
    }
    if (!fromTemplates.data) return
    fromLoaded.current = true
    const t = fromTemplates.data.find((x) => x.id === Number(from))
    if (!t) {
      setError(`模板不存在(from=${from}),可改用下方手动导入`)
      return
    }
    const sel: Record<string, Selection> = {}
    const refs = new Map<string, EnumRef>()
    for (const p of t.params) {
      const id = `${p.nodeId}.${p.inputName}`
      sel[id] = { key: p.key, type: p.type, ...(p.enumRef ? { enumRef: p.enumRef } : {}) }
      if (p.enumRef) refs.set(id, p.enumRef)
    }
    void ingest(t.comfyJson, `${t.name} 副本`, { sel, refs })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fromLoaded 保证只跑一次,ingest/error 依赖无需追踪
  }, [from, fromTemplates.data, fromTemplates.isError])

  /** 返回是否成功导入(被更新的导入取代视为不成功,但不写任何状态) */
  async function ingest(
    parsed: unknown,
    sourceName: string,
    preset?: { sel: Record<string, Selection>; refs: Map<string, EnumRef> },
  ): Promise<boolean> {
    const seq = ++importSeq.current
    setError('')
    setValidation(null)
    setBusy(true)
    try {
      let comfyJson: Record<string, any>
      const format = detectFormat(parsed)
      if (format === 'graph') {
        const res = await api<{ comfyJson: Record<string, any> }>('/comfy/convert', {
          method: 'POST',
          body: JSON.stringify(parsed),
        })
        if (seq !== importSeq.current) return false
        comfyJson = res.comfyJson
      } else if (format === 'api') {
        comfyJson = parsed as Record<string, any>
      } else {
        throw new Error('无法识别的 JSON 格式——需要 ComfyUI 导出的 workflow(UI 格式或 API 格式均可)')
      }

      const inputs = parseNodeInputs(comfyJson)
      if (inputs.length === 0) {
        throw new Error('未解析到任何节点输入')
      }

      // 校验 + 枚举标注
      let refs = new Map<string, { classType: string; inputName: string }>()
      try {
        const v = await api<ValidateResponse>('/comfy/validate', {
          method: 'POST',
          body: JSON.stringify(comfyJson),
        })
        if (seq !== importSeq.current) return false
        refs = new Map(
          v.enumInputs.map((e) => [`${e.nodeId}.${e.inputName}`, { classType: e.classType, inputName: e.inputName }]),
        )
        if (seq === importSeq.current) {
          setValidation(v)
        }
      } catch {
        // validate 失败时设置 skipped 状态，不阻断导入
        if (seq === importSeq.current) {
          setValidation({ skipped: true, warnings: [], enumInputs: [] })
        }
      }

      if (seq !== importSeq.current) return false

      // 从模板重选:预选与 enumRef 用源模板的 params(离线时 enum 类型也不丢);否则走智能预选
      for (const [id, ref] of preset?.refs ?? []) {
        if (!refs.has(id)) refs.set(id, ref)
      }
      const pre: Record<string, Selection> = preset ? { ...preset.sel } : {}
      if (!preset) {
        for (const s of suggestParams(comfyJson)) {
          pre[`${s.nodeId}.${s.inputName}`] = { key: s.key, type: s.type }
        }
      }

      setJson(comfyJson)
      setRows(inputs)
      setSelected(pre)
      setEnumRefs(refs)
      // 无预选参数的节点默认折叠
      setCollapsed(
        new Set(
          [...new Set(inputs.map((r) => r.nodeId))].filter(
            (id) => !Object.keys(pre).some((k) => k.startsWith(`${id}.`)),
          ),
        ),
      )
      if (!name && sourceName) setName(sourceName)
      return true
    } catch (e) {
      if (seq === importSeq.current) {
        setError(apiErrorMessage(e))
      }
      return false
    } finally {
      if (seq === importSeq.current) {
        setBusy(false)
      }
    }
  }

  async function onFile(file: File) {
    try {
      if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
        const meta = extractComfyMetadata(await file.arrayBuffer())
        const text = meta.prompt ?? meta.workflow // 优先 API 格式,免转换
        if (!text) {
          setError('该 PNG 不含 ComfyUI 元数据')
          return
        }
        await ingest(JSON.parse(text), file.name.replace(/\.png$/i, ''))
      } else {
        await ingest(JSON.parse(await file.text()), file.name.replace(/\.json$/i, ''))
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        setError('JSON 解析失败:文件内容(或 PNG 内嵌 workflow)不是合法 JSON')
      } else {
        setError(e instanceof Error ? e.message : '导入失败')
      }
    }
  }

  async function importPaste() {
    let parsed: unknown
    try {
      parsed = JSON.parse(pasteText)
    } catch {
      setError('JSON 解析失败,请检查粘贴的内容')
      return
    }
    if (await ingest(parsed, '')) setPasteOpen(false)
  }

  const save = useMutation({
    mutationFn: () => {
      const params: ParamDef[] = rows
        .filter((r) => selected[rowId(r)])
        .map((r) => {
          const sel = selected[rowId(r)]!
          return {
            key: sel.key,
            label: sel.key,
            nodeId: r.nodeId,
            inputName: r.inputName,
            type: sel.type,
            default: r.value,
            ...(sel.type === 'enum' && sel.enumRef ? { enumRef: sel.enumRef } : {}),
          }
        })
      return api('/templates', {
        method: 'POST',
        body: JSON.stringify({ name, comfyJson: json, params }),
      })
    },
    onSuccess: () => navigate('/templates'),
    onError: (e) => setError(apiErrorMessage(e)),
  })

  const chosenCount = Object.keys(selected).length
  const keys = rows.filter((r) => selected[rowId(r)]).map((r) => selected[rowId(r)]!.key)
  const hasDuplicateKeys = new Set(keys).size !== keys.length

  const q = query.trim().toLowerCase()
  const nodeTitle = (nodeId: string, classType: string) =>
    String(json?.[nodeId]?._meta?.title ?? classType)
  const visibleRows = rows.filter(
    (r) =>
      !q ||
      [r.nodeId, r.classType, r.inputName, String(r.value), nodeTitle(r.nodeId, r.classType)].some(
        (s) => s.toLowerCase().includes(q),
      ),
  )
  const rank = (r: NodeInputRow) => {
    if (selected[rowId(r)]) return -1
    const p = PRIORITY.indexOf(r.inputName)
    return p === -1 ? PRIORITY.length : p
  }
  const groups: Array<[string, NodeInputRow[]]> = []
  {
    const m = new Map<string, NodeInputRow[]>()
    for (const r of visibleRows) {
      if (!m.has(r.nodeId)) {
        m.set(r.nodeId, [])
        groups.push([r.nodeId, m.get(r.nodeId)!])
      }
      m.get(r.nodeId)!.push(r)
    }
    for (const [, list] of groups) list.sort((a, b) => rank(a) - rank(b))
  }

  function toggleRow(r: NodeInputRow, checked: boolean) {
    const id = rowId(r)
    setSelected((prev) => {
      const next = { ...prev }
      if (checked) {
        const ref = enumRefs.get(id)
        next[id] = ref
          ? { key: r.inputName, type: 'enum', enumRef: ref }
          : { key: r.inputName, type: guessType(r) }
      } else {
        delete next[id]
      }
      return next
    })
  }

  return (
    <div
      className="space-y-6"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        if (busy) return
        const f = e.dataTransfer.files?.[0]
        if (f) void onFile(f)
      }}
    >
      <h1 className="text-xl font-semibold">导入 Workflow</h1>
      <p className="text-sm text-muted-foreground">
        支持 UI 格式 / API 格式 JSON、ComfyUI 生成的 PNG(可直接拖拽到页面),或粘贴 JSON 文本。
      </p>
      <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-4">
        <Input
          type="file"
          accept=".json,.png"
          className="w-72"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
            e.target.value = '' // 重选同一文件也要触发
          }}
        />
        <Button variant="outline" onClick={() => setPasteOpen((v) => !v)}>
          粘贴 JSON
        </Button>
        <Input
          placeholder="模板名称"
          className="w-72"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {pasteOpen && (
        <div className="space-y-2">
          <Textarea
            rows={8}
            placeholder="粘贴 ComfyUI 导出的 workflow JSON(UI 或 API 格式均可)"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <Button size="sm" onClick={() => void importPaste()} disabled={!pasteText.trim() || busy}>
            解析
          </Button>
        </div>
      )}
      {busy && <p className="text-sm text-muted-foreground">解析中…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {validation?.skipped && (
        <p className="text-sm text-muted-foreground">⚠ 未校验(ComfyUI 离线),模型存在性将在运行时才能发现</p>
      )}
      {validation && validation.warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {validation.warnings.map((w, i) => (
            <p key={i}>
              ⚠ 节点 {w.nodeId} {w.classType}
              {w.inputName ? `.${w.inputName}` : ''}:{w.value ? `"${w.value}" ` : ''}
              {w.message}
            </p>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex items-center gap-4">
            <Input
              placeholder="搜索节点 / 输入名 / 当前值…"
              className="w-72"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              勾选要作为批量参数的输入并命名(其余保持导入时的值)
            </p>
          </div>

          <div className="space-y-3">
            {groups.map(([nodeId, groupRows]) => {
              const title = nodeTitle(nodeId, groupRows[0]!.classType)
              const isCollapsed = !q && collapsed.has(nodeId)
              const chosenInGroup = groupRows.filter((r) => selected[rowId(r)]).length
              return (
                <div key={nodeId} className="rounded-md border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-4 py-2 text-left"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev)
                        if (next.has(nodeId)) next.delete(nodeId)
                        else next.add(nodeId)
                        return next
                      })
                    }
                  >
                    <span className="text-sm font-medium">
                      #{nodeId} · {title}
                      {title !== groupRows[0]!.classType && (
                        <span className="ml-2 text-xs text-muted-foreground">{groupRows[0]!.classType}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {chosenInGroup > 0 ? `已选 ${chosenInGroup} · ` : ''}
                      {isCollapsed ? '展开' : '收起'}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="divide-y overflow-x-auto border-t">
                      {groupRows.map((r) => {
                        const id = rowId(r)
                        const sel = selected[id]
                        const typeOptions: ParamType[] = enumRefs.has(id)
                          ? ['enum', 'text', 'number', 'seed', 'image']
                          : ['text', 'number', 'seed', 'image']
                        return (
                          <div key={id} className="flex min-w-fit items-center gap-3 px-4 py-2">
                            <input
                              type="checkbox"
                              checked={!!sel}
                              onChange={(e) => toggleRow(r, e.target.checked)}
                            />
                            <span className="w-40 truncate text-sm">{r.inputName}</span>
                            <span className="w-56 truncate text-sm text-muted-foreground" title={String(r.value)}>
                              {String(r.value)}
                            </span>
                            {sel && (
                              <>
                                <Input
                                  className="h-8 w-36"
                                  value={sel.key}
                                  onChange={(e) =>
                                    setSelected((prev) => ({ ...prev, [id]: { ...sel, key: e.target.value } }))
                                  }
                                />
                                <Select
                                  value={sel.type}
                                  onValueChange={(v) =>
                                    setSelected((prev) => ({
                                      ...prev,
                                      [id]: {
                                        ...sel,
                                        type: v as ParamType,
                                        enumRef: v === 'enum' ? enumRefs.get(id) : undefined,
                                      },
                                    }))
                                  }
                                >
                                  <SelectTrigger className="h-8 w-28">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {typeOptions.map((t) => (
                                      <SelectItem key={t} value={t}>
                                        {t}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {hasDuplicateKeys && <p className="text-sm text-destructive">参数 key 重复,请修改后再保存</p>}
          <Button
            disabled={!name || chosenCount === 0 || save.isPending || hasDuplicateKeys}
            onClick={() => save.mutate()}
          >
            保存模板({chosenCount} 个参数)
          </Button>
        </>
      )}
    </div>
  )
}
