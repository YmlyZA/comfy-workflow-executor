import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import Papa from 'papaparse'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { computeLockedDim, fitSource, type ParamValues } from '@cwe/shared'
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
import { EnumValueSelect } from '@/components/enum-value-select'
import { ImageMultiPick } from '@/components/image-multi-pick'
import { ImageValueControl } from '@/components/image-value-control'
import { TextValueControl } from '@/components/text-value-control'
import { MatrixEntry } from '@/components/matrix-entry'
import { api } from '@/lib/api'
import { useImageDims } from '@/hooks/use-image-dims'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import type { TemplateDto } from '@/pages/templates'
import type { ParamDef } from '@cwe/shared'
import type { BatchDetailDto } from '@/pages/batch-detail'

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
  const [fromError, setFromError] = useState('')
  const [initialRows, setInitialRows] = useState<ParamValues[] | undefined>(undefined)
  const from = search.get('from')
  const fromBatch = useQuery({
    queryKey: ['batches', from],
    queryFn: () => api<BatchDetailDto>(`/batches/${from}`),
    enabled: from !== null,
  })
  const fromLoaded = useRef(false)
  useEffect(() => {
    if (from === null || fromLoaded.current) return
    if (fromBatch.isError) {
      fromLoaded.current = true
      setFromError(`加载来源 batch 失败(from=${from}),可手动选择模板继续`)
      return
    }
    if (!fromBatch.data) return
    fromLoaded.current = true
    const d = fromBatch.data
    setTemplateId(String(d.template.id))
    setName((prev) => prev || `${d.batch.name} 副本`)
    setInitialRows(d.jobs.map((j) => j.params))
  }, [from, fromBatch.data, fromBatch.isError])

  const qc = useQueryClient()
  const submit = useMutation({
    mutationFn: () =>
      api<{ id: number }>(`/templates/${templateId}/batches`, {
        method: 'POST',
        body: JSON.stringify({ name: name || `batch-${Date.now()}`, jobs }),
      }),
    onSuccess: (b) => {
      // 建批会在服务端写入输入历史,失效所有 key 的历史缓存
      void qc.invalidateQueries({ queryKey: ['input-history'] })
      navigate(`/batches/${b.id}`)
    },
    onError: (e) => setError(e.message),
  })

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">New Batch</h1>
      <div className="flex items-end gap-4 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <Label>模板</Label>
          <Select value={templateId} onValueChange={(v) => { setTemplateId(v); setJobs([]); setInitialRows(undefined) }}>
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
      {fromError && <p className="text-sm text-destructive">{fromError}</p>}

      {template && (
        <Tabs key={template.id} defaultValue="table" onValueChange={() => setJobs([])}>
          <TabsList>
            <TabsTrigger value="table">表格 / CSV</TabsTrigger>
            <TabsTrigger value="matrix">矩阵组合</TabsTrigger>
            <TabsTrigger value="images">批量图片</TabsTrigger>
          </TabsList>
          <TabsContent value="table">
            <TableEntry template={template} onChange={setJobs} initialRows={initialRows} />
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
        <div className="space-y-3 rounded-lg border bg-card p-4">
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
  initialRows,
}: {
  template: TemplateDto
  onChange: (jobs: ParamValues[]) => void
  initialRows?: ParamValues[]
}) {
  const [rows, setRows] = useState<ParamValues[]>(initialRows ?? [{}])
  const [csvOpen, setCsvOpen] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [error, setError] = useState('')
  const dimPair = findDimPair(template.params)
  const imageParam = template.params.find((p) => p.type === 'image')
  const [sizeMode, setSizeMode] = useState<SizeMode>('default')
  const [capText, setCapText] = useState('')

  // rows → jobs 同步(过滤空行);全量 update 与函数式 patchRow 都经这里通知父级
  useEffect(() => {
    onChange(rows.filter((r) => Object.keys(r).length > 0))
  }, [rows, onChange])

  function update(next: ParamValues[]) {
    setRows(next)
  }

  /** 行内补丁:函数式更新,同一批次多个 SourceDimCell 补丁不会互相覆盖 */
  function patchRow(i: number, patch: Record<string, string | number>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
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
    <div className="space-y-3">
      {dimPair && imageParam && (
        <div className="flex items-center gap-2 text-sm">
          <Label>输出尺寸</Label>
          <Select value={sizeMode} onValueChange={(v) => setSizeMode(v as SizeMode)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">模板默认</SelectItem>
              <SelectItem value="ratio">锁定比例（填一边自动算另一边）</SelectItem>
              <SelectItem value="source">跟随源图（选图自动填宽高）</SelectItem>
            </SelectContent>
          </Select>
          {sizeMode === 'source' && (
            <Input
              className="w-56"
              type="number"
              min={8}
              placeholder="最长边上限（留空=与源图一致）"
              value={capText}
              onChange={(e) => setCapText(e.target.value)}
            />
          )}
        </div>
      )}
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
                  ) : sizeMode === 'ratio' && dimPair && imageParam && (p.key === dimPair.width.key || p.key === dimPair.height.key) ? (
                    <DimCell
                      p={p}
                      otherKey={p.key === dimPair.width.key ? dimPair.height.key : dimPair.width.key}
                      driver={p.key === dimPair.width.key ? 'width' : 'height'}
                      imageName={String(row[imageParam.key] ?? imageParam.default ?? '')}
                      locked={sizeMode === 'ratio'}
                      value={String(row[p.key] ?? '')}
                      onPatch={(patch) => patchRow(i, patch)}
                    />
                  ) : sizeMode === 'source' && dimPair && imageParam && p.key === dimPair.width.key ? (
                    <SourceDimCell
                      p={p}
                      heightKey={dimPair.height.key}
                      imageName={String(row[imageParam.key] ?? '')}
                      cap={parseCap(capText)}
                      value={String(row[p.key] ?? '')}
                      onPatch={(patch) => patchRow(i, patch)}
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
                  ) : p.type === 'text' ? (
                    <TextValueControl
                      paramKey={p.key}
                      placeholder={String(p.default ?? '')}
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
  const [selected, setSelected] = useState<string[]>([])
  const [dimsWarning, setDimsWarning] = useState('')

  // findDimPair 每渲染返回新对象,memo 化避免派生 effect 每渲染重跑
  const dimPair = useMemo(() => findDimPair(template.params), [template.params])
  const [sizeMode, setSizeMode] = useState<SizeMode>('default')
  const [driver, setDriver] = useState<'width' | 'height'>('width')
  const [driverValue, setDriverValue] = useState('')
  const [capText, setCapText] = useState('')

  const n = Number(driverValue)
  const ratioInvalid = sizeMode === 'ratio' && (!driverValue || Number.isNaN(n) || n <= 0)
  const needDims = sizeMode !== 'default' && !!dimPair && !ratioInvalid

  const dimQueries = useQueries({
    queries: selected.map((name) => ({
      queryKey: ['image-dims', name],
      enabled: needDims,
      queryFn: () =>
        api<{ width: number; height: number }>(
          `/comfy/image-dims?name=${encodeURIComponent(name)}`,
        ),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })
  const settled = dimQueries.every((q) => q.isSuccess || q.isError)
  // useQueries 每渲染返回新数组,不能直接进 effect 依赖;结果压成字符串键,内容不变不重算
  const dimsKey = JSON.stringify(
    dimQueries.map((q) =>
      q.isSuccess ? [q.data.width, q.data.height] : q.isError ? 'err' : 'pending',
    ),
  )
  const probing = needDims && selected.length > 0 && !settled

  useEffect(() => {
    if (selected.length === 0 || !imageKey) {
      onChange([])
      return
    }
    if (sizeMode === 'default' || !dimPair) {
      setDimsWarning('')
      onChange(selected.map((s) => ({ ...shared, [imageKey]: s })))
      return
    }
    if (ratioInvalid || !settled) {
      onChange([])
      return
    }
    let failed = 0
    const jobs = selected.map((s, i) => {
      const q = dimQueries[i]!
      const base: ParamValues = { ...shared, [imageKey]: s }
      delete base[dimPair.width.key]
      delete base[dimPair.height.key]
      if (q.isSuccess) {
        const d =
          sizeMode === 'ratio'
            ? computeLockedDim(q.data, driver, n)
            : fitSource(q.data, parseCap(capText))
        return { ...base, [dimPair.width.key]: d.width, [dimPair.height.key]: d.height }
      }
      failed++
      return base // 宽高留空 → 提交时用模板默认值
    })
    setDimsWarning(failed > 0 ? `${failed} 张图未能获取尺寸，已用模板默认宽高` : '')
    onChange(jobs)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimQueries 的内容变化已由 dimsKey 表达
  }, [selected, shared, imageKey, sizeMode, driver, driverValue, capText, dimsKey, settled, ratioInvalid, dimPair, onChange])

  if (imageParams.length === 0) {
    return <p className="text-sm text-muted-foreground">该模板没有 image 类型参数</p>
  }

  return (
    <div className="space-y-3">
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
      {dimPair && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Label>输出尺寸</Label>
            <Select value={sizeMode} onValueChange={(v) => setSizeMode(v as SizeMode)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">模板默认</SelectItem>
                <SelectItem value="ratio">锁定比例（填一边）</SelectItem>
                <SelectItem value="source">跟随源图</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {sizeMode === 'ratio' && (
            <div className="flex items-center gap-2">
              <Select value={driver} onValueChange={(v) => setDriver(v as 'width' | 'height')}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="width">按宽定高</SelectItem>
                  <SelectItem value="height">按高定宽</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="w-32"
                placeholder={String(
                  (driver === 'width' ? dimPair.width : dimPair.height).default ?? '',
                )}
                value={driverValue}
                onChange={(e) => setDriverValue(e.target.value)}
              />
              <Input className="w-40" disabled placeholder="另一维自动（按源图比例）" value="" readOnly />
            </div>
          )}
          {sizeMode === 'source' && (
            <div className="flex items-center gap-2">
              <Input
                className="w-56"
                type="number"
                min={8}
                placeholder="最长边上限（留空=与源图一致）"
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
              />
              <Input className="w-40" disabled placeholder="宽高自动（跟随源图）" value="" readOnly />
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {otherParams
          .filter(
            (p) =>
              !(
                sizeMode !== 'default' &&
                dimPair &&
                (p.key === dimPair.width.key || p.key === dimPair.height.key)
              ),
          )
          .map((p) => (
            <div key={p.key} className="space-y-1">
              <Label>{p.key}（所有任务共享）</Label>
              {p.type === 'enum' ? (
                <EnumValueSelect
                  param={p}
                  value={String(shared[p.key] ?? '')}
                  onChange={(v) => setShared((prev) => ({ ...prev, [p.key]: v }))}
                />
              ) : p.type === 'text' ? (
                <TextValueControl
                  paramKey={p.key}
                  placeholder={String(p.default ?? '')}
                  value={String(shared[p.key] ?? '')}
                  onChange={(v) => setShared((prev) => ({ ...prev, [p.key]: v }))}
                />
              ) : (
                <Input
                  className="h-8"
                  placeholder={String(p.default ?? '')}
                  value={String(shared[p.key] ?? '')}
                  onChange={(e) => setShared((prev) => ({ ...prev, [p.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
      </div>
      <div className="space-y-1">
        <Label>图片（勾选已有或上传本机，选中即生成任务）</Label>
        <ImageMultiPick value={selected} onChange={setSelected} />
      </div>
      {ratioInvalid && (
        <p className="text-sm text-destructive">锁定比例后需先填写有效的宽或高数值</p>
      )}
      {probing && <p className="text-sm text-muted-foreground">探测尺寸中…</p>}
      {dimsWarning && <p className="text-sm text-muted-foreground">⚠ {dimsWarning}</p>}
    </div>
  )
}

/** 输出尺寸模式:模板默认 / 锁定比例(填一边) / 跟随源图(可选最长边上限) */
type SizeMode = 'default' | 'ratio' | 'source'

/** 最长边上限解析:空/非法/小于 8 视为未填 */
function parseCap(text: string): number | undefined {
  const n = Number(text)
  return text.trim() !== '' && !Number.isNaN(n) && n >= 8 ? n : undefined
}

/** 第一对 inputName 为 width/height 的 number 参数;凑不齐返回 null */
function findDimPair(params: ParamDef[]): { width: ParamDef; height: ParamDef } | null {
  const width = params.find((p) => p.type === 'number' && p.inputName === 'width')
  const height = params.find((p) => p.type === 'number' && p.inputName === 'height')
  return width && height ? { width, height } : null
}

/** image-dims 失败提示:优先服务器错误文案 */
function dimsErrorText(error: unknown): string {
  const msg = error instanceof Error ? error.message : ''
  try {
    const parsed = JSON.parse(msg) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    // 非 JSON 报错走默认文案
  }
  return '无法获取源图尺寸'
}



/** 锁定比例时的宽/高单元格:编辑本格后按该行图片实际比例自动填另一格 */
function DimCell({
  p,
  otherKey,
  driver,
  imageName,
  locked,
  value,
  onPatch,
}: {
  p: ParamDef
  otherKey: string
  driver: 'width' | 'height'
  imageName: string
  locked: boolean
  value: string
  onPatch: (patch: Record<string, string | number>) => void
}) {
  const dims = useImageDims(locked && imageName ? imageName : undefined)
  const failed = locked && !!imageName && dims.isError
  return (
    <div className="space-y-1">
      <Input
        className="h-8"
        placeholder={String(p.default ?? '')}
        value={value}
        onChange={(e) => {
          const raw = e.target.value
          const n = Number(raw)
          if (locked && dims.data && raw !== '' && !Number.isNaN(n) && n > 0) {
            const computed = computeLockedDim(dims.data, driver, n)
            onPatch({
              [p.key]: raw,
              [otherKey]: driver === 'width' ? computed.height : computed.width,
            })
          } else {
            onPatch({ [p.key]: raw })
          }
        }}
      />
      {failed && <p className="text-xs text-muted-foreground">{dimsErrorText(dims.error)}</p>}
    </div>
  )
}

/** 跟随源图模式的宽格:该行图片(或上限)变化后探测尺寸,把宽高两格一起写入;仍可手改 */
function SourceDimCell({
  p,
  heightKey,
  imageName,
  cap,
  value,
  onPatch,
}: {
  p: ParamDef
  heightKey: string
  imageName: string
  cap: number | undefined
  value: string
  onPatch: (patch: Record<string, string | number>) => void
}) {
  const debouncedName = useDebouncedValue(imageName)
  const dims = useImageDims(debouncedName || undefined)
  const patchRef = useRef(onPatch)
  patchRef.current = onPatch
  useEffect(() => {
    if (dims.data) {
      const d = fitSource(dims.data, cap)
      patchRef.current({ [p.key]: d.width, [heightKey]: d.height })
    }
  }, [dims.data, cap, p.key, heightKey])
  const failed = !!imageName && dims.isError
  return (
    <div className="space-y-1">
      <Input
        className="h-8"
        placeholder={String(p.default ?? '')}
        value={value}
        onChange={(e) => onPatch({ [p.key]: e.target.value })}
      />
      {failed && <p className="text-xs text-muted-foreground">{dimsErrorText(dims.error)}</p>}
    </div>
  )
}
