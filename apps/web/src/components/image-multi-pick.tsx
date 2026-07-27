import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileThumb } from '@/components/file-thumb'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { useUploadFiles } from '@/hooks/use-upload-files'
import { api, comfyInputFileUrl, thumbUrl, uploadFileUrl } from '@/lib/api'

/** image 多选:双来源勾选 + 本机上传(成功自动选中);value 顺序即选中顺序 */
export function ImageMultiPick({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()
  const chosen = new Set(value)

  function toggle(name: string, checked: boolean) {
    if (checked) onChange([...value, name])
    else onChange(value.filter((v) => v !== name))
  }

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
      // 去重上传可能返回已选中的名字,过滤避免重复
      const fresh = [...new Set(stored.map((s) => s.stored))].filter((s) => !chosen.has(s))
      onChange([...value, ...fresh])
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const groups: Array<['uploads' | 'comfy', string, string[], (f: string) => string]> = [
    ['uploads', '服务端已上传', uploads.data?.files ?? [], uploadFileUrl],
  ]
  if (!gpuFiles.isError && !gpuFiles.isLoading) {
    groups.push(['comfy', 'GPU 主机已有', gpuFiles.data?.files ?? [], comfyInputFileUrl])
  }
  const listed = new Set(groups.flatMap(([, , files]) => files))
  // 已选但不在任何列表(如 GPU 离线后其文件从列表消失):仍渲染,保证能取消勾选
  const orphans = value.filter((v) => !listed.has(v))

  return (
    <div className="space-y-2">
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
        {groups.map(([source, label, files, urlOf]) => (
          <div key={label}>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            {files.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.has(f)}
                  onChange={(e) => toggle(f, e.target.checked)}
                />
                <FileThumb src={thumbUrl(source, f)} fallback={urlOf(f)} />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </label>
            ))}
            {files.length === 0 && <p className="text-xs text-muted-foreground">（无）</p>}
          </div>
        ))}
        {orphans.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">其他已选</p>
            {orphans.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked onChange={() => toggle(f, false)} />
                <FileThumb src={thumbUrl('uploads', f)} fallback={uploadFileUrl(f)} />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          上传本机图片
        </Button>
        {uploading && <span className="text-xs text-muted-foreground">上传中…</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
