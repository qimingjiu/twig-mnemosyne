/**
 * §19.3 主管线 —— 分布式状态机：
 *   reserved → generated → delivery_pending → delivered →（Outbox Worker 接手）→ completed
 * 分支终态：filtered（策略/无候选，filter_reason 持久化，AUDIT-11）/ failed（重试耗尽）
 *
 * 本文件负责推进到 delivered；intervene 补报由 outboxWorker.ts 负责（INV-H02）。
 */
import type { Pool } from 'pg'
import { env } from '../config.js'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import type { ModelGateway } from '../gateways/litellm.js'
import type { UserRow } from '../identity/service.js'
import { validateWebhookUrl, type WebhookGuardOptions } from '../identity/webhookGuard.js'
import { loadHuginnConfig, evaluatePolicy, type HuginnConfig } from './policy.js'
import { reserveOutreachSlot, outreachDedupeKey, minuteBucket } from './reserve.js'
import { scanCandidate } from './candidates.js'
import { generateOutreach } from './generate.js'
import { deliverOutreach } from './deliver.js'

export interface OutreachDeps {
  db: Pool
  twig: TwigAdapter
  gateway: ModelGateway
  guard: WebhookGuardOptions
  cfg: HuginnConfig
  log?: (msg: string) => void
}

interface PolicySourceRow {
  muted: boolean
  crisis_silence_until: Date | null
  tz: string | null
  last_delivered_at: Date | null
}

async function loadPolicyContext(
  db: Pool,
  userId: string,
  cfg: HuginnConfig,
): Promise<{ ctx: ReturnType<typeof toPolicyCtx> }> {
  const { rows } = await db.query<PolicySourceRow>(
    `SELECT u.preferences ->> 'huginn_muted' = 'true' AS muted,
            u.crisis_silence_until,
            u.preferences ->> 'tz' AS tz,
            (SELECT MAX(delivered_at) FROM outreach
              WHERE user_id = u.id AND delivered_at IS NOT NULL) AS last_delivered_at
       FROM users u WHERE u.id = $1`,
    [userId],
  )
  const row = rows[0]
  return { ctx: toPolicyCtx(row, cfg) }
}

function toPolicyCtx(row: PolicySourceRow | undefined, cfg: HuginnConfig) {
  return {
    muted: row?.muted ?? false,
    crisisSilenceUntil: row?.crisis_silence_until ?? null,
    tz: row?.tz ?? undefined,
    quietHours: cfg.quiet_hours,
    lastDeliveredAt: row?.last_delivered_at ?? null,
    minIntervalMinutes: cfg.min_interval_minutes,
  }
}

async function markFiltered(
  db: Pool,
  userId: string,
  date: string,
  slot: number,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE outreach SET status = 'filtered', filter_reason = $1, updated_at = NOW()
      WHERE user_id = $2 AND reservation_date = $3 AND slot_number = $4 AND status = 'reserved'`,
    [reason, userId, date, slot],
  )
}

async function markTerminal(
  db: Pool,
  userId: string,
  date: string,
  slot: number,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE outreach SET status = 'failed', filter_reason = $1, updated_at = NOW()
      WHERE user_id = $2 AND reservation_date = $3 AND slot_number = $4`,
    [reason, userId, date, slot],
  )
}
void markTerminal

