/**
 * §19.3.2/§19.3.3 文案生成 + 输出侧危机复扫（T9.3）。
 * 生成约束：不复述情感层原文（日记/心迹/便签是前端域，§18.1）；不引用 crisis 相关碎片；
 * 语气遵循 session persona；≤280 字符。
 */
import type { ModelGateway } from '../gateways/litellm.js'
import { isCrisis } from '../crisis/lexicon.js'
import type { HuginnConfig } from './policy.js'
import type { OutreachCandidate } from './candidates.js'

const GENERATION_CONSTRAINTS = `你是 Mnemosyne 的主动触达文案引擎（HeadlessHuginn）。根据给定的触达情境写一段简短的话发给用户。
铁律：
- ≤ 280 字符，只输出正文，不要标题、引号或前缀；
- 绝不复述、引用或暗示用户的日记、心迹、便签内容（它们不是你的素材）；
- 绝不引用与危机/自伤相关的内容；
- 语气温暖自然，像认识很久的伙伴，不像通知推送；
- 一次只谈一件事；不追问、不施压；用户没有回应的义务。`

/** 输出侧复扫后的兜底文案（复扫拦截 → regenerate 一次 → 仍踩线则兜底）。 */
export const SAFE_FALLBACK_OUTREACH = '嘿，最近还好吗？突然想起你，有空的话聊两句。'

export async function generateOutreach(
  gateway: ModelGateway,
  candidate: OutreachCandidate,
  cfg: HuginnConfig,
): Promise<string> {
  for (const model of cfg.generation.chain) {
    try {
      const res = await gateway.chat(
        model,
        [
          { role: 'system', content: GENERATION_CONSTRAINTS },
          { role: 'user', content: candidate.hint },
        ],
        { temperature: cfg.generation.temperature, maxTokens: 160 },
      )
      const content = res.content.trim().slice(0, cfg.generation.max_chars)
      // 输出侧 crisis 词表复扫：踩线 → 换链重试；全链踩线 → 兜底文案
      if (content && !isCrisis(content)) return content
    } catch {
      continue // 沿链降级，与 §3.8 同语义
    }
  }
  return SAFE_FALLBACK_OUTREACH
}
