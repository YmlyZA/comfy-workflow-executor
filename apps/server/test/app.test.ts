import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db/index.js'

function testApp() {
  const config = loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: './data-test' })
  return createApp({ config, db: createDb(':memory:'), comfy: null, events: new EventEmitter() })
}

describe('loadConfig', () => {
  it('applies defaults in dev', () => {
    const c = loadConfig({})
    expect(c).toEqual({
      port: 8080,
      dataDir: './data',
      comfyUrl: 'http://127.0.0.1:8188',
      authToken: 'dev-token',
      inputHistoryLimit: 100,
    })
  })

  it('INPUT_HISTORY_LIMIT 非法/非正数回退 100', () => {
    expect(loadConfig({ INPUT_HISTORY_LIMIT: '0' }).inputHistoryLimit).toBe(100)
    expect(loadConfig({ INPUT_HISTORY_LIMIT: 'abc' }).inputHistoryLimit).toBe(100)
    expect(loadConfig({ INPUT_HISTORY_LIMIT: '50' }).inputHistoryLimit).toBe(50)
  })

  it('strips trailing slash from comfy url', () => {
    expect(loadConfig({ COMFYUI_URL: 'http://gpu:8188/' }).comfyUrl).toBe('http://gpu:8188')
  })

  it('requires AUTH_TOKEN in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('AUTH_TOKEN')
  })
})

describe('auth middleware', () => {
  it('health is public', async () => {
    const res = await testApp().request('/api/health')
    expect(res.status).toBe(200)
  })

  it('rejects missing token', async () => {
    const res = await testApp().request('/api/templates')
    expect(res.status).toBe(401)
  })

  it('accepts bearer header', async () => {
    const res = await testApp().request('/api/templates', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).not.toBe(401)
  })

  it('accepts token query param', async () => {
    const res = await testApp().request('/api/templates?token=secret')
    expect(res.status).not.toBe(401)
  })
})

describe('unknown api route', () => {
  it('unknown api path returns json 404', async () => {
    const res = await testApp().request('/api/nope', { headers: { Authorization: 'Bearer secret' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})
