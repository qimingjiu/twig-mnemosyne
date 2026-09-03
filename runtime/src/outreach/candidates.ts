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

export function matchesCron(expr: string, now: Date = new Date(), tz?: string): boolean {
  try {
    // currentDate 取 now+1ms：cron 语义为「上一触发点落在当前分钟内」（prev 不含等于时刻）
    // tz 与 quiet_hours 同源（preferences.tz）：不传会按服务器时区匹配，与用户本地时刻错位
    const interval = cronParser.parseExpression(expr, { currentDate: new Date(now.getTime() + 1), tz: tz || undefined })
    const prev = interval.prev().toDate()
    return now.getTime() - prev.getTime() < 60_000 && prev <= now
  } catch {
    return false // 非法 cron/时区永不触发，配置校验在写入侧负责
  }
}

function invitationActive(claim: TwigClaim): boolean {
  const inv = claim.rementionInvitation
  if (!inv) return false
  if (inv.status === 'redeemed') return false // 上游 v0.3.1：user_engaged 消费后不再命中（小写枚举）
  // 上游 P2-4：邀请 30 天后过期（renderPromptText 不再注入，宿主侧同步失效）
  const ageDays = (Date.now() - Date.parse(inv.at)) / 86_400_000
  if (!Number.isNaN(ageDays) && ageDays > 30) return false
  return true
}

export async function scanCandidate(
  db: Db,
  twig: TwigAdapter,
  user: { id: string; eternalId: string; preferences: Record<string, unknown> },
  now: Date = new Date(),
): Promise<OutreachCandidate | null> {
  // 1. remention：授权源 = Narrative Engine 的再提邀请（§19.1.1）。
  //    上游真实语义（core.ts §5.4 债务⑦）：邀请只挂在 contested 论断上——
  //    被否决的观察积累 ≥3 条独立新证据且过 14 天冷却后才生成邀请； redeemed / 超 30 天不再命中。
  //    防纠缠（§19.6）：宿主侧对同一 claim 的 remention 再加 7 天投递冷却——
  //    dedupe_key 的 5 分钟桶只防同刻重放，防不了下一轮 cron 的重复兑现。
  try {
    const claims = await twig.listClaims(user.eternalId)
    const invited = claims.find(c => c.status === 'contested' && invitationActive(c))
    if (invited) {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM outreach
            WHERE user_id = $1 AND outreach_type = 'remention' AND claim_id = $2
              AND status IN ('delivered','completed')
              AND created_at > NOW() - INTERVAL '7 days'
         ) AS exists`,
        [user.id, invited.id],
      )
      if (!(rows[0]?.exists)) {
        return {
          outreachType: 'remention',
          targetId: invited.id,
          claimId: invited.id,
          hint: `你之前对某个判断纠正过用户，后来被本人否决了；现在有了新的独立迹象，认识层已生成邀请式再提议：「${invited.rementionInvitation?.text ?? ''}」。请在容得下反驳的时机、以邀请式措辞自然提出——若再次被否决，该观察将被永久封存。`,
        }
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
    const tz = typeof user.preferences['tz'] === 'string' ? (user.preferences['tz'] as string) : undefined
    for (const r of rituals) {
      const ritual = r as Partial<RitualConfig>
      if (typeof ritual?.cron === 'string' && matchesCron(ritual.cron, now, tz)) {
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
