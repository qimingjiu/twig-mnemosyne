/**
 * §19.3.5 Transactional Outbox Worker（每 30s 轮询）。
 * deliver 成功后 intervene 由本 worker 异步补报，at-least-once：
 * - 崩溃恢复：status='delivered' AND intervention_status='pending' 的行重启后自动续报（T9.6/T9.11）
 * - 退避：retry_backoff [60, 300, 900] 秒；超 max_retries → failed + 告警（INV-H02 打破必须可见）
 *
 * 补丁原文示例传 outcome:'pre_intervention'，但 outcome 枚举并不含该值
 * （它属于 evidenceLevel）。因此初始上报只带 evidenceLevel='post_intervention'；
 * outcome（user_engaged → REDEEMED）由用户真实回应后的更新调用携带。
 */
import type { Pool } from 'pg'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import type { HuginnConfig } from './policy.js'

interface OutboxRow {
  id: string
  user_id: string
  claim_id: string | null
  content: string
  intervention_attempts: number
  updated_at: Date
  eternal_id: string
}

export interface OutboxDeps {
  db: Pool
  twig: TwigAdapter
  cfg: HuginnConfig
  log?: (msg: string) => void
}

export async function runOutboxWorker(deps: OutboxDeps): Promise<void> {
  const { db, cfg } = deps
  const log = deps.log ?? ((m: string) => console.log(m))
  const { rows } = await db.query<OutboxRow>(
    `SELECT o.id, o.user_id, o.claim_id, o.content, o.intervention_attempts, o.updated_at, u.eternal_id
       FROM outreach o
       JOIN users u ON u.id = o.user_id
      WHERE o.status = 'delivered' AND o.intervention_status = 'pending'
      ORDER BY o.created_at ASC
      LIMIT 10`,
  )

  for (const row of rows) {
    const backoffs = cfg.outbox.retry_backoff
    const backoffSec = backoffs[Math.min(row.intervention_attempts, backoffs.length - 1)] ?? 60
    const eligibleAt = new Date(row.updated_at).getTime() + backoffSec * 1000
    if (Date.now() < eligibleAt) continue

    try {
      await deps.twig.intervene(row.eternal_id, row.claim_id ?? undefined, row.content, {
        evidenceLevel: 'post_intervention',
      })
      await db.query(
        `UPDATE outreach
            SET intervention_status = 'reported', status = 'completed',
                intervened_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [row.id],
      )
    } catch (e) {
      const attempts = row.intervention_attempts + 1
      const msg = e instanceof Error ? e.message : String(e)
      if (attempts >= cfg.outbox.max_retries) {
        await db.query(
          `UPDATE outreach
              SET intervention_attempts = $1, intervention_status = 'failed', status = 'failed',
                  last_intervention_error = $2, filter_reason = 'intervention_exhausted', updated_at = NOW()
            WHERE id = $3`,
          [attempts, msg.slice(0, 500), row.id],
        )
        // Dashboard 告警锚点：INV-H02（delivered ⇒ eventually intervene_reported）被打破
        log(`[huginn][alert] intervention permanently failed outreach=${row.id}: ${msg}`)
      } else {
        await db.query(
          `UPDATE outreach
              SET intervention_attempts = $1, last_intervention_error = $2, updated_at = NOW()
            WHERE id = $3`,
          [attempts, msg.slice(0, 500), row.id],
        )
      }
    }
  }
}
