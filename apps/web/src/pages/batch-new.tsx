import { useMutation, useQuery } from '@tanstack/react-query'
import Papa from 'papaparse'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { expandMatrix, type ParamValues } from '@cwe/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ImageValueControl } from '@/components/image-value-control'
import { api } from '@/lib/api'
import { useInputOptions } from '@/hooks/use-input-options'
import type { TemplateDto } from '@/pages/templates'
import type { ParamDef } from '@cwe/shared'

export default function BatchNewPage() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateDto[]>('/templates'),
  })
  const [templateId, setTemplateId] = useState(search.get('template') ?? '')
  const template = templates.find((t) => String(t.id) === templateId)
  const [name, setName] = useState('')
  const [jobs, setJobs] = useState<ParamValues[]>([])
  const [error, setError] = useState('')

  const submit = useMutation({
    mutationFn: () =>
      api<{ id: number }>(`/templates/${templateId}/batches`, {
        method: 'POST',
        body: JSON.stringify({ name: name || `batch-${Date.now()}`, jobs }),
      }),
    onSuccess: (b) => navigate(`/batches/${b.id}`),
    onError: (e) => setError(e.message),
  })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New Batch</h1>
      <div className="flex items-end gap-4">
        <div className="space-y-1">
          <Label>模板</Label>
          <Select value={templateId} onValueChange={(v) => { setTemplateId(v); setJobs([]) }}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="选择模板" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Batch 名称</Label>
          <Input className="w-64" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      {template && (
        <Tabs key={template.id} defaultValue="table" onValueChange={() => setJobs([])}>
          <TabsList>
            <TabsTrigger value="table">表格 / CSV</TabsTrigger>
            <TabsTrigger value="matrix">矩阵组合</TabsTrigger>
            <TabsTrigger value="images">批量图片</TabsTrigger>
          </TabsList>
          <TabsContent value="table">
            <TableEntry template={template} onChange={setJobs} />
          </TabsContent>
          <TabsContent value="matrix">
            <MatrixEntry template={template} onChange={setJobs} />
          </TabsContent>
          <TabsContent value="images">
            <ImagesEntry template={template} onChange={setJobs} />
          </TabsContent>
        </Tabs>
      )}

      {jobs.length > 0 && template && (
        <div className="space-y-2 rounded-md border p-4">
          <p className="text-sm font-medium">预览：共 {jobs.length} 个任务（最多显示 20 行）</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                {template.params.map((p) => (
                  <TableHead key={p.key}>{p.key}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.slice(0, 20).map((row, i) => (
                <TableRow key={i}>
                  <TableCell>{i}</TableCell>
                  {template.params.map((p) => (
                    <TableCell key={p.key} className="max-w-48 truncate">
                      {String(row[p.key] ?? p.default ?? '')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
            提交 {jobs.length} 个任务
          </Button>
        </div>
      )}
    </div>
  )
}

function TableEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const [rows, setRows] = useState<ParamValues[]>([{}])
  const [csvOpen, setCsvOpen] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [error, setError] = useState('')

  function update(next: ParamValues[]) {
    setRows(next)
    onChange(next.filter((r) => Object.keys(r).length > 0))
  }

  function importCsv() {
    const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
      header: true,
      skipEmptyLines: true,
    })
    const keys = new Set(template.params.map((p) => p.key))
    const imported = parsed.data.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k, v]) => keys.has(k) && v !== '')),
    )
    if (imported.filter((r) => Object.keys(r).length > 0).length === 0) {
      setError(`CSV 无匹配数据：表头需与参数 key 一致（${template.params.map((p) => p.key).join(', ')}）`)
      return
    }
    setError('')
    update(imported)
    setCsvOpen(false)
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            {template.params.map((p) => (
              <TableHead key={p.key}>{p.key}</TableHead>
            ))}
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {template.params.map((p) => (
                <TableCell key={p.key}>
                  {p.type === 'image' ? (
                    <ImageValueControl
                      value={String(row[p.key] ?? '')}
                      placeholder={String(p.default ?? '')}
                      onChange={(v) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, [p.key]: v } : r))
                        update(next)
                      }}
                    />
                  ) : p.type === 'enum' ? (
                    <EnumValueSelect
                      param={p}
                      value={String(row[p.key] ?? '')}
                      onChange={(v) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, [p.key]: v } : r))
                        update(next)
                      }}
                    />
                  ) : (
                    <Input
                      className="h-8"
                      placeholder={String(p.default ?? '')}
                      value={String(row[p.key] ?? '')}
                      onChange={(e) => {
                        const next = rows.map((r, j) =>
                          j === i ? { ...r, [p.key]: e.target.value } : r,
                        )
                        update(next)
                      }}
                    />
                  )}
                </TableCell>
              ))}
              <TableCell>
                <Button size="sm" variant="ghost" onClick={() => update(rows.filter((_, j) => j !== i))}>
                  ✕
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => update([...rows, {}])}>
          + 加一行
        </Button>
        <Button size="sm" variant="outline" onClick={() => setCsvOpen((v) => !v)}>
          粘贴 CSV
        </Button>
      </div>
      {csvOpen && (
        <div className="space-y-2">
          <Textarea
            rows={6}
            placeholder={`表头需与参数 key 一致，如：\n${template.params.map((p) => p.key).join(',')}\n...`}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <Button size="sm" onClick={importCsv}>
            导入
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </div>
  )
}

function MatrixEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const [axes, setAxes] = useState<Record<string, string>>({})

  const parsed = useMemo(() => {
    const out: Record<string, Array<string | number>> = {}
    for (const p of template.params) {
      const lines = (axes[p.key] ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      out[p.key] =
        p.type === 'number' || p.type === 'seed' ? lines.map(Number).filter((n) => !Number.isNaN(n)) : lines
    }
    return out
  }, [axes, template])

  const count = Object.values(parsed).reduce((acc, v) => acc * Math.max(v.length, 1), 1)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {template.params.map((p) => (
          <div key={p.key} className="space-y-1">
            <Label>
              {p.key}（{p.type}，一行一个值{p.default !== undefined ? `，留空用默认 ${p.default}` : ''}）
            </Label>
            {p.type === 'enum' ? (
              <EnumAxisPick
                param={p}
                text={axes[p.key] ?? ''}
                onChange={(v) => setAxes((prev) => ({ ...prev, [p.key]: v }))}
              />
            ) : (
              <Textarea
                rows={4}
                value={axes[p.key] ?? ''}
                onChange={(e) => setAxes((prev) => ({ ...prev, [p.key]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <Button size="sm" onClick={() => onChange(expandMatrix(parsed))}>
        生成组合（约 {count} 个任务）
      </Button>
    </div>
  )
}

function ImagesEntry({
  template,
  onChange,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
}) {
  const imageParams = template.params.filter((p) => p.type === 'image')
  const otherParams = template.params.filter((p) => p.type !== 'image')
  const [imageKey, setImageKey] = useState(imageParams[0]?.key ?? '')
  const [shared, setShared] = useState<ParamValues>({})
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  async function onFiles(files: FileList) {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      onChange(stored.map((s) => ({ ...shared, [imageKey]: s.stored })))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  if (imageParams.length === 0) {
    return <p className="text-sm text-muted-foreground">该模板没有 image 类型参数</p>
  }

  return (
    <div className="space-y-4">
      {imageParams.length > 1 && (
        <div className="space-y-1">
          <Label>图片填充到哪个参数</Label>
          <Select value={imageKey} onValueChange={setImageKey}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {imageParams.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        {otherParams.map((p) => (
          <div key={p.key} className="space-y-1">
            <Label>{p.key}（所有任务共享）</Label>
            {p.type === 'enum' ? (
              <EnumValueSelect
                param={p}
                value={String(shared[p.key] ?? '')}
                onChange={(v) => setShared((prev) => ({ ...prev, [p.key]: v }))}
              />
            ) : (
              <Input
                placeholder={String(p.default ?? '')}
                value={String(shared[p.key] ?? '')}
                onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <Input
        type="file"
        multiple
        accept="image/*"
        disabled={uploading}
        onChange={(e) => e.target.files?.length && onFiles(e.target.files)}
      />
      {uploading && <p className="text-sm text-muted-foreground">上传中…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

/** input-options 失败时的降级提示:优先用服务器返回的错误(离线 503 / 已非枚举 404 文案不同) */
function optionsErrorText(error: unknown, suffix: string): string {
  const msg = error instanceof Error ? error.message : ''
  try {
    const parsed = JSON.parse(msg) as { error?: string }
    if (parsed.error) return `${parsed.error},${suffix}`
  } catch {
    // 非 JSON 报错(网络异常等)走默认文案
  }
  return `ComfyUI 离线,${suffix}`
}

/** enum 参数单选:可选值来自服务器;离线/失败降级为文本输入 */
function EnumValueSelect({
  param,
  value,
  onChange,
}: {
  param: ParamDef
  value: string
  onChange: (v: string) => void
}) {
  const { data, isError, error } = useInputOptions(param)
  if (!data || isError) {
    return (
      <Input
        className="h-8"
        placeholder={isError ? optionsErrorText(error, '手动输入') : String(param.default ?? '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="h-8">
        <SelectValue placeholder={String(param.default ?? '选择…')} />
      </SelectTrigger>
      <SelectContent>
        {data.options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** enum 参数多选(矩阵轴):勾选项以换行拼接写回 axes,复用现有解析 */
function EnumAxisPick({
  param,
  text,
  onChange,
}: {
  param: ParamDef
  text: string
  onChange: (v: string) => void
}) {
  const { data, isError, error } = useInputOptions(param)
  if (!data || isError) {
    return (
      <Textarea
        rows={4}
        placeholder={isError ? optionsErrorText(error, '一行一个值') : undefined}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  const chosen = new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
      {data.options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.has(o)}
            onChange={(e) => {
              const next = new Set(chosen)
              if (e.target.checked) next.add(o)
              else next.delete(o)
              onChange([...next].join('\n'))
            }}
          />
          <span className="truncate" title={o}>
            {o}
          </span>
        </label>
      ))}
    </div>
  )
}
