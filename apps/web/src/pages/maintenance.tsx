import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  cleanGpuOrphans,
  cleanMaintenance,
  comfyOutputThumbUrl,
  errorMessage,
  fetchGpuOrphans,
  fetchHosts,
  fetchMaintenanceSummary,
  type GpuOrphan,
  type MaintenanceTarget,
} from '@/lib/api'
import { formatBytes } from '@/lib/utils'

const LOCAL_ROWS: Array<{ key: MaintenanceTarget; title: string; desc: string }> = [
  { key: 'bak', title: '导入备份残留', desc: '数据导入留下的 .bak-* 旧数据与 .import-* 临时文件' },
  { key: 'thumbs', title: '缩略图缓存', desc: '清理后浏览时按需重新生成' },
  { key: 'orphan-outputs', title: '孤儿输出目录', desc: '删除 batch 时未勾选清理而留下的输出目录' },
]

export default function MaintenancePage() {
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const [confirmTarget, setConfirmTarget] = useState<MaintenanceTarget | null>(null)
  const { data: summary } = useQuery({
    queryKey: ['maintenance-summary'],
    queryFn: fetchMaintenanceSummary,
  })
  const clean = useMutation({
    mutationFn: (t: MaintenanceTarget) => cleanMaintenance([t]),
    onSuccess: (r, t) => {
      const res = r.results[t]
      setMsg(
        `已释放 ${formatBytes(res?.freedBytes ?? 0)}${(res?.failed.length ?? 0) > 0 ? `；${res!.failed.length} 项失败` : ''}`,
      )
      void qc.invalidateQueries({ queryKey: ['maintenance-summary'] })
    },
    onError: (e) => setMsg(errorMessage(e)),
  })

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold">存储维护</h1>

      <section className="space-y-3 rounded-md border p-4">
        <p className="text-sm font-medium">本地数据目录</p>
        {LOCAL_ROWS.map((row) => {
          const s = summary?.[row.key === 'orphan-outputs' ? 'orphanOutputs' : row.key]
          return (
            <div key={row.key} className="flex items-center gap-3 text-sm">
              <div className="flex-1">
                <p>{row.title}</p>
                <p className="text-xs text-muted-foreground">{row.desc}</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {s ? `${s.count} 项 · ${formatBytes(s.bytes)}` : '…'}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={clean.isPending || !s || s.count === 0}
                onClick={() => setConfirmTarget(row.key)}
              >
                清理
              </Button>
            </div>
          )
        })}
        {msg && <p className="text-sm">{msg}</p>}
      </section>

      <GpuSection />

      <AlertDialog open={confirmTarget !== null} onOpenChange={(o) => !o && setConfirmTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              清理{LOCAL_ROWS.find((r) => r.key === confirmTarget)?.title}？
            </AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmTarget
                setConfirmTarget(null)
                if (t) clean.mutate(t)
              }}
            >
              清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 单次 gpu-clean 请求上限(与服务端 zod max(1000) 对齐),全选删除时按此分片顺序调用 */
const GPU_CLEAN_BATCH = 1000

