/**
 * §3.2 预算模型（VULN-04 修复 + v0.3.0 增补）。
 *
 * 原则一：先扣刚性支出，余额归对话。
 * 原则二：promptText 是原子单元（窗口安全阀指令/漂移警示/再提邀请都是安全语义），
 *         不允许按字符截断——永远 pin 住。
 * 固定 pin 与预留随窗口缩小不缩水（危机指令等安全语义不议价）；
 * 余额不足以容纳最小区度时抛错，由上层按候选模型重装配（§3.8）或拒绝。
 */

export interface Budget {
  /** system persona（稳定段），pin */
  persona: number
  /** 语音人格约束（若 client 声明 voice_capable），pin */
  voicePersona: number
  /** 危机安全指令（若触发），pin、最高优先 */
  crisis: number
  /** 叙事上下文 promptText，整体原子 pin */
  promptText: number
  /** Capability schemas，可截断（经 §4 路由缩减） */
  capabilities: number
  /** Tool state，可截断 */
  toolState: number
  /** 当前用户消息，API 层硬限长，不可截断 */
  currentMessage: number
  /** 输出预留，不可挪用 */
  outputReserve: number
  /** 安全缓冲，不可挪用 */
  safetyBuffer: number
  /** 近期对话（余额），从最旧开始截断 */
  recent: number
}

export class ContextTooSmallError extends Error {
  constructor(public readonly window: number) {
    super(`context window ${window} too small for pinned budget`)
    this.name = 'ContextTooSmallError'
  }
}

export function computeBudget(
  window: number,
  opts: { voice: boolean; crisis: boolean; maxMessageTokens: number; capabilities?: number },
): Budget {
  const persona = 2048
  const voicePersona = opts.voice ? 300 : 0
  const crisis = opts.crisis ? 512 : 0
  const promptText = opts.crisis ? 0 : 4096 // 危机模式：叙事包被危机指令替换（§3.5）
  // §20：local lane 不暴露工具 schema → 调用方传 0
  const capabilities = opts.capabilities ?? 6144
  const toolState = 4096
  const currentMessage = Math.min(opts.maxMessageTokens, 4096)
  const outputReserve = 8192
  const safetyBuffer = 4096

  const pinned =
    persona + voicePersona + crisis + promptText + capabilities + toolState + currentMessage + outputReserve + safetyBuffer
  const recent = window - pinned
  // 最小可用近期对话 4K：低于此值说明该窗口装不下安全语义，直接失败（fail-closed）
  if (recent < 4096) throw new ContextTooSmallError(window)

  return { persona, voicePersona, crisis, promptText, capabilities, toolState, currentMessage, outputReserve, safetyBuffer, recent }
}
