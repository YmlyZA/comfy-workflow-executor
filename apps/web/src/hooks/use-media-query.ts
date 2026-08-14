import { useMemo, useSyncExternalStore } from 'react'

export interface MediaQueryLike {
  matches: boolean
  addEventListener(type: 'change', cb: () => void): void
  removeEventListener(type: 'change', cb: () => void): void
}

/** matchMedia 宿主抽象:生产用 window,测试注入假实现(vitest 跑在 node 无 DOM) */
export interface MatchMediaHost {
  matchMedia(query: string): MediaQueryLike
}

export function matchMediaStore(query: string, host: MatchMediaHost = window) {
  return {
    subscribe(onChange: () => void) {
      const mql = host.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    getSnapshot() {
      return host.matchMedia(query).matches
    },
  }
}

/** 响应式断点判定,如 useMediaQuery('(max-width: 767px)') */
export function useMediaQuery(query: string): boolean {
  const store = useMemo(() => matchMediaStore(query), [query])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
