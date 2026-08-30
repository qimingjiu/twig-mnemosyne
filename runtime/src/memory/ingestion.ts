/**
 * §3.6 记忆摄入管线（VULN-01 修复 + 勘误 E-4）。
 * 只灌用户原话——不灌 AI 回复、不加角色前缀；危机检测（窗口中止）在 twig ingest 内部完成。
 */
import type { TwigAdapter } from './TwigAdapter.js'

const TWIG_TEXT_HARD_LIMIT = 4000

export class MemoryIngestionPipeline {
  constructor(private readonly twig: TwigAdapter) {}

  /** 每轮应答后异步调用；调用方 fire-and-forget，这里只保证不抛出到请求路径。 */
  async ingestTurn(userEternalId: string, userMessage: string): Promise<void> {
    const text = userMessage.length > TWIG_TEXT_HARD_LIMIT ? userMessage.slice(0, TWIG_TEXT_HARD_LIMIT) : userMessage
    if (text.trim().length === 0) return
    await this.twig.ingest(userEternalId, text)
  }

  /** 宿主基于某条论断主动干预（提醒/催促/建议）后，必须上报内生标记。 */
  async reportIntervention(
    userEternalId: string,
    claimId: string | undefined,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.twig.intervene(userEternalId, claimId, text, extra)
    // 不上报 = 自我实现预言断路器失效（对照窗口校验会剔除被催生样本）
  }
}
