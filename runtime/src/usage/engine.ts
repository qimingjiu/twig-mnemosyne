/** §9 Usage Engine：采集指标 → Dashboard / Cache Policy / Router。 */
import type { Db } from '../db.js'

export interface UsageRecordInput {
  requestId: string
  userId: string
  sessionId: string
  clientType: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  latencyMs: number
  cacheHitType?: 'exact' | 'semantic' | 'provider' | 'context' | 'miss'
  cacheSavedTokens?: number
  costUsd?: number
  estimatedSavings?: number
  routeReason?: string
  fallbackCount?: number
  error?: boolean
  errorType?: string
  errorMessage?: string
  ttsChars?: number
  privacyTier?: 'cloud' | 'local'
  outreachType?: 'remention' | 'vein-nudge' | 'ritual'
}

export async function recordUsage(db: Db, rec: UsageRecordInput): Promise<void> {
  await db.query(
    `INSERT INTO usage_logs (
       request_id, user_id, session_id, client_type, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       latency_ms, cache_hit_type, cache_saved_tokens, cost_usd, estimated_savings,
       route_reason, fallback_count, error, error_type, error_message,
       tts_chars, privacy_tier, outreach_type
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      rec.requestId,
      rec.userId,
      rec.sessionId,
      rec.clientType,
      rec.provider,
      rec.model,
      rec.inputTokens,
      rec.outputTokens,
      rec.cacheReadTokens ?? 0,
      rec.cacheWriteTokens ?? 0,
      rec.latencyMs,
      rec.cacheHitType ?? 'miss',
      rec.cacheSavedTokens ?? 0,
      rec.costUsd ?? null,
      rec.estimatedSavings ?? null,
      rec.routeReason ?? null,
      rec.fallbackCount ?? 0,
      rec.error ?? false,
      rec.errorType ?? null,
      rec.errorMessage ? rec.errorMessage.slice(0, 2000) : null,
      rec.ttsChars ?? null,
      rec.privacyTier ?? null,
      rec.outreachType ?? null,
    ],
  )
}

/** §21.6 月度告警：Usage Engine 统计 tts_chars，阈值 8,000（留 2k 缓冲）。 */
export async function ttsCharsThisMonth(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(tts_chars), 0) AS total
       FROM usage_logs
      WHERE user_id = $1
        AND timestamp >= date_trunc('month', NOW())`,
    [userId],
  )
  return Number(rows[0]?.total ?? 0)
}
