import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileThumb } from '@/components/file-thumb'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { useUploadFiles } from '@/hooks/use-upload-files'
import { api, comfyInputFileUrl, thumbUrl, uploadFileUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 60

export type PickSource = 'uploads' | 'comfy'

/** 统一图片选择弹窗:Tab 双来源+网格+过滤+客户端分页;multi 确定才提交,single 点击即提交 */
export function ImagePickerDialog({
  mode,
  open,
  onOpenChange,
  value,
  onConfirm,
}: {
  mode: 'single' | 'multi'
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string[]
  onConfirm: (next: string[]) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'multi' ? '选择图片(可多选)' : '选择图片'}</DialogTitle>
        </DialogHeader>
        {/* open 时才挂载,状态随每次打开重置 */}
        {open && (
          <PickerBody mode={mode} value={value} onConfirm={onConfirm} close={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PickerBody({
  mode,
  value,
  onConfirm,
  close,
}: {
  mode: 'single' | 'multi'
  value: string[]
  onConfirm: (next: string[]) => void
  close: () => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<string[]>(value)
  const [tab, setTab] = useState<PickSource>('uploads')
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()

  const uploadList = uploads.data?.files ?? []
  const gpuList = gpuFiles.data?.files ?? []
  const files = tab === 'uploads' ? uploadList : gpuList
  const filtered = useMemo(() => files.filter((f) => f.includes(filter)), [files, filter])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const cur = Math.min(page, pageCount - 1)
  const shown = filtered.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE)
  const chosen = new Set(draft)
  const listed = new Set([...uploadList, ...gpuList])
  const orphans = draft.filter((f) => !listed.has(f))

  function pick(name: string) {
    if (mode === 'single') {
      onConfirm([name])
      close()
      return
    }
    setDraft((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]))
  }

  async function onFiles(list: FileList) {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      for (const f of list) form.append('files', f)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
      const names = [...new Set(stored.map((s) => s.stored))]
      if (mode === 'single') {
        if (names[0]) {
          onConfirm([names[0]])
          close()
        }
        return
      }
      setDraft((prev) => [...prev, ...names.filter((n) => !prev.includes(n))])
      setTab('uploads')
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (mode !== 'multi' || e.button !== 0) return
    // 落在卡片上是点选,不启动框选
    if ((e.target as HTMLElement).closest('[data-name]')) return
    dragStart.current = { x: e.clientX, y: e.clientY }
    gridRef.current?.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current || !overlayRef.current || !gridRef.current) return
    const host = gridRef.current.getBoundingClientRect()
    // 拖动过程只改 overlay 样式,不 setState
    Object.assign(overlayRef.current.style, {
      display: 'block',
      left: `${Math.min(dragStart.current.x, e.clientX) - host.left}px`,
      top: `${Math.min(dragStart.current.y, e.clientY) - host.top + gridRef.current.scrollTop}px`,
      width: `${Math.abs(e.clientX - dragStart.current.x)}px`,
      height: `${Math.abs(e.clientY - dragStart.current.y)}px`,
    })
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current
    dragStart.current = null
    if (overlayRef.current) overlayRef.current.style.display = 'none'
    if (!start || !gridRef.current) return
    const x1 = Math.min(start.x, e.clientX)
    const x2 = Math.max(start.x, e.clientX)
    const y1 = Math.min(start.y, e.clientY)
    const y2 = Math.max(start.y, e.clientY)
    if (x2 - x1 < 4 && y2 - y1 < 4) return // 视为点击
    const hit: string[] = []
    for (const el of gridRef.current.querySelectorAll<HTMLElement>('[data-name]')) {
      const r = el.getBoundingClientRect()
      if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1 && el.dataset.name) {
        hit.push(el.dataset.name)
      }
    }
    if (hit.length) setDraft((prev) => [...prev, ...hit.filter((n) => !prev.includes(n))])
  }

  function onPointerCancel() {
    dragStart.current = null
    if (overlayRef.current) overlayRef.current.style.display = 'none'
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as PickSource)
            setPage(0)
          }}
        >
          <TabsList>
            <TabsTrigger value="uploads">服务端已上传</TabsTrigger>
            <TabsTrigger
              value="comfy"
              disabled={gpuFiles.isError}
              title={gpuFiles.isError ? 'ComfyUI 离线,GPU 文件列表不可用' : undefined}
            >
              GPU 主机已有
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          className="h-8 w-40"
          placeholder="过滤文件名…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setPage(0)
          }}
        />
        <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
          上传本机图片
        </Button>
        {uploading && <span className="text-xs text-muted-foreground">上传中…</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      <div
        ref={gridRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="relative flex max-h-80 min-h-40 select-none flex-wrap content-start gap-2 overflow-y-auto rounded-md border p-2"
      >
        <div
          ref={overlayRef}
          className="pointer-events-none absolute z-10 hidden border border-primary bg-primary/10"
        />
        {shown.map((f) => (
          <GridCard key={f} name={f} source={tab} selected={chosen.has(f)} onPick={() => pick(f)} />
        ))}
        {shown.length === 0 && <p className="text-xs text-muted-foreground">（无匹配文件）</p>}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={cur === 0} onClick={() => setPage(cur - 1)}>
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {cur + 1} / {pageCount}
          </span>
          <Button size="sm" variant="outline" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>
            下一页
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">共 {filtered.length} 个文件</span>
      </div>
      {mode === 'multi' && (
        <>
          {orphans.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">其他已选：</span>
              {orphans.map((f) => (
                <span key={f} className="flex items-center gap-1 rounded-md border px-1 py-0.5 text-xs">
                  <span className="max-w-32 truncate" title={f}>
                    {f}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted"
                    onClick={() => setDraft((prev) => prev.filter((v) => v !== f))}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-sm text-muted-foreground">已选 {draft.length} 张</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraft([])}>
                清空
              </Button>
              <Button variant="outline" size="sm" onClick={close}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onConfirm(draft)
                  close()
                }}
              >
                确定
              </Button>
            </div>
          </DialogFooter>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple={mode === 'multi'}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** 网格卡片;data-name 供框选命中检测(Task 4)使用 */
function GridCard({
  name,
  source,
  selected,
  onPick,
}: {
  name: string
  source: PickSource
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      data-name={name}
      onClick={onPick}
      className={cn(
        'relative flex w-24 flex-col items-center gap-1 rounded-md border p-1',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      {selected && (
        <CheckIcon className="absolute top-1 right-1 z-10 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />
      )}
      <FileThumb
        className="size-20"
        src={thumbUrl(source, name)}
        fallback={source === 'uploads' ? uploadFileUrl(name) : comfyInputFileUrl(name)}
      />
      <span className="w-full truncate text-center text-xs" title={name}>
        {name}
      </span>
    </button>
  )
}
