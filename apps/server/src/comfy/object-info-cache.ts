import type { ComfyClient, ObjectInfoMap } from './client.js'

/** /object_info 内存缓存:convert / validate / input-options 共用,默认 5 分钟 TTL。
 * 经 getter 取 client:主机热切换后自动指向新 client;世代计数防止切换瞬间
 * 进行中的旧主机拉取结果污染缓存。 */
export class ObjectInfoCache {
  private data: ObjectInfoMap | null = null
  private fetchedAt = 0
  private inflight: Promise<ObjectInfoMap> | null = null
  private gen = 0

  constructor(
    private getComfy: () => ComfyClient | null,
    private ttlMs = 5 * 60_000,
  ) {}

  invalidate(): void {
    this.data = null
    this.fetchedAt = 0
    this.inflight = null
    this.gen++
  }

  async get(refresh = false): Promise<ObjectInfoMap> {
    const comfy = this.getComfy()
    if (!comfy) throw new Error('ComfyUI 未配置')
    if (!refresh && this.data && Date.now() - this.fetchedAt < this.ttlMs) return this.data
    if (!this.inflight) {
      const g = this.gen
      this.inflight = comfy
        .getObjectInfo()
        .then((fresh) => {
          if (g === this.gen) {
            this.data = fresh
            this.fetchedAt = Date.now()
          }
          return fresh
        })
        .finally(() => {
          if (g === this.gen) this.inflight = null
        })
    }
    return this.inflight
  }
}
