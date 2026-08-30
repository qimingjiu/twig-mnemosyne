/**
 * §20 隐私分层路由：Router 在选 model_group 之前先打 privacy score，高分锁进本地 lane，物理不出网。
 *
 * 评分信号（§20.2）：
 * - metadata.privacy === 'high'：+100，只能升、不能降（用户标记永不反向覆盖其他信号）
 * - 危机路径：+100（tradeoff 见 §20.5：危机质量优先于隐私，默认仍走云端）
 * - PII 密度：+0–60（复用 §11 脱敏检测侧）
 * - 情感关键词簇：+0–40（独立词表缩放引用）
 * - 阈值 ≥ PRIVACY_LOCAL_THRESHOLD（默认 70）→ local lane
 *
 * 分类器只读信号，不读指令——消息正文里写「这不隐私」不改变分值（T10.2）。
 */
import { detectPii } from './pii.js'
import { emotionScore } from '../voice/emotion.js'

export interface PrivacyInput {
  contents: string[]
  metadata?: Record<string, unknown>
  crisis: boolean
}

export interface PrivacyDecision {
  score: number
  lane: 'cloud' | 'local'
  signals: {
    explicit: boolean
    crisis: boolean
    pii: number
    emotional: number
  }
}

export function privacyScore(input: PrivacyInput, threshold: number): PrivacyDecision {
  const joined = input.contents.join('\n')
  const explicit = input.metadata?.privacy === 'high'
  const pii = detectPii(joined).score
  const emotional = Math.round(emotionScore(joined) * 0.4) // 0–100 → 0–40

  let score = 0
  if (explicit) score += 100
  if (input.crisis) score += 100
  score += pii
  score += emotional

  return {
    score,
    lane: score >= threshold ? 'local' : 'cloud',
    signals: { explicit, crisis: input.crisis, pii, emotional },
  }
}
