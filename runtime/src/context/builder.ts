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
  /** 排除当前用户消息行（管线入口已落库；当前消息由调用方追加，不排除会重复进装配） */
  excludeMessageId?: string
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
- 叙事包里的开放线索是背景，不是议程：只有当用户当前话题自然靠近某条线索时才顺势提起，
  一次至多一条；用户没提，就不要主动翻旧账；
- 与用户当前消息冲突时，以当前消息为准。`

/**
 * 线索剂量（③ 中间层）：叙事包里「进行中的线索」段落按条数封顶。
 * 格式与上游 twig-memory renderPromptText 耦合（段落头「进行中的线索」+ `- 「…」` 行）；
 * 上游改格式时本函数优雅降级为原样透传，不会损坏叙事。数量封顶是记忆女神侧能做的结构层；
 * 按「最近触碰时间」降权需要上游补证据时间戳字段（见 docs/status.md 的 vein-nudge 注记）。
 */
export const THREAD_PROMPT_CAP = 2

export function capThreadSection(promptText: string, max: number = THREAD_PROMPT_CAP): string {
  const lines = promptText.split('\n')
  const headerIdx = lines.findIndex(l => l.startsWith('进行中的线索'))
  if (headerIdx < 0) return promptText
  let kept = 0
  let inThreads = false
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (i === headerIdx) {
      inThreads = true
      out.push(line)
      continue
    }
    if (inThreads && line.startsWith('- ')) {
      if (kept < max) {
        out.push(line)
        kept++
      }
      continue // 超封顶的线索行丢弃
    }
    inThreads = false // 首个非「- 」行 = 线索段落结束，后续段落不受影响
    out.push(line)
  }
  return out.join('\n')
}

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
        tail = capThreadSection(packet.promptText)
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
    const recent: RecentMessage[] = await getRecentMessages(this.db, ctx.session.id, conversationBudget, ctx.excludeMessageId)

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
      // nv 必须基于裁剪后的文本：装配进 prompt 的是 capThreadSection 的产物，
      // 缓存键若用原始 promptText 的哈希，键与内容就错位了
      narrativeVersion: packet ? narrativeVersionOf(capThreadSection(packet.promptText)) : 'crisis',
      budget,
      packet,
      narrativeUnavailable,
    }
  }
}
