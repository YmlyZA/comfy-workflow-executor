import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/app.js'

function testApp() {
  const config = loadConfig({ AUTH_TOKEN: 'secret', DATA_DIR: './data-test' })
  return createApp({ config })
}

describe('loadConfig', () => {
  it('applies defaults in dev', () => {
    const c = loadConfig({})
    expect(c).toEqual({
      port: 8080,
      dataDir: './data',
      comfyUrl: 'http://127.0.0.1:8188',
      authToken: 'dev-token',
    })
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
