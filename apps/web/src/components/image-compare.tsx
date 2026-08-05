import { useEffect, useState } from 'react'

/**
 * 悬停跟随的原图/生成图对比:分割线跟随指针 X,线左原图、线右生成图。
 * beforeCandidates 依序回退(uploads → comfy input);全部失败隐藏叠加层,仅显示生成图+提示。
 */
export function ImageCompare({
  beforeCandidates,
  afterSrc,
  afterAlt,
}: {
  beforeCandidates: string[]
  afterSrc: string
  afterAlt: string
}) {
  const [pos, setPos] = useState(50)
  const [beforeIdx, setBeforeIdx] = useState(0)
  // join 出稳定 key:候选列表内容变化(切 job/切参数)时重置回退阶段与分割位置
  const candKey = beforeCandidates.join('\n')
  useEffect(() => {
    setBeforeIdx(0)
    setPos(50)
  }, [candKey])
  const beforeSrc = beforeIdx < beforeCandidates.length ? beforeCandidates[beforeIdx] : null

  return (
    <div className="space-y-1">
      <div
        className="relative cursor-crosshair select-none"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setPos(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)))
        }}
        onPointerLeave={() => setPos(50)}
      >
        <img
          src={afterSrc}
          alt={afterAlt}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
        {beforeSrc && (
          <>
            <img
              src={beforeSrc}
              alt="原图"
              draggable={false}
              className="absolute inset-0 size-full rounded-md object-contain"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              onError={() => setBeforeIdx((i) => i + 1)}
            />
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-primary"
              style={{ left: `${pos}%` }}
            />
            <span className="pointer-events-none absolute top-1 left-1 rounded bg-background/70 px-1.5 py-0.5 text-xs">
              原图
            </span>
            <span className="pointer-events-none absolute top-1 right-1 rounded bg-background/70 px-1.5 py-0.5 text-xs">
              生成图
            </span>
          </>
        )}
      </div>
      {!beforeSrc && (
        <p className="text-xs text-muted-foreground">原图不可用（可能已被清理或在其他主机）</p>
      )}
    </div>
  )
}
