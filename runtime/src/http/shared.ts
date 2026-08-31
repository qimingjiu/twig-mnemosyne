/** routes.ts 与 webRoutes.ts 共用的 HTTP 小件（避免互相 import 成环）。 */
import type { Redis } from 'ioredis'

/**
 * 客户端密钥提取：X-Client-Key / Authorization: Bearer …（§2.3 双通道）。
 * 宽容第三方客户端常见变体（x-api-key、api-key、裸 Authorization、Bearer 后非 mn_ 前缀）——
 * 这里只负责「取出来」，取到的值仍过 identityAuth 验真，伪造就 401，无降权面。
 */
export function extractClientKey(headers: Record<string, unknown>): string | null {
  const candidates = [headers['x-client-key'], headers['x-api-key'], headers['api-key'], headers['authorization']]
  for (const c of candidates) {
    if (typeof c !== 'string') continue
    const raw = (c.startsWith('Bearer ') ? c.slice(7) : c).trim()
    if (raw) return raw
  }
  return null
}

/** §13.4 应用层固定窗限流：Redis 计数；Redis 异常 fail-open（缓存层故障不拖垮主路径）。 */
export async function rateLimit(redis: Redis, key: string, max: number, windowSec: number): Promise<boolean> {
  try {
    const bucket = `ratelimit:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`
    const n = await redis.incr(bucket)
    if (n === 1) await redis.expire(bucket, windowSec)
    return n <= max
  } catch {
    return true
  }
}
