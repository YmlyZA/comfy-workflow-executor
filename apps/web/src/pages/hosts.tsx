import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  activateHost,
  createHost,
  deleteHost,
  disableHost,
  enableHost,
  fetchHostStatsById,
  fetchHosts,
  testHost,
  updateHost,
  type HostDto,
  type HostTestResult,
  type HostWritable,
  errorMessage,
} from '@/lib/api'
import { formatDuration, rentalCost, rentalMinutes, toLocalDatetimeInput } from '@/lib/hosts'
import { cn } from '@/lib/utils'

export default function HostsPage() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts })
  const hosts = data?.hosts ?? []

  const [editing, setEditing] = useState<HostDto | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<HostDto | null>(null)
  const [disabling, setDisabling] = useState<HostDto | null>(null)
  const [testResults, setTestResults] = useState<Record<number, HostTestResult | 'testing'>>({})

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['hosts'] })
  const onError = (e: unknown) => toast.error(errorMessage(e))

  const create = useMutation({
    mutationFn: (input: HostWritable) => createHost(input),
    onSuccess: () => {
      toast.success('已创建')
      setCreating(false)
      invalidate()
    },
    onError,
  })
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & HostWritable) => updateHost(id, patch),
    onSuccess: () => {
      toast.success('已保存')
      setEditing(null)
      invalidate()
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: deleteHost,
    onSuccess: () => {
      toast.success('已删除')
      setDeleting(null)
      invalidate()
    },
    onError,
  })
  // 设为参考主机:只影响节点/模型/文件列表查询走哪台主机,不影响任何 worker,故无需模式选择。
  const activate = useMutation({
    mutationFn: (id: number) => activateHost(id),
    onSuccess: () => {
      toast.success('已设为参考主机')
      invalidate()
    },
    onError,
  })
  const enable = useMutation({
    mutationFn: (id: number) => enableHost(id),
    onSuccess: () => {
      toast.success('已加入调度')
      invalidate()
    },
    onError,
  })
  const disable = useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: 'wait' | 'interrupt' }) => disableHost(id, mode),
    onSuccess: () => {
      toast.success('已停用调度')
      setDisabling(null)
      invalidate()
    },
    onError,
  })

  async function runTest(id: number) {
    setTestResults((prev) => ({ ...prev, [id]: 'testing' }))
    try {
      const r = await testHost(id)
      setTestResults((prev) => ({ ...prev, [id]: r }))
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: { reachable: false } }))
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold">GPU 主机</h1>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">主机列表</p>
          <Button size="sm" onClick={() => setCreating(true)}>新增主机</Button>
        </div>
        <div className="space-y-2">
          {hosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              testResult={testResults[h.id]}
              onTest={() => void runTest(h.id)}
              onEdit={() => setEditing(h)}
              onRequestDelete={() => setDeleting(h)}
              onActivate={() => activate.mutate(h.id)}
              activatePending={activate.isPending}
              onEnable={() => enable.mutate(h.id)}
              enablePending={enable.isPending}
              onRequestDisable={() => setDisabling(h)}
            />
          ))}
          {hosts.length === 0 && <p className="text-sm text-muted-foreground">暂无主机</p>}
        </div>
      </section>

      <HostForm
        open={creating}
        title="新增主机"
        pending={create.isPending}
        onSubmit={(v) => create.mutate(v)}
        onClose={() => setCreating(false)}
      />
      <HostForm
        open={editing !== null}
        title={`编辑 ${editing?.name ?? ''}`}
        initial={editing ?? undefined}
        pending={update.isPending}
        onSubmit={(v) => editing && update.mutate({ id: editing.id, ...v })}
        onClose={() => setEditing(null)}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          {deleting != null && deleting.pinnedBatches > 0 && (
            <p className="text-sm text-warning">
              有 {deleting.pinnedBatches} 个未完成批次锁定在这台主机上，删除后它们将无人执行。
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={disabling !== null} onOpenChange={(v) => !v && setDisabling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用「{disabling?.name}」的调度</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            停用后该主机不再接新任务。它当前正在执行的任务如何处理？
          </p>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              disabled={disable.isPending}
              onClick={() => disabling && disable.mutate({ id: disabling.id, mode: 'wait' })}
            >
              等当前任务跑完
            </Button>
            <Button
              variant="destructive"
              disabled={disable.isPending}
              onClick={() => disabling && disable.mutate({ id: disabling.id, mode: 'interrupt' })}
            >
              立即放弃并重排
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function HostCard({
  host,
  testResult,
  onTest,
  onEdit,
  onRequestDelete,
  onActivate,
  activatePending,
  onEnable,
  enablePending,
  onRequestDisable,
}: {
  host: HostDto
  testResult: HostTestResult | 'testing' | undefined
  onTest: () => void
  onEdit: () => void
  onRequestDelete: () => void
  onActivate: () => void
  activatePending: boolean
  onEnable: () => void
  enablePending: boolean
  onRequestDisable: () => void
}) {
  // 每主机独立探测,离线/未探测过的主机不发请求
  const { data: stats } = useQuery({
    queryKey: ['host-stats', host.id],
    queryFn: () => fetchHostStatsById(host.id),
    enabled: host.online === true,
    staleTime: 30_000,
  })

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex size-2 shrink-0 rounded-full',
            host.online === true ? 'bg-success' : host.online === false ? 'bg-destructive' : 'bg-muted-foreground',
          )}
        />
        <span className="font-medium">{host.name}</span>
        {host.active === 1 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">参考主机</span>
        )}
        {host.enabled !== 1 && host.disabledReason && (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
            已自动停用：{host.disabledReason}
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">{host.url}</span>
        {host.note && <span className="text-xs text-muted-foreground">{host.note}</span>}
      </div>

      {host.kind === 'rental' && host.rentedAt && (
        <p className="text-xs text-muted-foreground">
          已运行 {formatDuration(rentalMinutes(host.rentedAt, Date.now()))}
          {host.hourlyRate != null &&
            ` · 估算 ${rentalCost(host.rentedAt, host.hourlyRate, Date.now())!.toFixed(2)}`}
        </p>
      )}

      {stats?.online && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <div><dt className="text-muted-foreground">GPU</dt><dd>{stats.gpuName ?? '—'}</dd></div>
          <div>
            <dt className="text-muted-foreground">显存</dt>
            <dd>{stats.vramFreeMB != null ? `${stats.vramFreeMB} MB 空闲 / ` : ''}{stats.vramTotalMB ?? '—'} MB</dd>
          </div>
          <div><dt className="text-muted-foreground">ComfyUI</dt><dd>{stats.comfyuiVersion ?? '—'}</dd></div>
          <div><dt className="text-muted-foreground">Python</dt><dd>{stats.pythonVersion ?? '—'}</dd></div>
          <div><dt className="text-muted-foreground">队列</dt><dd>{stats.queueRunning} 运行 / {stats.queuePending} 排队</dd></div>
          <div><dt className="text-muted-foreground">cwe 扩展</dt><dd>{stats.cwe ? '已安装' : '未安装'}</dd></div>
        </dl>
      )}

      {testResult && testResult !== 'testing' && (
        <p className="text-xs text-muted-foreground">
          {testResult.reachable
            ? `可达 ${testResult.latencyMs}ms · ${testResult.gpuName ?? '未知 GPU'} · ${testResult.vramTotalMB ?? '?'} MB · cwe ${testResult.cwe ? '已装' : '未装'}`
            : '不可达'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" disabled={testResult === 'testing'} onClick={onTest}>
          {testResult === 'testing' ? <Loader2Icon className="size-4 animate-spin" /> : '测试'}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>编辑</Button>
        <Button size="sm" variant="outline" disabled={host.active === 1} onClick={onRequestDelete}>删除</Button>
        <Button size="sm" variant="outline" disabled={host.active === 1 || activatePending} onClick={onActivate}>
          设为参考主机
        </Button>
        {host.enabled === 1 ? (
          <Button size="sm" variant="outline" onClick={onRequestDisable}>
            停用调度
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={enablePending} onClick={onEnable}>
            参与调度
          </Button>
        )}
      </div>
    </div>
  )
}

function HostForm({
  open,
  title,
  initial,
  pending,
  onSubmit,
  onClose,
}: {
  open: boolean
  title: string
  initial?: HostDto
  pending: boolean
  onSubmit: (v: HostWritable) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [kind, setKind] = useState<'resident' | 'rental'>('resident')
  const [rentedAt, setRentedAt] = useState('')
  const [hourlyRate, setHourlyRate] = useState('')
  // Dialog 每次打开时同步初始值
  const [seeded, setSeeded] = useState(false)
  if (open && !seeded) {
    setName(initial?.name ?? '')
    setUrl(initial?.url ?? '')
    setNote(initial?.note ?? '')
    setKind(initial?.kind ?? 'resident')
    setRentedAt(initial?.rentedAt ? toLocalDatetimeInput(initial.rentedAt) : '')
    setHourlyRate(initial?.hourlyRate != null ? String(initial.hourlyRate) : '')
    setSeeded(true)
  }
  if (!open && seeded) setSeeded(false)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="host-name">名称</Label>
            <Input id="host-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如:本机 4090" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="host-url">URL</Label>
            <Input id="host-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:8188" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="host-note">备注（可选）</Label>
            <Input id="host-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如:RunPod 按小时" />
          </div>
          <div className="space-y-1">
            <Label>形态</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as 'resident' | 'rental')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="resident">常驻</SelectItem>
                <SelectItem value="rental">按小时租用</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === 'rental' && (
            <>
              <div className="space-y-1">
                <Label>起租时间</Label>
                <Input type="datetime-local" value={rentedAt} onChange={(e) => setRentedAt(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>时薪（选填，不填只显示时长）</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={pending || !name.trim() || !url.trim()}
            // 备注清空要发 null:undefined 会被 JSON.stringify 丢键,服务端保留旧备注
            onClick={() =>
              onSubmit({
                name: name.trim(),
                url: url.trim(),
                note: note.trim() || null,
                kind,
                rentedAt: kind === 'rental' ? new Date(rentedAt || Date.now()).toISOString() : null,
                hourlyRate: kind === 'rental' && hourlyRate !== '' ? Number(hourlyRate) : null,
              })
            }
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
