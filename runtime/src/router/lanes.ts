/**
 * §10.2 单一意图决策点：LangGraph Router 的轻量替身。
 *
 * 只决定「谁来答」（chat/coding/research/tool 泳道），不做 Capability Router 的过滤职责。
 * 输入是分类专用极短上下文（最近 2 轮 + 当前消息），从不接收完整装配产物（§6.4）。
 *
 * TODO(LangGraph): §10.3 的 StateGraph（router → lane agents + postgresCheckpointer 加密落库）
 * 在工具执行回路（MCP gateway fork）落地后接入；当前单分类器调用已满足泳道收敛语义。
 */
import type { ModelGateway, ChatMessage } from '../gateways/litellm.js'

export type Lane = 'chat' | 'coding' | 'research' | 'tool'

const CLASSIFY_PROMPT = `你是意图分类器。根据对话片段，输出一个泳道词，只能是以下之一：
chat（日常对话/情感陪伴/闲聊）
coding（编程/技术问题）
research（学术/资料检索）
tool（需要使用日历、邮件、音乐等工具完成明确操作）
只输出单词本身，不要解释。`

const VALID: Lane[] = ['chat', 'coding', 'research', 'tool']

export async function classifyLane(
  gateway: ModelGateway,
  recent: { role: string; content: string }[],
  currentMessage: string,
): Promise<Lane> {
  const turns: ChatMessage[] = recent.slice(-4).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content.slice(0, 300),
  }))
  const snippet: ChatMessage[] = [
    { role: 'system', content: CLASSIFY_PROMPT },
    ...turns,
    { role: 'user', content: currentMessage.slice(0, 500) },
  ]
  try {
    const res = await gateway.chat('deepseek-flash', snippet, { temperature: 0, maxTokens: 8 })
    const word = res.content.trim().toLowerCase()
    return (VALID as string[]).includes(word) ? (word as Lane) : 'chat'
  } catch {
    return 'chat' // 分类器不可用 → 默认泳道，绝不阻塞主路径
  }
}
