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

/**
 * UTC ISO 时间转 <input type="datetime-local"> 期望的本地墙钟字符串(YYYY-MM-DDTHH:mm)。
 *
 * <input type="datetime-local"> 的值没有时区信息,浏览器按*本地*墙钟时间解释它
 * (`new Date('2026-08-10T12:30')` 也是按本地时间解析)。如果直接对 UTC ISO 字符串
 * 做 slice(0, 16),相当于把 UTC 的数字位原样当成本地时间塞进输入框——预填与回填
 * (`new Date(v).toISOString()`)两个方向就不再互为逆运算,每编辑一次就偏移一次时区差。
 * 这里改用本地 getter(getFullYear/getHours 等)取出「浏览器时区下的墙钟」,使预填与
 * 回填成为一对精确的逆运算。
 */
export function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
