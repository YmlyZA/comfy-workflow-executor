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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useComfyStatus } from '@/hooks/use-comfy-status'
import {
  activateHost,
  api,
  createHost,
  deleteHost,
  fetchHostStats,
  fetchHosts,
  testHost,
  updateHost,
  type HostDto,
  type HostTestResult,
  errorMessage,
} from '@/lib/api'
import type { BatchSummaryDto } from '@/pages/batches'

export default function HostsPage() {
  const qc = useQueryClient()
  const status = useComfyStatus()
  const { data } = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts })
  const { data: stats } = useQuery({
    queryKey: ['host-stats'],
    queryFn: fetchHostStats,
    refetchInterval: 10_000,
  })
  const { data: batches = [] } = useQuery({
    queryKey: ['batches'],
    queryFn: () => api<BatchSummaryDto[]>('/batches'),
  })
  const hasRunning = batches.some((b) => b.status === 'running')

  const [editing, setEditing] = useState<HostDto | null>(null)
  const [creating, setCreating] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<HostDto | null>(null)
  const [testResults, setTestResults] = useState<Record<number, HostTestResult | 'testing'>>({})

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['hosts'] })
    void qc.invalidateQueries({ queryKey: ['host-stats'] })
    void qc.invalidateQueries({ queryKey: ['comfy-status'] })
  }
  const onError = (e: unknown) => toast.error(errorMessage(e))

  const create = useMutation({
    mutationFn: (input: { name: string; url: string; note?: string | null }) => createHost(input),
    onSuccess: () => {
      toast.success('已创建')
      setCreating(false)
      invalidate()
    },
    onError,
  })
  const update = useMutation({
    mutationFn: ({
      id,
      ...patch
    }: { id: number; name?: string; url?: string; note?: string | null }) => updateHost(id, patch),
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
      invalidate()
    },
    onError,
  })
  const activate = useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: 'wait' | 'interrupt' }) => activateHost(id, mode),
    onSuccess: () => {
      toast.success('已切换')
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

  function requestSwitch(host: HostDto) {
    if (hasRunning) setSwitchTarget(host)
    else activate.mutate({ id: host.id, mode: 'wait' })
  }

  const hosts = data?.hosts ?? []
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold">GPU 主机</h1>

      <section className="space-y-2 rounded-md border p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          当前主机
          <Badge variant={status?.online ? 'default' : 'destructive'}>
            {status == null ? '探测中' : status.online ? '在线' : '离线'}
          </Badge>
        </p>
        {stats?.online ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
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
        ) : (
          <p className="text-sm text-muted-foreground">主机离线或不可达，无法获取详情。</p>
        )}
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">主机列表</p>
          <Button size="sm" onClick={() => setCreating(true)}>新增主机</Button>
        </div>
        <div className="space-y-2">
          {hosts.map((h) => {
            const t = testResults[h.id]
            return (
              <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span className="font-medium">{h.name}</span>
                {h.active === 1 && <Badge>当前</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{h.url}</span>
                {h.note && <span className="text-xs text-muted-foreground">{h.note}</span>}
                <span className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="outline" disabled={t === 'testing'} onClick={() => void runTest(h.id)}>
                    {t === 'testing' ? <Loader2Icon className="size-4 animate-spin" /> : '测试'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(h)}>编辑</Button>
                  <Button size="sm" variant="outline" disabled={h.active === 1} onClick={() => remove.mutate(h.id)}>删除</Button>
                  <Button size="sm" disabled={h.active === 1 || activate.isPending} onClick={() => requestSwitch(h)}>切换</Button>
                </span>
                {t && t !== 'testing' && (
                  <p className="w-full text-xs text-muted-foreground">
                    {t.reachable
                      ? `可达 ${t.latencyMs}ms · ${t.gpuName ?? '未知 GPU'} · ${t.vramTotalMB ?? '?'} MB · cwe ${t.cwe ? '已装' : '未装'}`
                      : '不可达'}
                  </p>
                )}
              </div>
            )
          })}
          {hosts.length === 0 && <p className="text-sm text-muted-foreground">暂无主机</p>}
        </div>
      </section>

      {activate.isPending && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
          <Loader2Icon className="size-8 animate-spin" />
          <p className="text-sm font-medium">正在切换主机……</p>
          <p className="text-sm text-muted-foreground">等待模式下会先等当前任务收尾，可能需要几分钟</p>
        </div>
      )}

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

      <AlertDialog open={switchTarget !== null} onOpenChange={(o) => !o && setSwitchTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>切换到 {switchTarget?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              有任务正在运行。「等它跑完」会先等当前任务收尾（可能几分钟）；「立即中断」会打断当前任务并将其重新排队到新主机。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                const h = switchTarget
                setSwitchTarget(null)
                if (h) activate.mutate({ id: h.id, mode: 'wait' })
              }}
            >
              等它跑完
            </Button>
            <AlertDialogAction
              onClick={() => {
                const h = switchTarget
                setSwitchTarget(null)
                if (h) activate.mutate({ id: h.id, mode: 'interrupt' })
              }}
            >
              立即中断
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  initial?: { name: string; url: string; note: string | null }
  pending: boolean
  onSubmit: (v: { name: string; url: string; note: string | null }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  // Dialog 每次打开时同步初始值
  const [seeded, setSeeded] = useState(false)
  if (open && !seeded) {
    setName(initial?.name ?? '')
    setUrl(initial?.url ?? '')
    setNote(initial?.note ?? '')
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={pending || !name.trim() || !url.trim()}
            // 备注清空要发 null:undefined 会被 JSON.stringify 丢键,服务端保留旧备注
            onClick={() => onSubmit({ name: name.trim(), url: url.trim(), note: note.trim() || null })}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
