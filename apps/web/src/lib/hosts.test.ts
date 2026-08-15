import { describe, expect, it } from 'vitest'
import type { HostDto } from './api'
import {
  formatDuration,
  hasUsableHost,
  onlineSummary,
  pinnedHostNotice,
  referenceHost,
  rentalCost,
  rentalMinutes,
  toLocalDatetimeInput,
} from './hosts'

const host = (over: Partial<HostDto>): HostDto => ({
  id: 1,
  name: 'A',
  url: 'http://a:8188',
  note: null,
  active: 0,
  enabled: 1,
  kind: 'resident',
  rentedAt: null,
  hourlyRate: null,
  disabledReason: null,
  online: true,
  pinnedBatches: 0,
  createdAt: '2026-08-15T00:00:00Z',
  ...over,
})

describe('onlineSummary', () => {
  it('只统计参与调度的主机', () => {
    const hosts = [
      host({ id: 1, online: true }),
      host({ id: 2, online: false }),
      host({ id: 3, online: true, enabled: 0 }), // 未参与调度,不计入
    ]
    expect(onlineSummary(hosts)).toEqual({ online: 1, total: 2 })
  })

  it('未探测过(null)不算在线', () => {
    expect(onlineSummary([host({ online: null })])).toEqual({ online: 0, total: 1 })
  })
})

describe('hasUsableHost', () => {
  it('存在既参与调度又在线的主机才算可用', () => {
    expect(hasUsableHost([host({ online: true })])).toBe(true)
    expect(hasUsableHost([host({ online: false })])).toBe(false)
    expect(hasUsableHost([host({ online: true, enabled: 0 })])).toBe(false)
    expect(hasUsableHost([])).toBe(false)
  })
})

describe('referenceHost', () => {
  it('取 active=1 的那台', () => {
    const hosts = [host({ id: 1 }), host({ id: 2, active: 1 })]
    expect(referenceHost(hosts)?.id).toBe(2)
  })
  it('没有 active 时返回 undefined', () => {
    expect(referenceHost([host({})])).toBeUndefined()
  })
})

describe('pinnedHostNotice', () => {
  it('锁定主机可用时才说「将只在该主机执行」', () => {
    const n = pinnedHostNotice([host({ id: 7, name: 'A', enabled: 1, online: true })], 7)
    expect(n.level).toBe('info')
    expect(n.message).toContain('将只在该主机执行')
    expect(n.message).toContain('A')
  })

  it('锁定主机未参与调度(比如刚被熔断)时给告警,且不承诺会执行', () => {
    const n = pinnedHostNotice([host({ id: 7, name: 'A', enabled: 0, online: true })], 7)
    expect(n.level).toBe('warning')
    expect(n.message).toContain('未参与调度')
    expect(n.message).not.toContain('将只在该主机执行')
  })

  it('锁定主机离线/未探测到在线时给告警', () => {
    expect(pinnedHostNotice([host({ id: 7, online: false })], 7).level).toBe('warning')
    expect(pinnedHostNotice([host({ id: 7, online: null })], 7).level).toBe('warning')
  })

  it('锁定主机已不存在时给告警;主机列表没加载时只陈述事实', () => {
    expect(pinnedHostNotice([], 7).message).toContain('已不存在')
    expect(pinnedHostNotice(undefined, 7).level).toBe('info')
  })
})

describe('租用时长与费用', () => {
  const t0 = Date.parse('2026-08-15T00:00:00Z')

  it('按起租时间算已运行分钟数', () => {
    expect(rentalMinutes('2026-08-15T00:00:00Z', t0 + 3 * 3600_000 + 12 * 60_000)).toBe(192)
  })

  it('时长格式化', () => {
    expect(formatDuration(192)).toBe('3h 12m')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(120)).toBe('2h 0m')
  })

  it('费用按小时单价折算,无单价返回 null', () => {
    expect(rentalCost('2026-08-15T00:00:00Z', 2, t0 + 90 * 60_000)).toBeCloseTo(3)
    expect(rentalCost('2026-08-15T00:00:00Z', null, t0 + 90 * 60_000)).toBeNull()
  })

  it('起租时间在未来时按 0 处理,不出负数', () => {
    expect(rentalMinutes('2026-08-15T01:00:00Z', t0)).toBe(0)
    expect(rentalCost('2026-08-15T01:00:00Z', 2, t0)).toBe(0)
  })
})

describe('toLocalDatetimeInput', () => {
  it('与 new Date(v).toISOString() 互为逆运算,与运行时区无关', () => {
    // 分钟精度的 UTC 瞬间;datetime-local 只到分钟,往返后应精确复原,不受时区影响。
    // 若改用 slice(0, 16) 之类的字符串裁剪实现,这个断言在非 UTC 时区下会失败。
    const original = '2026-08-10T12:30:00.000Z'
    const local = toLocalDatetimeInput(original)
    expect(new Date(local).toISOString()).toBe(original)
  })

  it('非法输入返回空字符串', () => {
    expect(toLocalDatetimeInput('not-a-date')).toBe('')
  })
})
