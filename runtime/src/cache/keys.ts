/**
 * §7.1 缓存键规范（VULN-03/VULN-10 修复）。
 *
 * 1. 缓存是用户沙箱：userId 明文段入键——支持按用户 SCAN+DEL 服务 GDPR 清除（§8.6）；
 * 2. narrativeVersion = sha256(promptText).slice(0,16)（勘误 E-3：只由内容派生，绝不掺 generatedAt）；
 * 3. 危机路径不走到这里（§3.9 零缓存）。
 */
import { sha256Hex } from '../util/crypto.js'

export interface CacheMessage {
  role: string
  content: string
}

export type CacheTier = 'exact' | 'semantic' | 'context'

export function normMessages(messages: CacheMessage[]): { r: string; c: string }[] {
  return messages.map(m => ({
    r: m.role,
    // NFKC + 空白归一；不再 lowercase——大小写携带语义（勘误 D-04 关闭）
    c: m.content.normalize('NFKC').replace(/\s+/g, ' ').trim(),
  }))
}

export function narrativeVersionOf(promptText: string): string {
  return sha256Hex(promptText).slice(0, 16)
}

export interface CacheKeyParams {
  temperature: number
  top_p?: number
}

export function buildCacheKey(
  tier: CacheTier,
  userId: string,
  narrativeVersion: string,
  messages: CacheMessage[],
  model: string,
  params: CacheKeyParams,
): string {
  const digest = sha256Hex(JSON.stringify({ m: normMessages(messages), model, ...params, nv: narrativeVersion }))
  return `cache:v1:${tier}:${userId}:${digest}`
}
