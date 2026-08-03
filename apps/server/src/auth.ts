import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

/** 比较 sha256 摘要:定长后可用 timingSafeEqual,且不泄露 token 长度 */
function tokenEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function auth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api/health') return next()
    const header = c.req.header('Authorization')
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    if (!provided || !tokenEquals(provided, token)) return c.json({ error: 'unauthorized' }, 401)
    return next()
  }
}
