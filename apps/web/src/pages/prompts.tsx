import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, promptsExportUrl } from '@/lib/api'
import { fetchPrompts, type PromptRow } from '@/lib/prompts'

function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return '操作失败'
  try {
    return (JSON.parse(e.message) as { error?: string }).error ?? e.message
  } catch {
    return e.message
  }
}

export default function PromptsPage() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['prompts'], queryFn: fetchPrompts })
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; row: PromptRow } | null>(
    null,
  )
  const [deleting, setDeleting] = useState<PromptRow | null>(null)
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const groups = useMemo(() => {
    const map = new Map<string, PromptRow[]>()
    for (const p of query.data?.prompts ?? []) {
      const group = p.key.includes('.') ? p.key.slice(0, p.key.indexOf('.')) : '未分组'
      map.set(group, [...(map.get(group) ?? []), p])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [query.data])

  async function handleImportFile(file: File) {
    setNotice('')
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const res = await api<{ created: number; updated: number }>('/prompts/import', {
        method: 'POST',
        body: JSON.stringify(parsed),
      })
      setNotice(`导入完成：新增 ${res.created}，覆盖 ${res.updated}`)
      void qc.invalidateQueries({ queryKey: ['prompts'] })
    } catch (e) {
      setNotice(`导入失败：${errMsg(e)}`)
    }
  }

  async function handleDelete(row: PromptRow) {
    await api(`/prompts/${row.id}`, { method: 'DELETE' })
    setDeleting(null)
    void qc.invalidateQueries({ queryKey: ['prompts'] })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">Prompt 库</h1>
        <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
          <PlusIcon className="size-4" /> 新建
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <UploadIcon className="size-4" /> 导入
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={promptsExportUrl()} download>
            <DownloadIcon className="size-4" /> 导出
          </a>
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImportFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      {query.data?.prompts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          还没有 prompt 片段。key 用点分组织（如 人物.少女），输入框里打 $ 即可展开插入。
        </p>
      )}

      {groups.map(([group, rows]) => (
        <section key={group} className="space-y-1">
          <h2 className="text-sm font-medium text-muted-foreground">{group}</h2>
          <div className="divide-y rounded-md border">
            {rows.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2">
                <span className="shrink-0 font-mono text-sm">{p.key}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={p.content}>
                  {p.content}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setDialog({ mode: 'edit', row: p })}>
                  <PencilIcon className="size-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(p)}>
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>
      ))}

      {dialog && (
        <EditDialog
          initial={dialog.mode === 'edit' ? dialog.row : null}
          onClose={(changed) => {
            setDialog(null)
            if (changed) void qc.invalidateQueries({ queryKey: ['prompts'] })
          }}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleting?.key}？</AlertDialogTitle>
            <AlertDialogDescription>已展开插入的内容不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && void handleDelete(deleting)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function EditDialog({
  initial,
  onClose,
}: {
  initial: PromptRow | null
  onClose: (changed: boolean) => void
}) {
  const [key, setKey] = useState(initial?.key ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    setError('')
    try {
      if (initial) {
        await api(`/prompts/${initial.id}`, { method: 'PUT', body: JSON.stringify({ key, content }) })
      } else {
        await api('/prompts', { method: 'POST', body: JSON.stringify({ key, content }) })
      }
      onClose(true)
    } catch (e) {
      setError(errMsg(e))
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? '编辑片段' : '新建片段'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="prompt-key">key（点分分组，如 人物.少女）</Label>
            <Input id="prompt-key" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="prompt-content">内容</Label>
            <Textarea
              id="prompt-content"
              rows={4}
              className="field-sizing-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving || !key.trim() || !content.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
