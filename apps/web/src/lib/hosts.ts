import type { HostDto } from './api'

/** 在线台数/参与调度总台数。未探测过(null)按不在线计 */
export function onlineSummary(hosts: HostDto[]): { online: number; total: number } {
  const scheduling = hosts.filter((h) => h.enabled === 1)
  return {
    online: scheduling.filter((h) => h.online === true).length,
    total: scheduling.length,
  }
}

/** 是否还有主机能干活:既参与调度又在线 */
export function hasUsableHost(hosts: HostDto[]): boolean {
  return hosts.some((h) => h.enabled === 1 && h.online === true)
}

/** 参考主机:只服务节点/模型/文件列表查询,与「谁干活」无关 */
export function referenceHost(hosts: HostDto[]): HostDto | undefined {
  return hosts.find((h) => h.active === 1)
}

/** 已运行分钟数;起租时间在未来时按 0 处理 */
export function rentalMinutes(rentedAt: string, nowMs: number): number {
  const start = Date.parse(rentedAt)
  if (Number.isNaN(start)) return 0
  return Math.max(0, Math.floor((nowMs - start) / 60_000))
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** 估算费用;未填单价返回 null(只显示时长) */
export function rentalCost(
  rentedAt: string,
  hourlyRate: number | null,
  nowMs: number,
): number | null {
  if (hourlyRate == null) return null
  return (rentalMinutes(rentedAt, nowMs) / 60) * hourlyRate
}
