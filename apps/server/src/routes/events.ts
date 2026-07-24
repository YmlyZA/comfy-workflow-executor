import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppDeps } from '../app.js'

export function eventRoutes(deps: AppDeps) {
  const app = new Hono()

  app.get('/', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0
      const listener = (payload: { type: string }) => {
        void stream.writeSSE({
          event: payload.type,
          data: JSON.stringify(payload),
          id: String(++id),
        })
      }
      deps.events.on('event', listener)
      stream.onAbort(() => {
        deps.events.off('event', listener)
      })
      // 心跳防止代理断流；连接断开时循环退出
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '{}' })
        await stream.sleep(15_000)
      }
    }),
  )

  return app
}
