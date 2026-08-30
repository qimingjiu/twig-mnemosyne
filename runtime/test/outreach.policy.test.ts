import { describe, it, expect } from 'vitest'
import { inQuietHours, evaluatePolicy } from '../src/outreach/policy.js'
import { matchesCron } from '../src/outreach/candidates.js'
import { outreachDedupeKey, minuteBucket } from '../src/outreach/reserve.js'

describe('§19 quiet hours（用户本地时区，跨午夜回绕）', () => {
  // 2026-08-30 12:00 UTC = 20:00 北京 = 05:00 UTC
  const noonUtc = new Date('2026-08-30T12:00:00Z')

  it('默认 01:00-08:00：UTC 05:00 命中静默', () => {
    expect(inQuietHours(new Date('2026-08-30T05:30:00Z'), undefined, '01:00-08:00')).toBe(true)
  })

  it('北京时区 20:00 不在静默段', () => {
    expect(inQuietHours(noonUtc, 'Asia/Shanghai', '01:00-08:00')).toBe(false)
  })

  it('跨午夜区间 23:00-07:00：凌晨 02:00 命中、白天不命中', () => {
    expect(inQuietHours(new Date('2026-08-30T18:00:00Z'), 'UTC', '23:00-07:00')).toBe(false) // 18:00 UTC
    // 02:00 UTC 当天：构造 2026-08-30T02:00:00Z
    expect(inQuietHours(new Date('2026-08-30T02:00:00Z'), 'UTC', '23:00-07:00')).toBe(true)
    // 23:30 UTC 命中
    expect(inQuietHours(new Date('2026-08-30T23:30:00Z'), 'UTC', '23:00-07:00')).toBe(true)
  })

  it('非法区间/非法时区不静默（宁多推不静默错误）', () => {
    expect(inQuietHours(noonUtc, 'UTC', 'garbage')).toBe(false)
    expect(inQuietHours(noonUtc, 'Not/AZone', '01:00-08:00')).toBe(false)
  })
})

describe('§19.3.3 Final Policy Check 过滤链', () => {
  const base = {
    muted: false,
    crisisSilenceUntil: null,
    quietHours: '01:00-08:00',
    lastDeliveredAt: null,
    minIntervalMinutes: 180,
  }
  const day = new Date('2026-08-30T12:00:00Z')

  it('INV-H03：muted 硬过滤', () => {
    expect(evaluatePolicy({ ...base, muted: true }, day)).toMatchObject({ pass: false, reason: 'muted' })
  })

  it('INV-H04：crisis_silence 活跃期硬过滤（T9.2）', () => {
    expect(evaluatePolicy({ ...base, crisisSilenceUntil: new Date(day.getTime() + 3600_000) }, day))
      .toMatchObject({ pass: false, reason: 'crisis_silence' })
  })

  it('min_interval：距上次投递 <180min 拦截', () => {
    expect(evaluatePolicy({ ...base, lastDeliveredAt: new Date(day.getTime() - 60_000) }, day))
      .toMatchObject({ pass: false, reason: 'min_interval' })
    expect(evaluatePolicy({ ...base, lastDeliveredAt: new Date(day.getTime() - 200 * 60_000) }, day).pass).toBe(true)
  })

  it('全绿放行', () => {
    expect(evaluatePolicy(base, day).pass).toBe(true)
  })
})

describe('§19.2 ritual cron 与幂等键', () => {
  it('matchesCron：*/15 命中整刻，不命中 :07', () => {
    expect(matchesCron('*/15 * * * *', new Date('2026-08-30T12:15:00Z'))).toBe(true)
    expect(matchesCron('*/15 * * * *', new Date('2026-08-30T12:07:00Z'))).toBe(false)
    expect(matchesCron('not a cron', new Date())).toBe(false)
  })

  it('T9.8 语义：dedupeKey 由 user+type+target+5min 桶唯一决定', () => {
    const a = outreachDedupeKey('u1', 'vein-nudge', 'thread-1', 100)
    const b = outreachDedupeKey('u1', 'vein-nudge', 'thread-1', 100)
    const c = outreachDedupeKey('u1', 'vein-nudge', 'thread-2', 100)
    const d = outreachDedupeKey('u1', 'vein-nudge', 'thread-1', 200)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).toHaveLength(64) // VARCHAR(64) 上限
  })

  it('minuteBucket：5 分钟粒度', () => {
    expect(minuteBucket(0)).toBe(0)
    expect(minuteBucket(299_999)).toBe(0)
    expect(minuteBucket(300_000)).toBe(1)
  })
})
