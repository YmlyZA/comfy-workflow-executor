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

/**
 * 建批后对「批次被锁定到某台主机」的提示。
 *
 * 锁定主机只能是参考主机(被引用的 GPU 侧文件只存在于那台机器上),但参考主机
 * 未必在参与调度——它可能刚被熔断自动停用,或者干脆离线。这种时候不能再说
 * 「将只在该主机执行」:批次其实一个任务都跑不起来,得如实告诉用户为什么。
 */
export function pinnedHostNotice(
  hosts: HostDto[] | undefined,
  pinnedHostId: number,
): { level: 'info' | 'warning'; message: string } {
  // 主机列表还没加载出来:只说事实,不做「跑得起来」的承诺
  if (!hosts) return { level: 'info', message: '本批次引用了 GPU 主机上的文件，将只在该主机执行' }
  const pinned = hosts.find((h) => h.id === pinnedHostId)
  const prefix = `本批次引用了 GPU 主机上的文件，已锁定到主机「${pinned?.name ?? `#${pinnedHostId}`}」`
  if (!pinned) return { level: 'warning', message: `${prefix}，但该主机已不存在，任务无人执行` }
  if (pinned.enabled !== 1) {
    return { level: 'warning', message: `${prefix}，但该主机未参与调度，任务要等它恢复调度后才会执行` }
  }
  if (pinned.online !== true) {
    const why = pinned.online === false ? '当前离线' : '尚未探测到在线'
    return { level: 'warning', message: `${prefix}，但该主机${why}，任务要等它恢复后才会执行` }
  }
  return { level: 'info', message: `${prefix}，将只在该主机执行` }
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
