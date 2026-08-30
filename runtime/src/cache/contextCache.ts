/**
 * §7.5 Context Cache（VULN-12 配套）：缓存 ContextBuilder.build 的产物骨架（不含当前用户消息）。
 * 键含 narrativeVersion + model 双维度：模型切换（§3.8 重装配）或叙事演化即自然 MISS；
 * 危机请求不读不写（§3.9）；TTL 600s 兜底。
 */
import type { Redis } from 'ioredis'

export interface ContextCacheEntry {
  session_id: string
  assembled: { role: string; content: string; cache_control?: { type: 'ephemeral' } }[]
  thread_ids: string[]
}

const TTL = 600

export function contextCacheKey(userId: string, sessionId: string, narrativeVersion: string, model: string): string {
  return `cache:v1:context:${userId}:${sessionId}:${narrativeVersion}:${model}`
}

export async function contextGet(redis: Redis, key: string): Promise<ContextCacheEntry | null> {
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ContextCacheEntry
  } catch {
    return null
  }
}

export async function contextSet(redis: Redis, key: string, entry: ContextCacheEntry): Promise<void> {
  await redis.set(key, JSON.stringify(entry), 'EX', TTL)
}
