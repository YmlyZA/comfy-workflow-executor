import { describe, expect, it } from 'vitest'
import { ObjectInfoCache } from '../src/comfy/object-info-cache.js'
import { FakeComfy } from './fake-comfy.js'

describe('ObjectInfoCache', () => {
  it('TTL 内命中缓存,只拉一次', async () => {
    const comfy = new FakeComfy()
    comfy.objectInfo = { KSampler: {} }
    const cache = new ObjectInfoCache(() => comfy, 60_000)
    expect(await cache.get()).toEqual({ KSampler: {} })
    await cache.get()
    expect(comfy.objectInfoCalls).toBe(1)
  })

  it('refresh=true 强制重新拉取', async () => {
    const comfy = new FakeComfy()
    const cache = new ObjectInfoCache(() => comfy, 60_000)
    await cache.get()
    await cache.get(true)
    expect(comfy.objectInfoCalls).toBe(2)
  })

  it('TTL=0 时每次都重新拉取', async () => {
    const comfy = new FakeComfy()
    const cache = new ObjectInfoCache(() => comfy, 0)
    await cache.get()
    await cache.get()
    expect(comfy.objectInfoCalls).toBe(2)
  })

  it('并发请求共享同一次拉取(dogpile 保护)', async () => {
    const comfy = new FakeComfy()
    comfy.objectInfo = { KSampler: {} }
    const cache = new ObjectInfoCache(() => comfy, 60_000)
    const [a, b] = await Promise.all([cache.get(), cache.get(), cache.get()])
    expect(comfy.objectInfoCalls).toBe(1)
    expect(a).toEqual({ KSampler: {} })
    expect(b).toBe(a)
  })

  it('拉取失败时不缓存错误,下次重试', async () => {
    const comfy = new FakeComfy()
    let fail = true
    comfy.getObjectInfo = async () => {
      if (fail) throw new Error('down')
      return { OK: {} }
    }
    const cache = new ObjectInfoCache(() => comfy, 60_000)
    await expect(cache.get()).rejects.toThrow('down')
    fail = false
    expect(await cache.get()).toEqual({ OK: {} })
  })

  it('invalidate 后重新拉取;切换 getter 目标后拉到新主机数据', async () => {
    const a = new FakeComfy()
    a.objectInfo = { NodeA: {} }
    const b = new FakeComfy()
    b.objectInfo = { NodeB: {} }
    let current: FakeComfy = a
    const cache = new ObjectInfoCache(() => current)
    expect(await cache.get()).toHaveProperty('NodeA')
    current = b
    cache.invalidate()
    expect(await cache.get()).toHaveProperty('NodeB')
    expect(a.objectInfoCalls).toBe(1)
  })

  it('invalidate 作废进行中的拉取结果(旧主机数据不落缓存)', async () => {
    const a = new FakeComfy()
    a.objectInfo = { NodeA: {} }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = { ...a, getObjectInfo: async () => { await gate; return a.objectInfo } } as FakeComfy
    let current: FakeComfy = slow
    const cache = new ObjectInfoCache(() => current)
    const p = cache.get()
    const b = new FakeComfy()
    b.objectInfo = { NodeB: {} }
    current = b
    cache.invalidate()
    release()
    await p
    expect(await cache.get()).toHaveProperty('NodeB')
  })
})
