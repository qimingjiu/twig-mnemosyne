/** §7.2 Exact Cache：同用户、同叙事版本、同规范化消息、同模型同参数——四者齐备才命中。 */
import type { Redis } from 'ioredis'

export interface ExactCacheEntry {
  response: string
  model: string
  output_tokens: number
}

export async function exactGet(redis: Redis, key: string): Promise<ExactCacheEntry | null> {
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ExactCacheEntry
  } catch {
    return null
  }
}

export async function exactSet(redis: Redis, key: string, entry: ExactCacheEntry, ttlSeconds: number): Promise<void> {
  await redis.set(key, JSON.stringify(entry), 'EX', ttlSeconds)
}
