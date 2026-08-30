/**
 * §7.6 Cache Policy（VULN-11 修复：工具结果按消息元数据判定，不按 input_tokens 猜）。
 * PII 不再是缓存的否决项（§7.0 原则 1）；PII 脱敏义务在 §11 观测侧履行。
 */

export interface CachePolicyInput {
  crisis: boolean
  status: number
  metadata?: { cache?: boolean }
  hasToolResults: boolean
}

export interface CacheDecision {
  shouldCache: boolean
  ttl?: number
  reason: string
}

export function shouldCache(input: CachePolicyInput): CacheDecision {
  if (input.crisis) return { shouldCache: false, reason: 'crisis_path' } // §3.9
  if (input.status >= 400) return { shouldCache: false, reason: 'error_response' }
  if (input.metadata?.cache === false) return { shouldCache: false, reason: 'user_opt_out' }
  if (input.hasToolResults) return { shouldCache: true, ttl: 300, reason: 'tool_result_short_ttl' }
  return { shouldCache: true, ttl: 3600, reason: 'default' }
}
