import { describe, expect, it } from 'vitest'
import { matchMediaStore, type MatchMediaHost } from './use-media-query'

/** 假 matchMedia 宿主:可手动翻转匹配态并触发 change 监听器 */
function fakeHost(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  const host: MatchMediaHost = {
    matchMedia: () => ({
      get matches() {
        return matches
      },
      addEventListener: (_type, cb) => listeners.add(cb),
      removeEventListener: (_type, cb) => listeners.delete(cb),
    }),
  }
  return {
    host,
    flip(v: boolean) {
      matches = v
      listeners.forEach((cb) => cb())
    },
    listenerCount: () => listeners.size,
  }
}

describe('matchMediaStore', () => {
  it('getSnapshot 返回当前匹配状态', () => {
    const { host } = fakeHost(true)
    expect(matchMediaStore('(max-width: 767px)', host).getSnapshot()).toBe(true)
  })

  it('匹配态变化时触发订阅回调,快照随之更新', () => {
    const { host, flip } = fakeHost(false)
    const store = matchMediaStore('(max-width: 767px)', host)
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })
    flip(true)
    expect(notified).toBe(1)
    expect(store.getSnapshot()).toBe(true)
  })

  it('取消订阅后监听器被移除,不再收到通知', () => {
    const { host, flip, listenerCount } = fakeHost(false)
    const store = matchMediaStore('(max-width: 767px)', host)
    let notified = 0
    const unsubscribe = store.subscribe(() => {
      notified += 1
    })
    expect(listenerCount()).toBe(1)
    unsubscribe()
    expect(listenerCount()).toBe(0)
    flip(true)
    expect(notified).toBe(0)
  })
})
