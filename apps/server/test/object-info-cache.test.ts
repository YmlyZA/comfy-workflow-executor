import { describe, expect, it } from 'vitest'
import { ObjectInfoCache } from '../src/comfy/object-info-cache.js'
import { FakeComfy } from './fake-comfy.js'

describe('ObjectInfoCache', () => {
  it('TTL 内命中缓存,只拉一次', async () => {
    const comfy = new FakeComfy()
    comfy.objectInfo = { KSampler: {} }
    const cache = new ObjectInfoCache(comfy, 60_000)
    expect(await cache.get()).toEqual({ KSampler: {} })
    await cache.get()
    expect(comfy.objectInfoCalls).toBe(1)
  })

  it('refresh=true 强制重新拉取', async () => {
    const comfy = new FakeComfy()
    const cache = new ObjectInfoCache(comfy, 60_000)
    await cache.get()
    await cache.get(true)
    expect(comfy.objectInfoCalls).toBe(2)
  })

  it('TTL=0 时每次都重新拉取', async () => {
    const comfy = new FakeComfy()
    const cache = new ObjectInfoCache(comfy, 0)
    await cache.get()
    await cache.get()
    expect(comfy.objectInfoCalls).toBe(2)
  })

  it('拉取失败时不缓存错误,下次重试', async () => {
    const comfy = new FakeComfy()
    let fail = true
    comfy.getObjectInfo = async () => {
      if (fail) throw new Error('down')
      return { OK: {} }
    }
    const cache = new ObjectInfoCache(comfy, 60_000)
    await expect(cache.get()).rejects.toThrow('down')
    fail = false
    expect(await cache.get()).toEqual({ OK: {} })
  })
})
