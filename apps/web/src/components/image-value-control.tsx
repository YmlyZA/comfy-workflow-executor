import { ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ImagePickerDialog } from '@/components/image-picker-dialog'
import { Input } from '@/components/ui/input'

/** image 参数单值控件:手填 + 弹窗选择(弹窗内含上传) */
export function ImageValueControl({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2"
        title="选择图片"
        onClick={() => setOpen(true)}
      >
        <ImageIcon className="size-4" />
      </Button>
      <ImagePickerDialog
        mode="single"
        open={open}
        onOpenChange={setOpen}
        value={value ? [value] : []}
        onConfirm={(next) => onChange(next[0] ?? '')}
      />
    </div>
  )
}
