import { useState } from 'react'

/**
 * 悬停跟随的原图/生成图对比:分割线跟随指针 X,线左原图、线右生成图。
 * beforeCandidates 依序回退(uploads → comfy input);全部失败隐藏叠加层,仅显示生成图+提示。
 * 调用方需在候选来源变化时换 key remount,以重置回退阶段与分割位置。
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
  const beforeSrc = beforeIdx < beforeCandidates.length ? beforeCandidates[beforeIdx] : null

  return (
    <div className="space-y-1">
      {/* 容器收缩包裹生成图实际绘制区(max-w/max-h 保比缩放,无留白),原图以 object-fit:fill
          拉伸到同一矩形——ComfyUI 尺寸取整(/8)造成的微小比例差被拉伸吸收,边缘逐边对齐 */}
      <div className="flex justify-center">
        <div
          className="relative cursor-crosshair select-none"
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            if (rect.width === 0) return
            setPos(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)))
          }}
          onPointerLeave={() => setPos(50)}
        >
          <img
            src={afterSrc}
            alt={afterAlt}
            draggable={false}
            className="max-h-[70vh] max-w-full rounded-md"
          />
          {beforeSrc && (
            <>
              <img
                src={beforeSrc}
                alt="原图"
                draggable={false}
                className="absolute inset-0 size-full rounded-md"
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
      </div>
      {!beforeSrc && (
        <p className="text-xs text-muted-foreground">原图不可用（可能已被清理或在其他主机）</p>
      )}
    </div>
  )
}
