import type { MiddlewareHandler } from 'hono'

export function auth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api/health') return next()
    const header = c.req.header('Authorization')
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    if (provided !== token) return c.json({ error: 'unauthorized' }, 401)
    return next()
  }
}
