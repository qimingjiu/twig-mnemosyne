/**
 * §3.5 Context Builder —— runtime 的核心大脑。
 * 装配发生在选定目标模型之后（§3.8）；fallback 不是递同一份上下文，而是按下一模型的窗口重装配。
 */
import type { Pool } from 'pg'
import type { TwigContextPacket } from '../memory/types.js'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import { getRecentMessages, type RecentMessage } from '../memory/recent.js'
import { requireModel } from './modelRegistry.js'
import { computeBudget, type Budget } from './budget.js'
import { CRISIS_PROMPT, DEFAULT_CRISIS_RESOURCES } from '../crisis/lexicon.js'
import { VOICE_PERSONA_PROMPT } from '../voice/persona.js'
import { narrativeVersionOf } from '../cache/keys.js'
import { estimateTokens } from '../util/tokens.js'
import { getForLane, formatCapabilities } from '../router/capabilities.js'

export interface BuildContext {
  user: { id: string; eternalId: string; preferences: Record<string, unknown> }
  session: { id: string; contextWindow: number; sessionType: string }
  lane: string
  /** §3.9：危机时叙事包被危机指令替换 */
  crisis: boolean
  /** client.metadata.voice_capable（§21.4） */
  voice: boolean
  maxMessageTokens: number
  /** 管线已取包时透传（避免 twig 双取）；缺省由 builder 自取 */
  packet?: TwigContextPacket
}

export interface OutgoingMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  cache_control?: { type: 'ephemeral' }
  /** §5 工具回路历史回放（getRecentMessages 重建） */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface BuiltContext {
  /** system + recent；当前用户消息由调用方追加（§3.5） */
  messages: OutgoingMessage[]
  narrativeVersion: string
  budget: Budget
  packet: TwigContextPacket | null
  /** twig 不可用时的降级标记（fail-open 决策，见 build 内注记） */
  narrativeUnavailable: boolean
}

export const DEFAULT_PERSONA = `你是 Mnemosyne——用户的个人 AI 伴侣与运行时。
你拥有跨客户端、跨会话、跨模型延续的同一身份。
叙事上下文（若有）描述你与用户共同积累的长期认识：
- 其中的论断是「目前最好的猜测」，不是铁律；带漂移警示的段落请勿当作干预依据；
- 用户明确否决过（contested）的认识，不要再拿来行动；
- 与用户当前消息冲突时，以当前消息为准。`

export class ContextBuilder {
  constructor(
    private readonly db: Pool,
    private readonly twig: TwigAdapter,
  ) {}

  async build(ctx: BuildContext, targetModel: string): Promise<BuiltContext> {
    const spec = requireModel(targetModel) // fail-closed：未登记模型拒绝路由
    const window = Math.min(ctx.session.contextWindow, spec.contextWindow)
    const budget = computeBudget(window, {
      voice: ctx.voice,
      crisis: ctx.crisis,
      maxMessageTokens: ctx.maxMessageTokens,
      // §20：本地 lane 降级纯对话，不注入工具 schema
      capabilities: spec.lane === 'local' ? 0 : 6144,
    })

    const personaPref = ctx.user.preferences['persona_prompt']
    const persona = typeof personaPref === 'string' && personaPref.length > 0 ? personaPref : DEFAULT_PERSONA

    // 危机模式跳过叙事包（§3.9 预扫管线决策在进入本函数之前完成）
    let packet: TwigContextPacket | null = ctx.packet ?? null
    let narrativeUnavailable = false
    let tail = ''
    if (!ctx.crisis) {
      if (!packet) {
        try {
          packet = await this.twig.getContextPacket(ctx.user.eternalId)
        } catch {
          packet = null
        }
      }
      if (packet) {
        tail = packet.promptText
      } else {
        // fail-open 决策（记录在案）：twig 短暂不可用时保持对话可用，但丢失漂移警示等安全语义，
        // 因此必须打点告警；连续失败应触发 Dashboard 告警而非静默。
        narrativeUnavailable = true
        tail = ''
      }
    }

    const caps = getForLane(ctx.lane)
    const capText = formatCapabilities(caps, budget.capabilities, estimateTokens)

    // 装配顺序 stable→volatile（2026-09-03 R1，替代 §3.2 原则三旧 layout）：
    // persona/capabilities 稳定；promptText 含 recentStamps 等每轮漂移数据。旧 layout 把叙事包夹在
    // system 尾部、紧贴对话历史——叙事一变，历史全部脱离厂商前缀缓存重新计费。现在叙事包独立成
    // system 消息置于历史之后、当前消息之前；危机指令语义是「替换叙事包」，随叙事包槽位走（零缓存路径，
    // 位置靠近用户消息反而强化优先级）。
    const stableParts = [
      persona,
      ...(ctx.voice ? [VOICE_PERSONA_PROMPT] : []),
      ...(capText ? [capText] : []),
    ].filter(s => s.length > 0)
    const system = stableParts.join('\n\n')
    const volatile = ctx.crisis ? `${CRISIS_PROMPT}\n\n${DEFAULT_CRISIS_RESOURCES}` : tail

    // §3.5：conversationBudget = window - (稳定 system + 易变段) - current - outputReserve - safetyBuffer
    // 总减项与旧 layout 相同，只是位置拆开
    const systemTokens = estimateTokens(system) + estimateTokens(volatile)
    const conversationBudget = Math.max(
      0,
      window - systemTokens - budget.currentMessage - budget.outputReserve - budget.safetyBuffer,
    )
    const recent: RecentMessage[] = await getRecentMessages(this.db, ctx.session.id, conversationBudget)

    // R2：cache_control 断点只标稳定段末——叙事漂移不再作废整段 Anthropic 前缀缓存。
    // 仅 Anthropic 系支持消息级 cache_control；LiteLLM 对其他 provider 会丢弃该字段。
    const systemMsg: OutgoingMessage = {
      role: 'system',
      content: system,
      ...(spec.provider === 'anthropic' ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }

    const messages: OutgoingMessage[] = [
      systemMsg,
      ...recent.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      }) as OutgoingMessage),
    ]
    // narrativeUnavailable（twig 故障 fail-open）时 volatile 为空，不追加
    if (volatile.length > 0) {
      messages.push({ role: 'system', content: volatile })
    }

    return {
      messages,
      narrativeVersion: packet ? narrativeVersionOf(packet.promptText) : 'crisis',
      budget,
      packet,
      narrativeUnavailable,
    }
  }
}
