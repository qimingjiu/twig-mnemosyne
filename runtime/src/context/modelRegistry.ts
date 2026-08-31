/**
 * §6.4 模型注册表与窗口守卫（VULN-06 配套 + v0.3.0 lane 增补）。
 *
 * 未登记的模型拒绝路由（fail-closed）；新增 provider/模型必须先登记此表。
 * `local` lane 的模型不暴露工具 schema，降级为纯对话（§20）。
 */

export interface ModelSpec {
  contextWindow: number
  maxOutput: number
  lane: 'cloud' | 'local'
  provider: string
  /** 推理型模型温度上限：litellm 对 reasoning-active 模型拒 temperature>1（UnsupportedParamsError） */
  maxTemperature?: number
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'gpt-4o': { contextWindow: 128000, maxOutput: 16384, lane: 'cloud', provider: 'openai' },
  'claude-sonnet': { contextWindow: 200000, maxOutput: 8192, lane: 'cloud', provider: 'anthropic' },
  'gemini-pro': { contextWindow: 1000000, maxOutput: 8192, lane: 'cloud', provider: 'gemini' },
  'deepseek-flash': { contextWindow: 32000, maxOutput: 4096, lane: 'cloud', provider: 'deepseek' },
  'deepseek-chat': { contextWindow: 65536, maxOutput: 8192, lane: 'cloud', provider: 'deepseek' },
  'ollama/qwen3:8b': { contextWindow: 32768, maxOutput: 4096, lane: 'local', provider: 'ollama' },
  // ── OpenAI 兼容中转（2026-08-30 接入；窗口在对照官方规格前取保守值，偏小只影响预算装配上限，安全方向）──
  // CommandCode 中转 · Gemini 3.7 Flash（套餐内，替代 3.1 Flash Lite/MODEL_NOT_IN_PLAN）
  'gemini-3.7-flash': { contextWindow: 1000000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  // OpenCode Zen · Kimi K3 / GPT 5.6 Luna（同一把 key 两个模型条目）
  'kimi-k3': { contextWindow: 256000, maxOutput: 8192, lane: 'cloud', provider: 'opencode' },
  'gpt-5.6-luna': { contextWindow: 128000, maxOutput: 16384, lane: 'cloud', provider: 'opencode', maxTemperature: 1 },
  // 硅基流动 · GLM-5.2
  'glm-5.2': { contextWindow: 128000, maxOutput: 8192, lane: 'cloud', provider: 'siliconflow' },
  // ── CommandCode 中转（2026-09-01 批量接入，套餐内模型；名称与窗口经账号 /models + 实测核对，
  //    文档 v2026-08-26 已过时——GLM-5.3 系列文档漏了）──
  // Mnemosyne 别名 ≠ 上游名：litellm 侧逐字透传 CommandCode API 模型名（deploy/litellm/config.yaml）。
  'gpt-5.6-sol': { contextWindow: 1050000, maxOutput: 16384, lane: 'cloud', provider: 'commandcode', maxTemperature: 1 },
  'grok-4.5': { contextWindow: 500000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'grok-4.6': { contextWindow: 500000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'kimi-k2.7-code-highspeed': { contextWindow: 262000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'kimi-k2.7-code': { contextWindow: 256000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'kimi-k2.6': { contextWindow: 256000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'kimi-k2.5': { contextWindow: 256000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'glm-5.2-fast': { contextWindow: 1000000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  // GLM-5.3 双条目：上游 org 前缀不同（zai-org vs z-ai），逐字勿混
  'glm-5.3': { contextWindow: 1000000, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
  'glm-5.3-flash': { contextWindow: 1048576, maxOutput: 8192, lane: 'cloud', provider: 'commandcode' },
}

export function lookupModel(name: string): ModelSpec | undefined {
  return MODEL_REGISTRY[name]
}

/** fail-closed：未登记即抛错，绝不静默放行。 */
export function requireModel(name: string): ModelSpec {
  const spec = MODEL_REGISTRY[name]
  if (!spec) throw new Error(`model not registered: ${name}`)
  return spec
}

export function providerOf(name: string): string {
  return MODEL_REGISTRY[name]?.provider ?? 'unknown'
}

/** 按模型上限收敛温度；无上限登记（或经典模型）原样放行。 */
export function clampTemperature(temp: number, model: string): number {
  const cap = MODEL_REGISTRY[model]?.maxTemperature
  return cap !== undefined ? Math.min(temp, cap) : temp
}
