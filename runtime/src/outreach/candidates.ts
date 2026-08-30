/**
 * §19.2/§19.3.2 候选扫描。
 *
 * 授权来源完全不同（§19.1.1）：
 * - remention：Narrative Engine 的 rementionInvitation（认识层明确邀请，一次性票据）
 * - vein-nudge：dragonVein + daysOpen ≥3 + 独立证据检测（推断候选，需额外 eligibility）
 * - ritual：users.preferences.rituals[]（用户显式配置，按 cron 周期）
 *
 * 独立证据检测的诚实注记：TwigContextPacket @89a7881 的 threads 不含
 * last_user_evidence_at / last_huginn_outreach_at 字段，hasIndependentEvidence 无法按
 * 补丁公式原样计算。当前以两条替代防线近似：① 宿主侧 7 天 thread 冷却（§19.3.6.3 硬规则）；
 * ② 全部触达以 evidenceLevel='post_intervention' 上报，由 Twig reflect 权重降级兜底。
 * 上游补充证据时间戳字段后（R 请求），恢复补丁公式。
 */
import type { Db } from '../db.js'
import type { TwigClaim } from '../memory/types.js'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import cronParser from 'cron-parser'

export interface RitualConfig {
  name: string
  cron: string
  message?: string
}

export interface OutreachCandidate {
  outreachType: 'remention' | 'vein-nudge' | 'ritual'
  targetId: string
  claimId?: string
  threadId?: string
  hint: string
}

export function matchesCron(expr: string, now: Date = new Date()): boolean {
  try {
    // currentDate 取 now+1ms：cron 语义为「上一触发点落在当前分钟内」（prev 不含等于时刻）
    const interval = cronParser.parseExpression(expr, { currentDate: new Date(now.getTime() + 1) })
    const prev = interval.prev().toDate()
    return now.getTime() - prev.getTime() < 60_000 && prev <= now
  } catch {
    return false // 非法 cron 永不触发，配置校验在写入侧负责
  }
}

function invitationActive(claim: TwigClaim): boolean {
  const inv = claim.rementionInvitation
  if (!inv) return false
  if (inv.status === 'REDEEMED') return false
  if (typeof inv.expiresAt === 'string') {
    const exp = Date.parse(inv.expiresAt)
    if (!Number.isNaN(exp) && exp < Date.now()) return false
  }
  return true
}

export async function scanCandidate(
  db: Db,
  twig: TwigAdapter,
  user: { id: string; eternalId: string; preferences: Record<string, unknown> },
  now: Date = new Date(),
): Promise<OutreachCandidate | null> {
  // 1. remention：一次性票据；Twig 侧 REDEEMED 后 scan 不再命中
  try {
    const claims = await twig.listClaims(user.eternalId)
    const invited = claims.find(c => c.status === 'active' && invitationActive(c))
    if (invited) {
      return {
        outreachType: 'remention',
        targetId: invited.id,
        claimId: invited.id,
        hint: `此前用户与自己有过一个未决认识：「${invited.text}」。这是对当初再提邀请的兑现——自然地、不施压地重新提起这个话题，关心它现在的状态。`,
      }
    }
  } catch {
    return null // twig 不可用 → 本轮放弃（不再消耗其他候选类型）
  }

  // 2. vein-nudge：dragonVein 降序 + daysOpen ≥3 + 7 天 thread 冷却（§19.3.6.3）
  const packet = await twig.getContextPacket(user.eternalId)
  const { rows } = await db.query<{ thread_id: string | null }>(
    `SELECT thread_id FROM outreach
      WHERE user_id = $1 AND outreach_type = 'vein-nudge'
        AND created_at > NOW() - INTERVAL '7 days' AND status <> 'filtered'`,
    [user.id],
  )
  const cooled = new Set(rows.map(r => r.thread_id))
  const threads = [...packet.threads].sort((a, b) => b.dragonVein - a.dragonVein)
  const thread = threads.find(t => t.daysOpen >= 3 && !cooled.has(t.id))
  if (thread) {
    return {
      outreachType: 'vein-nudge',
      targetId: thread.id,
      threadId: thread.id,
      hint: `用户有一条开放线索「${thread.label}」已悬置 ${thread.daysOpen} 天，其中悬而未决的问题是：「${thread.openQuestion}」。请轻推一次——温和、简短，一次只提这一条线索，不追问、不施压。`,
    }
  }

  // 3. ritual：用户显式配置授权，不需要 Narrative Engine 认可
  const rituals = user.preferences['rituals']
  if (Array.isArray(rituals)) {
    for (const r of rituals) {
      const ritual = r as Partial<RitualConfig>
      if (typeof ritual?.cron === 'string' && matchesCron(ritual.cron, now)) {
        const name = typeof ritual.name === 'string' ? ritual.name : 'ritual'
        const message = typeof ritual.message === 'string' ? ritual.message : ''
        return {
          outreachType: 'ritual',
          targetId: name,
          hint: message
            ? `用户配置了名为「${name}」的节律触达。按其设定传递：${message}`
            : `用户配置了名为「${name}」的节律触达，现在是设定的时刻。自然地问候或提醒。`,
        }
      }
    }
  }

  return null
}
