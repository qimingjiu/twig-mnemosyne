/** routes.ts 与 webRoutes.ts 共用的 HTTP 小件（避免互相 import 成环）。 */
import type { Redis } from 'ioredis'

/** X-Client-Key 或 Authorization: Bearer mn_…（§2.3 双通道）。 */
export function extractClientKey(headers: Record<string, unknown>): string | null {
  const x = headers['x-client-key']
  if (typeof x === 'string' && x.startsWith('mn_')) return x
  const auth = headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer mn_')) return auth.slice('Bearer '.length)
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