function GpuSection() {
  const [hostId, setHostId] = useState<number | undefined>(undefined)
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<Awaited<ReturnType<typeof fetchGpuOrphans>> | null>(null)
  // 扫描代次:随每次成功扫描递增,作为缩略图 key 的一部分强制 <img> 重建，
  // 避免上次加载失败时直接写入 DOM 的 visibility:hidden 被 React 复用到新一轮扫描
  const [scanGen, setScanGen] = useState(0)
  const [scanErr, setScanErr] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState('')
  const { data: hostsData } = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts })
  const hosts = hostsData?.hosts ?? []
  const effectiveHostId = hostId ?? hosts.find((h) => h.active === 1)?.id

  const key = (o: GpuOrphan) => `${o.subfolder}/${o.filename}`

  async function runScan() {
    setScanning(true)
    setScanErr('')
    setResult('')
    setPicked(new Set())
    try {
      setScan(await fetchGpuOrphans(effectiveHostId))
      setScanGen((g) => g + 1)
    } catch (e) {
      setScan(null)
      setScanErr(errorMessage(e))
    } finally {
      setScanning(false)
    }
  }

  const remove = useMutation({
    mutationFn: async () => {
      const targets = scan!.orphans
        .filter((o) => picked.has(key(o)))
        .map((o) => ({ filename: o.filename, subfolder: o.subfolder }))
      // 孤儿数超服务端 zod max(1000) 时分片顺序请求,避免全选删除直接报 400
      const agg = { deleted: 0, missing: 0, failed: [] as string[], skippedReferenced: 0 }
      for (let i = 0; i < targets.length; i += GPU_CLEAN_BATCH) {
        const r = await cleanGpuOrphans(scan!.host.id, targets.slice(i, i + GPU_CLEAN_BATCH))
        agg.deleted += r.deleted
        agg.missing += r.missing
        agg.failed.push(...r.failed)
        agg.skippedReferenced += r.skippedReferenced ?? 0
      }
      return agg
    },
    onSuccess: (r) => {
      setResult(
        `已删除 ${r.deleted} 个${r.missing > 0 ? `，${r.missing} 个已不存在` : ''}${r.failed.length > 0 ? `，${r.failed.length} 个失败` : ''}${r.skippedReferenced > 0 ? `，${r.skippedReferenced} 个已被引用跳过` : ''}`,
      )
      void runScan()
    },
    onError: (e) => setResult(errorMessage(e)),
  })

  const pickedBytes = scan?.orphans.filter((o) => picked.has(key(o))).reduce((a, o) => a + o.size, 0) ?? 0

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium">GPU 主机孤儿文件</p>
        <Select
          value={effectiveHostId !== undefined ? String(effectiveHostId) : undefined}
          onValueChange={(v) => setHostId(Number(v))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="选择主机" />
          </SelectTrigger>
          <SelectContent>
            {hosts.map((h) => (
              <SelectItem key={h.id} value={String(h.id)}>
                {h.name}
                {h.active === 1 ? '（当前）' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={scanning || effectiveHostId === undefined} onClick={() => void runScan()}>
          {scanning ? <Loader2Icon className="size-4 animate-spin" /> : '扫描'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        列出 output 目录中不被任何 batch 引用的文件。你直接在 ComfyUI 跑的图也会被列出——默认不勾选，删除前请逐项确认。
      </p>
      {scanErr && <p className="text-sm text-destructive">{scanErr}</p>}
      {result && <p className="text-sm">{result}</p>}
      {scan && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span>
              {scan.orphans.length} 个孤儿 · {formatBytes(scan.totalBytes)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={scan.orphans.length === 0}
              onClick={() =>
                setPicked(
                  picked.size === scan.orphans.length
                    ? new Set()
                    : new Set(scan.orphans.map(key)),
                )
              }
            >
              {picked.size === scan.orphans.length && scan.orphans.length > 0 ? '全不选' : '全选'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={picked.size === 0 || remove.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              删除所选（{picked.size} 项 · {formatBytes(pickedBytes)}）
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
            {scan.orphans.map((o) => {
              const k = key(o)
              const checked = picked.has(k)
              return (
                <label key={k} className="cursor-pointer space-y-1 text-xs">
                  <div className="relative">
                    <img
                      key={scanGen}
                      src={comfyOutputThumbUrl(scan.host.id, o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename)}
                      alt={o.filename}
                      loading="lazy"
                      className={`aspect-square w-full rounded-md border object-cover ${checked ? 'ring-2 ring-destructive' : ''}`}
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.visibility = 'hidden'
                      }}
                    />
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        const next = new Set(picked)
                        if (v) next.add(k)
                        else next.delete(k)
                        setPicked(next)
                      }}
                      className="absolute top-1 left-1 bg-background"
                    />
                  </div>
                  <p className="truncate font-mono" title={k}>
                    {o.filename}
                  </p>
                  <p className="text-muted-foreground">
                    {formatBytes(o.size)} · {new Date(o.mtime * 1000).toLocaleDateString('zh-CN')}
                  </p>
                </label>
              )
            })}
          </div>
          {scan.orphans.length === 0 && (
            <p className="text-sm text-muted-foreground">没有孤儿文件。</p>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {picked.size} 个 GPU 侧文件？</AlertDialogTitle>
            <AlertDialogDescription>
              手动跑图的产物也会被判为孤儿，请确认勾选项都是可删除的。删除后不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                remove.mutate()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
