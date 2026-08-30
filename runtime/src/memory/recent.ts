/**
 * §3.4 近期对话拉取（VULN-04 修复）。
 * LIMIT 参数是条数，Token 预算是钱，两者不能互传：批次拉取 + 逐条计账。
 */
import type { Db } from '../db.js'
import { estimateTokens } from '../util/tokens.js'

export interface RecentMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
}

const BATCH = 50

export async function getRecentMessages(db: Db, sessionId: string, tokenBudget: number): Promise<RecentMessage[]> {
  const picked: RecentMessage[] = []
  let used = 0
  for (let offset = 0; ; offset += BATCH) {
    const { rows } = await db.query<{
      role: RecentMessage['role']
      content: string
      token_count: number | null
    }>(
      `SELECT role, content, token_count
         FROM conversation_messages
        WHERE session_id = $1 AND role IN ('user','assistant','tool')
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [sessionId, BATCH, offset],
    )
    if (rows.length === 0) break
    for (const msg of rows) {
      const t = msg.token_count ?? estimateTokens(msg.content)
      // 预算耗尽即止（恢复时间正序由调用方保证：这里返回旧→新）
      if (used + t > tokenBudget) return picked.reverse()
      picked.push({ role: msg.role, content: msg.content })
      used += t
    }
  }
  return picked.reverse()
}
