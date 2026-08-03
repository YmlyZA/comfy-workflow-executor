import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** 缩略图:优先 src(缩略图端点),失败回退 fallback(原图)一次,再失败隐藏但保位,不破版式 */
export function FileThumb({
  src,
  fallback,
  className,
}: {
  src: string
  fallback?: string
  className?: string
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0)
  useEffect(() => setStage(0), [src])
  const cur = stage === 0 ? src : stage === 1 && fallback ? fallback : null
  return (
    <span className={cn('size-8 shrink-0 overflow-hidden rounded', className)}>
      {cur && (
        <img
          src={cur}
          loading="lazy"
          alt=""
          className="size-full object-cover opacity-0 transition-opacity duration-250"
          onLoad={(e) => {
            ;(e.target as HTMLImageElement).classList.remove('opacity-0')
          }}
          onError={() => setStage((s) => (s === 0 && fallback ? 1 : 2))}
        />
      )}
    </span>
  )
}
