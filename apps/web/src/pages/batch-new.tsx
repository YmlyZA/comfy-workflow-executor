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
import { api } from '@/lib/api'
import type { TemplateDto } from '@/pages/templates'

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
        <Tabs defaultValue="table" onValueChange={() => setJobs([])}>
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
            <Textarea
              rows={4}
              value={axes[p.key] ?? ''}
              onChange={(e) => setAxes((prev) => ({ ...prev, [p.key]: e.target.value }))}
            />
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

  async function onFiles(files: FileList) {
    setUploading(true)
    try {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      onChange(stored.map((s) => ({ ...shared, [imageKey]: s.stored })))
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
            <Input
              placeholder={String(p.default ?? '')}
              value={String(shared[p.key] ?? '')}
              onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
            />
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
    </div>
  )
}
