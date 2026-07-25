import type { ComfyClient, ObjectInfoMap } from './client.js'

/** /object_info 内存缓存:convert / validate / input-options 共用,默认 5 分钟 TTL */
export class ObjectInfoCache {
  private data: ObjectInfoMap | null = null
  private fetchedAt = 0
  private inflight: Promise<ObjectInfoMap> | null = null

  constructor(
    private comfy: ComfyClient,
    private ttlMs = 5 * 60_000,
  ) {}

  async get(refresh = false): Promise<ObjectInfoMap> {
    if (!refresh && this.data && Date.now() - this.fetchedAt < this.ttlMs) return this.data
    // 并发请求共享同一次拉取;失败不缓存,下次调用重试
    this.inflight ??= this.comfy
      .getObjectInfo()
      .then((fresh) => {
        this.data = fresh
        this.fetchedAt = Date.now()
        return fresh
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }
}