export async function processUser(deps: OutreachDeps, user: UserRow): Promise<void> {
  const { db, cfg } = deps
  const log = deps.log ?? (() => undefined)
  const today = new Date().toISOString().slice(0, 10)

  // 1. 原子抢槽（INV-H01：sent_today ≤ daily_cap）
  const slot = await reserveOutreachSlot(db, user.id, cfg.daily_cap)
  if (!slot) return

  // 2. 初始策略扫描（快速淘汰，减少无效 slot 占用）
  const p1 = (await loadPolicyContext(db, user.id, cfg)).ctx
  const v1 = evaluatePolicy(p1)
  if (!v1.pass) {
    await markFiltered(db, user.id, today, slot, v1.reason ?? 'policy')
    return
  }

  // 3. 候选扫描（remention > vein-nudge > ritual）
  const candidate = await scanCandidate(db, deps.twig, {
    id: user.id,
    eternalId: user.eternal_id,
    preferences: user.preferences ?? {},
  })
  if (!candidate) {
    await markFiltered(db, user.id, today, slot, 'no_candidate')
    return
  }
  // contested 说明：claim 候选在 scanCandidate 内只取 status='active'，contested 论断天然不入选；
  // vein-nudge 的线索无 contested 语义。§4.7 的 contested 域检查守的是工具执行路径，不经此处。

  // 4. 生成文案（输出侧危机复扫在 generate 内部：踩线换链，全踩线兜底）
  const content = await generateOutreach(deps.gateway, candidate, cfg)
  await db.query(
    `UPDATE outreach
        SET status = 'generated', content = $1, outreach_type = $2, claim_id = $3, thread_id = $4, updated_at = NOW()
      WHERE user_id = $5 AND reservation_date = $6 AND slot_number = $7 AND status = 'reserved'`,
    [content, candidate.outreachType, candidate.claimId ?? null, candidate.threadId ?? null, user.id, today, slot],
  )

  // 5/6. Final Policy Check：scan→deliver 窗口内用户侧动态配置可能已变化（T9.9/T9.10）
  const p2 = (await loadPolicyContext(db, user.id, cfg)).ctx
  const v2 = evaluatePolicy(p2)
  if (!v2.pass) {
    await markFiltered(db, user.id, today, slot, v2.reason ?? 'policy')
    return
  }

  // 7. 幂等投递
  const dedupeKey = outreachDedupeKey(user.id, candidate.outreachType, candidate.targetId, minuteBucket())
  await db.query(
    `UPDATE outreach
        SET status = 'delivery_pending', dedupe_key = $1, dedupe_key_set_at = NOW(), updated_at = NOW()
      WHERE user_id = $2 AND reservation_date = $3 AND slot_number = $4`,
    [dedupeKey, user.id, today, slot],
  )
  const delivery = await deliverOutreach(db, deps.guard, user.id, content, dedupeKey)
  if (delivery.ok) {
    await db.query(
      `UPDATE outreach SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND reservation_date = $2 AND slot_number = $3`,
      [user.id, today, slot],
    )
    log(`[huginn] delivered ${candidate.outreachType} to user ${user.eternal_id.slice(0, 8)}… (slot ${slot})`)
    // 主管线到此结束，不等待 intervene（§19.3.5）
  } else {
    // 投递失败：计数并留 delivery_pending 由下轮重试；超限 → failed
    await db.query(
      `UPDATE outreach
          SET delivery_attempts = delivery_attempts + 1,
              last_delivery_error = $1,
              status = CASE WHEN delivery_attempts + 1 >= $2 THEN 'failed' ELSE 'delivery_pending' END,
              filter_reason = CASE WHEN delivery_attempts + 1 >= $2 THEN 'delivery_exhausted' ELSE filter_reason END,
              updated_at = NOW()
        WHERE user_id = $3 AND reservation_date = $4 AND slot_number = $5`,
      [delivery.error ?? 'unknown', cfg.outbox.max_retries, user.id, today, slot],
    )
  }
}

export async function runScan(deps: OutreachDeps): Promise<void> {
  const { rows } = await deps.db.query<UserRow>(
    `SELECT id, eternal_id, display_name, email, master_key_hash, crisis_silence_until, preferences FROM users`,
  )
  for (const user of rows) {
    try {
      await processUser(deps, user)
    } catch (e) {
      // 单用户失败不阻塞其他用户（队列串行）
      ;(deps.log ?? console.error)(`[huginn] user pipeline failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export function defaultGuard() {
  return {
    allowInsecure: env.ALLOW_INSECURE_WEBHOOK,
    allowlist: env.WEBHOOK_HOST_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean),
  }
}

export { validateWebhookUrl, loadHuginnConfig }
