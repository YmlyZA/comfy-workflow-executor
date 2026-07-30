import { DownloadIcon, Loader2Icon, UploadIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import { backupExportUrl, importBackup } from '@/lib/api'

function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return '操作失败'
  try {
    return (JSON.parse(e.message) as { error?: string }).error ?? e.message
  } catch {
    return e.message
  }
}

export default function BackupPage() {
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // 导入中拦截刷新/关闭:服务端正在整体替换数据,中途离开会看不到结果(切换本身在服务端继续)
  useEffect(() => {
    if (!busy) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [busy])

  async function doImport(file: File) {
    setBusy(true)
    setMsg('导入中……若有任务在运行，会先等它完成再切换')
    try {
      await importBackup(file)
      setMsg('导入成功，即将刷新')
      window.location.reload()
    } catch (e) {
      setMsg(`导入失败：${errMsg(e)}`)
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-lg font-semibold">数据备份</h1>

      <section className="space-y-2 rounded-md border p-4">
        <p className="text-sm font-medium">导出</p>
        <p className="text-sm text-muted-foreground">
          打包下载全部数据（数据库 + 输入图 + 产出图；不含可再生的缩略图缓存）。
          下载由浏览器接管，开始后可离开本页面。
        </p>
        <Button size="sm" asChild>
          <a href={backupExportUrl()} download>
            <DownloadIcon className="size-4" /> 导出 zip
          </a>
        </Button>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <p className="text-sm font-medium">导入</p>
        <p className="text-sm text-muted-foreground">上传之前导出的 zip，整体替换当前数据。</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          <UploadIcon className="size-4" /> 选择 zip 导入
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setPendingFile(f)
            e.target.value = ''
          }}
        />
      </section>

      {msg && <p className="text-sm">{msg}</p>}

      {busy && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
          <Loader2Icon className="size-8 animate-spin" />
          <p className="text-sm font-medium">导入中，请勿刷新或关闭页面</p>
          <p className="text-sm text-muted-foreground">
            若有任务在运行，会先等它完成再切换；完成后页面自动刷新
          </p>
        </div>
      )}

      <AlertDialog open={pendingFile !== null} onOpenChange={(o) => !o && setPendingFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>导入 {pendingFile?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              将整体替换现有全部数据，且不可撤销（旧数据保留在服务端 bak 目录）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const f = pendingFile
                setPendingFile(null)
                if (f) void doImport(f)
              }}
            >
              导入并替换
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
