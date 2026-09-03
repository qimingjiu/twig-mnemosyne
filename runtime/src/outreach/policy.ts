/**
 * §19.3.3 Final Policy Check 的策略求值（纯逻辑，可单测）。
 * 检查 scan→deliver 时间窗口内可能变化的用户侧动态配置。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { env } from '../config.js'

export interface HuginnConfig {
  enabled: boolean
  scan_interval: string
  outbox_worker_interval: number
  daily_cap: number
  min_interval_minutes: number
  quiet_hours: string
  crisis_silence_hours: number
  generation: { max_chars: number; temperature: number; chain: string[] }
  outbox: { max_retries: number; retry_backoff: number[] }
}

export const HUGINN_DEFAULTS: HuginnConfig = {
  enabled: true,
  scan_interval: '*/15 * * * *',
  outbox_worker_interval: 30,
  daily_cap: 3,
  min_interval_minutes: 180,
  quiet_hours: '01:00-08:00',
  crisis_silence_hours: 24,
  generation: { max_chars: 280, temperature: 0.7, chain: ['gpt-4o', 'claude-sonnet', 'gemini-pro'] },
  outbox: { max_retries: 3, retry_backoff: [60, 300, 900] },
}

/** config/huginn.yaml（§19.4 补丁版），缺项回落默认值。 */
export function loadHuginnConfig(dir = env.CONFIG_DIR): HuginnConfig {
  try {
    const raw = parse(readFileSync(join(dir, 'huginn.yaml'), 'utf8')) as { huginn?: Partial<HuginnConfig> }
    const h = raw.huginn ?? {}
    return {
      ...HUGINN_DEFAULTS,
      ...h,
      generation: { ...HUGINN_DEFAULTS.generation, ...(h.generation ?? {}) },
      outbox: { ...HUGINN_DEFAULTS.outbox, ...(h.outbox ?? {}) },
    }
  } catch {
    return { ...HUGINN_DEFAULTS }
  }
}

/** "01:00-08:00"（用户本地时区）；跨午夜区间自动回绕。 */
export function inQuietHours(now: Date, tz: string | undefined, range: string): boolean {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range.trim())
  if (!m) return false
  const startH = Number(m[1]), startM = Number(m[2]), endH = Number(m[3]), endM = Number(m[4])
  let local = '00:00'
  try {
    local = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(now)
  } catch {
    return false // 非法时区按不静默处理，告警由调用方负责
  }
  const [hRaw, minRaw] = local.split(':')
  // en-GB + h24 在部分 ICU 版本把午夜格式化成 "24:00"：不归零的话，起点为 00:00 的静默区间
  // 在恰好午夜那一分钟判定落空
  const h = Number(hRaw) === 24 ? 0 : Number(hRaw)
  const t = (Number.isNaN(h) ? 0 : h) * 60 + (Number(minRaw) ?? 0)
  const s = startH * 60 + startM
  const e = endH * 60 + endM
  if (s === e) return false
  if (s < e) return t >= s && t < e
  return t >= s || t < e // 跨午夜
}

export interface PolicyContext {
  muted: boolean
  crisisSilenceUntil: Date | null
  tz?: string
  quietHours: string
  lastDeliveredAt: Date | null
  minIntervalMinutes: number
}

export interface PolicyVerdict {
  pass: boolean
  reason?: string
}

/**
 * 过滤链顺序：muted → crisis_silence → quiet_hours → min_interval
 * （INV-H03 / INV-H04：muted 与危机静默是硬过滤，无绕过通道——投递统一走 OutreachDeliverer 单点）
 */
export function evaluatePolicy(ctx: PolicyContext, now: Date = new Date()): PolicyVerdict {
  if (ctx.muted) return { pass: false, reason: 'muted' }
  if (ctx.crisisSilenceUntil && ctx.crisisSilenceUntil.getTime() > now.getTime()) {
    return { pass: false, reason: 'crisis_silence' }
  }
  if (inQuietHours(now, ctx.tz, ctx.quietHours)) return { pass: false, reason: 'quiet_hours' }
  if (ctx.lastDeliveredAt) {
    const elapsedMin = (now.getTime() - ctx.lastDeliveredAt.getTime()) / 60_000
    if (elapsedMin < ctx.minIntervalMinutes) return { pass: false, reason: 'min_interval' }
  }
  return { pass: true }
}
