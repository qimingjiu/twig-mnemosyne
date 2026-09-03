/**
 * §19.3.5 Transactional Outbox Worker（每 30s 轮询）。
 * 两个职责：
 * 1. delivery_pending 打捞：投递失败行按 retry_backoff 退避重投（幂等键复用落库 dedupe_key），
 *    超限标 failed/delivery_exhausted——主管线只管抢新槽生成新文案，从不会回访失败行，
 *    没有这个分支 delivery_attempts 恒 ≤1、delivery_exhausted 是死代码、TG 抖一下当天触达就丢；
 * 2. intervene 补报：deliver 成功后异步补报 twig（at-least-once）：
 *    - 崩溃恢复：status='delivered' AND intervention_status='pending' 的行重启后自动续报（T9.6/T9.11）
 *    - 退避：retry_backoff [60, 300, 900] 秒；超 max_retries → failed + 告警（INV-H02 打破必须可见）
 *
 * 补丁原文示例传 outcome:'pre_intervention'，但 outcome 枚举并不含该值
 * （它属于 evidenceLevel）。因此初始上报只带 evidenceLevel='post_intervention'；
 * outcome（user_engaged → REDEEMED）由用户真实回应后的更新调用携带。
 */
import type { Pool } from 'pg'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import type { WebhookGuardOptions } from '../identity/webhookGuard.js'
import { deliverOutreach } from './deliver.js'
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

interface PendingDeliveryRow {
  id: string
  user_id: string
  content: string
  dedupe_key: string
  delivery_attempts: number
  updated_at: Date
}

export interface OutboxDeps {
  db: Pool
  twig: TwigAdapter
  guard: WebhookGuardOptions
  cfg: HuginnConfig
  log?: (msg: string) => void
}

/** 卡死行的投递重试：backoff 到点才重投；同一 dedupe_key 接收方按 Idempotency-Key 去重不重复展示。 */
async function retryPendingDeliveries(deps: OutboxDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const { rows } = await deps.db.query<PendingDeliveryRow>(
    `SELECT id, user_id, content, dedupe_key, delivery_attempts, updated_at
       FROM outreach
      WHERE status = 'delivery_pending' AND dedupe_key <> ''
      ORDER BY updated_at ASC
      LIMIT 10`,
  )
  for (const row of rows) {
    const backoffs = deps.cfg.outbox.retry_backoff
    const backoffSec = backoffs[Math.min(row.delivery_attempts, backoffs.length - 1)] ?? 60
    const eligibleAt = new Date(row.updated_at).getTime() + backoffSec * 1000
    if (Date.now() < eligibleAt) continue

    const delivery = await deliverOutreach(deps.db, deps.guard, row.user_id, row.content, row.dedupe_key)
    if (delivery.ok) {
      await deps.db.query(
        `UPDATE outreach SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'delivery_pending'`,
        [row.id],
      )
      log(`[huginn] delivery retry succeeded outreach=${row.id}`)
    } else {
      const attempts = row.delivery_attempts + 1
      if (attempts >= deps.cfg.outbox.max_retries) {
        await deps.db.query(
          `UPDATE outreach
              SET delivery_attempts = $1, last_delivery_error = $2,
                  status = 'failed', filter_reason = 'delivery_exhausted', updated_at = NOW()
            WHERE id = $3 AND status = 'delivery_pending'`,
          [attempts, (delivery.error ?? 'unknown').slice(0, 500), row.id],
        )
        log(`[huginn][alert] delivery permanently failed outreach=${row.id}: ${delivery.error ?? 'unknown'}`)
      } else {
        await deps.db.query(
          `UPDATE outreach
              SET delivery_attempts = $1, last_delivery_error = $2, updated_at = NOW()
            WHERE id = $3 AND status = 'delivery_pending'`,
          [attempts, (delivery.error ?? 'unknown').slice(0, 500), row.id],
        )
      }
    }
  }
}

export async function runOutboxWorker(deps: OutboxDeps): Promise<void> {
  const { db, cfg } = deps
  const log = deps.log ?? ((m: string) => console.log(m))
  await retryPendingDeliveries(deps)
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
