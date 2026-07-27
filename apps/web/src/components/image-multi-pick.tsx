import { XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileThumb } from '@/components/file-thumb'
import { ImagePickerDialog } from '@/components/image-picker-dialog'
import { useComfyInputFiles } from '@/hooks/use-comfy-input-files'
import { comfyInputFileUrl, thumbUrl, uploadFileUrl } from '@/lib/api'

/** image 多选:已选缩略图 chip 行 + 弹窗选择;value 顺序即选中顺序 */
export function ImageMultiPick({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const gpuFiles = useComfyInputFiles()
  const gpuSet = new Set(gpuFiles.data?.files ?? [])
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((f) => {
            const source = gpuSet.has(f) ? 'comfy' : 'uploads'
            return (
              <span key={f} className="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1 text-xs">
                <FileThumb
                  className="size-6"
                  src={thumbUrl(source, f)}
                  fallback={source === 'uploads' ? uploadFileUrl(f) : comfyInputFileUrl(f)}
                />
                <span className="max-w-32 truncate" title={f}>
                  {f}
                </span>
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={() => onChange(value.filter((v) => v !== f))}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        选择图片…
      </Button>
      <ImagePickerDialog mode="multi" open={open} onOpenChange={setOpen} value={value} onConfirm={onChange} />
    </div>
  )
}
