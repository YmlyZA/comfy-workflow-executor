import type { AppDeps } from './app.js'
import { createComfyClient } from './comfy/client.js'

/** 热切换串行锁:把一段异步临界区排到上一段之后执行(FIFO)。 */
export interface AsyncLock {
  run<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * promise 链实现的异步互斥锁。
 *
 * 为什么需要:主机切换(activate)、改 active 主机 URL、数据导入三个入口都会做
 * "pause executor → 换 db/comfy 引用 → resume",这三段彼此并发交错时,两个
 * handler 会先后 await 到同一个 loopPromise、随后各自 start() 一次 —— 结果是两个
 * executor loop 同时在跑(其中一个成孤儿、永远不会被 pause 等到),job 还可能被盖上
 * 错误主机的章。用一把进程内的锁把三个入口串起来,任何时刻只有一段切换在进行。
 */
export function createAsyncLock(): AsyncLock {
  // tail 永远是一个"已吞掉异常"的 promise:上一段失败不能卡死后面的排队者
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn)
      tail = result.catch(() => {})
      return result
    },
  }
}

/** 切换参考主机:只换查询用 client 并失效节点缓存。
 * 不再碰 executor —— 参考主机与「谁干活」已解耦(见 spec「active 退位」)。 */
export async function reconnectComfy(
  deps: Pick<AppDeps, 'db' | 'comfy' | 'events' | 'objectInfo'>,
  host: { id: number; name: string; url: string },
): Promise<void> {
  const client = createComfyClient(host.url)
  deps.comfy = client
  deps.objectInfo?.invalidate()
  const online = await client.isUp()
  deps.events.emit('event', {
    type: 'comfy-status',
    online,
    hostId: host.id,
    hostName: host.name,
  })
}
