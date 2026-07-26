import { useQueryClient } from '@tanstack/react-query'
import { ImageIcon, UploadIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { FileThumb } from '@/components/image-multi-pick'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { useUploadFiles } from '@/hooks/use-upload-files'
import { api, comfyInputFileUrl, uploadFileUrl } from '@/lib/api'

/** image 参数单值控件:手填 + 双来源下拉 + 本机上传 */
export function ImageValueControl({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const uploads = useUploadFiles()
  const gpuFiles = useComfyInputFiles()

  async function onFile(file: File) {
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('files', file)
      const stored = await api<Array<{ name: string; stored: string }>>('/uploads', {
        method: 'POST',
        body: form,
      })
      const name = stored[0]?.stored
      if (name) onChange(name)
      void qc.invalidateQueries({ queryKey: ['upload-files'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Input
          className="h-8"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 px-2" title="选择已有文件">
              <ImageIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
            <DropdownMenuLabel>服务端已上传</DropdownMenuLabel>
            {(uploads.data?.files ?? []).map((f) => (
              <DropdownMenuItem key={`up-${f}`} onSelect={() => onChange(f)}>
                <FileThumb src={uploadFileUrl(f)} />
                <span className="truncate">{f}</span>
              </DropdownMenuItem>
            ))}
            {(uploads.data?.files ?? []).length === 0 && (
              <DropdownMenuItem disabled>（无）</DropdownMenuItem>
            )}
            {!gpuFiles.isError && !gpuFiles.isLoading && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>GPU 主机已有</DropdownMenuLabel>
                {(gpuFiles.data?.files ?? []).map((f) => (
                  <DropdownMenuItem key={`gpu-${f}`} onSelect={() => onChange(f)}>
                    <FileThumb src={comfyInputFileUrl(f)} />
                    <span className="truncate">{f}</span>
                  </DropdownMenuItem>
                ))}
                {(gpuFiles.data?.files ?? []).length === 0 && (
                  <DropdownMenuItem disabled>（无）</DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          disabled={uploading}
          title="上传本机图片"
          onClick={() => fileRef.current?.click()}
        >
          <UploadIcon className="size-4" />
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
            e.target.value = ''
          }}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
