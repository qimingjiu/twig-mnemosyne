/**
 * §3.4 近期对话拉取（VULN-04 修复）。
 * LIMIT 参数是条数，Token 预算是钱，两者不能互传：批次拉取 + 逐条计账。
 *
 * 回放正确性（实弹教训）：conversation_messages 里的 assistant.tool_calls / tool.tool_call_id
 * 必须原样重建进消息序列——裸 {role:'tool', content} 不带 tool_call_id 会被
 * OpenAI 规范严格的 provider（DeepSeek 等）以 400 拒绝。孤儿行（缺配对信息）直接丢弃，
 * 末尾悬空的 assistant-tool_calls 组一并裁掉。
 */
import type { Db } from '../db.js'
import { estimateTokens } from '../util/tokens.js'

export interface ToolCallSpec {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface RecentMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCallSpec[]
  tool_call_id?: string
}

interface MessageRow {
  role: RecentMessage['role']
  content: string
  token_count: number | null
  tool_calls: ToolCallSpec[] | null
  tool_results: { tool_call_id?: string } | null
}

const BATCH = 50

/** 行 → 合法 OpenAI 消息序列（纯函数，单测锚点）。 */
export function rebuildRecentMessages(rows: MessageRow[]): RecentMessage[] {
  // 窗口内实际有 tool 结果行的 tool_call_id 集合：assistant 声明过的 tool_calls 若缺配对结果
  // （客户端弃坑 / 服务端回路中途崩溃），裸悬空会被严格 provider 400——按 id 清洗
  const answered = new Set<string>()
  for (const row of rows) {
    if (row.role === 'tool') {
      const tcid = row.tool_results?.tool_call_id
      if (tcid) answered.add(tcid)
    }
  }
  const out: RecentMessage[] = []
  for (const row of rows) {
    if (row.role === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
      const paired = row.tool_calls.filter(c => answered.has(c.id))
      if (paired.length === row.tool_calls.length) {
        out.push({ role: 'assistant', content: row.content, tool_calls: row.tool_calls })
      } else if (paired.length > 0) {
        out.push({ role: 'assistant', content: row.content, tool_calls: paired })
      } else {
        out.push({ role: 'assistant', content: row.content }) // 全部悬空 → 退化为纯文本助手行
      }
      continue
    }
    if (row.role === 'tool') {
      const tcid = row.tool_results?.tool_call_id
      if (!tcid) continue // 孤儿 tool 行：没有配对的 tool_call_id，回放必被 provider 拒绝
      out.push({ role: 'tool', content: row.content, tool_call_id: tcid })
      continue
    }
    out.push({ role: row.role, content: row.content })
  }
  // 预算切进工具组中间时，窗口头部可能出现孤儿 tool 行（其配对的 assistant-with-tool_calls
  // 在窗口外被裁掉）——回放序列以裸 tool 开头会被 provider 400，同样裁掉
  while (out.length > 0 && out[0]?.role === 'tool') {
    out.shift()
  }
  // 末尾的空残迹裁掉：悬空 assistant-tool_calls 组（经上面的清洗已退化为空文本行）或
  // 空文本助手行——留在序列末尾只会污染下一轮生成
  while (out.length > 0 && out[out.length - 1]?.role === 'assistant') {
    const last = out[out.length - 1]
    if (last?.tool_calls || last?.content === '') out.pop()
    else break
  }
  return out
}

export async function getRecentMessages(
  db: Db,
  sessionId: string,
  tokenBudget: number,
  excludeId?: string,
): Promise<RecentMessage[]> {
  const picked: MessageRow[] = []
  let used = 0
  for (let offset = 0; ; offset += BATCH) {
    const { rows } = await db.query<MessageRow>(
      `SELECT role, content, token_count, tool_calls, tool_results
         FROM conversation_messages
        WHERE session_id = $1 AND role IN ('user','assistant','tool') AND ($2::uuid IS NULL OR id <> $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [sessionId, excludeId ?? null, BATCH, offset],
    )
    if (rows.length === 0) break
    for (const msg of rows) {
      const t = msg.token_count ?? estimateTokens(msg.content)
      // 预算从最新往回装（按 created_at DESC 拉取），耗尽即止
      if (used + t > tokenBudget) {
        return rebuildRecentMessages(picked.reverse())
      }
      picked.push(msg)
      used += t
    }
  }
  return rebuildRecentMessages(picked.reverse())
}
