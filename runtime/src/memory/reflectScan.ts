/**
 * 反刍排程（技术文档 §运维「每日：cron 对每个近 24h 活跃用户调 reflect；失败重试 1 次」）。
 * 此前排程从未落地——TwigAdapter.reflect 无人调用，反刍（认识层唯一写入者）一次都不会触发。
 *
 * 反刍是纯内部记忆维护，不触达用户，因此不走 Huginn 的 muted/quiet_hours/危机静默策略门。
 * MUNINN_AUTO_REFLECT 保持关闭（仅覆盖已加载用户），排程单一事实源在 Runtime 侧。
 */
import type { Pool } from 'pg'
import { reflectTotal } from '../observability/metrics.js'
import type { TwigAdapter } from './TwigAdapter.js'

export interface ReflectScanDeps {
  db: Pool
  twig: TwigAdapter
  /** 活跃窗口：近 N 小时有过用户消息才参与反刍 */
  activeHours: number
  /** 单用户 reflect 超时（透传 TwigAdapter.reflect） */
  timeoutMs: number
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

export interface ReflectScanResult {
  scanned: number
  ok: number
  failed: number
  failures: { userId: string; error: string }[]
}

interface ReflectSummary {
  queued?: boolean
  claimsCreated?: number
  claimsRewritten?: number
  skipped?: string[]
}

function summarize(r: unknown): string {
  const s = (r ?? {}) as ReflectSummary
  // async 点火返回 202 {queued:true}——结果在 twig 日志（[reflect async] done/failed）
  if (s.queued) return 'queued'
  const parts = [`claims+${s.claimsCreated ?? 0}`, `rewrite+${s.claimsRewritten ?? 0}`]
  if (s.skipped?.length) parts.push(`skipped[${s.skipped.join(',')}]`)
  return parts.join(' ')
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function runReflectScan(deps: ReflectScanDeps): Promise<ReflectScanResult> {
  const log = deps.log ?? (() => undefined)
  const warn = deps.warn ?? log
  const { rows } = await deps.db.query<{ eternal_id: string }>(
    `SELECT DISTINCT u.eternal_id
       FROM users u
       JOIN sessions s ON s.user_id = u.id
       JOIN conversation_messages m ON m.session_id = s.id
      WHERE m.role = 'user' AND m.created_at > NOW() - make_interval(hours => $1::int)
      ORDER BY u.eternal_id`,
    [deps.activeHours],
  )

  const result: ReflectScanResult = { scanned: rows.length, ok: 0, failed: 0, failures: [] }
  for (const { eternal_id } of rows) {
    try {
      // async 点火：202 立即返回，反刍在 twig 后台执行——不用长响应等它，也不再重试空排队
      const r = await deps.twig.reflect(eternal_id, deps.timeoutMs, { async: true })
      result.ok++
      reflectTotal.inc({ outcome: 'ok' })
      log(`[reflect] ok user ${eternal_id.slice(0, 8)}…: ${summarize(r)}`)
    } catch (first) {
      // 技术文档口径：失败重试 1 次
      try {
        const r = await deps.twig.reflect(eternal_id, deps.timeoutMs, { async: true })
        result.ok++
        reflectTotal.inc({ outcome: 'ok' })
        log(`[reflect] ok after retry user ${eternal_id.slice(0, 8)}…: ${summarize(r)}`)
      } catch (second) {
        result.failed++
        const error = errMsg(second)
        result.failures.push({ userId: eternal_id, error })
        reflectTotal.inc({ outcome: 'failed' })
        // 连续失败告警（进 Dashboard 的观测面是 /metrics + 错误日志）
        warn(`[reflect] user ${eternal_id.slice(0, 8)}… failed after retry: ${error}`)
      }
    }
  }
  if (result.scanned > 0) {
    log(`[reflect] scan done: ${result.ok}/${result.scanned} ok, ${result.failed} failed`)
  }
  return result
}
