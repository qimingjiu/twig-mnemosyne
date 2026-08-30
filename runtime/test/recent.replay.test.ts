import { describe, it, expect } from 'vitest'
import { rebuildRecentMessages, type RecentMessage } from '../src/memory/recent.js'
import type { ToolCallSpec } from '../src/memory/recent.js'

const specs: ToolCallSpec[] = [
  { id: 'call_1', type: 'function', function: { name: 'time_get_current_time', arguments: '{"tz":"Asia/Shanghai"}' } },
]

const row = (r: Partial<Parameters<typeof rebuildRecentMessages>[0][number]>): Parameters<typeof rebuildRecentMessages>[0][number] => ({
  role: 'user', content: '', token_count: null, tool_calls: null, tool_results: null, ...r,
})

describe('§3.4 历史回放：工具消息必须重建合法 OpenAI 序列', () => {
  it('assistant.tool_calls 与 tool.tool_call_id 原样重建（DeepSeek 400 教训）', () => {
    const out = rebuildRecentMessages([
      row({ role: 'user', content: '现在几点' }),
      row({ role: 'assistant', content: '', tool_calls: specs }),
      row({ role: 'tool', content: 'Sunday... 12:48', tool_results: { tool_call_id: 'call_1' } }),
      row({ role: 'assistant', content: '现在是中午 12:48' }),
    ])
    expect(out).toHaveLength(4)
    expect(out[1]?.tool_calls?.[0]?.id).toBe('call_1')
    expect(out[2]?.tool_call_id).toBe('call_1')
    // 序列合法性：tool 行前面必须存在带 tool_calls 的 assistant
    const withTool = out.findIndex(m => m.role === 'tool')
    expect(withTool).toBeGreaterThan(0)
    expect(out[withTool - 1]?.tool_calls).toBeDefined()
  })

  it('孤儿 tool 行（缺 tool_call_id）丢弃，不污染序列', () => {
    const out = rebuildRecentMessages([
      row({ role: 'user', content: 'hi' }),
      row({ role: 'tool', content: 'orphan' }),
      row({ role: 'assistant', content: 'hello' }),
    ])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('末尾悬空的 assistant-tool_calls 组裁掉（工具回路崩溃残迹）', () => {
    const out = rebuildRecentMessages([
      row({ role: 'user', content: 'hi' }),
      row({ role: 'assistant', content: '', tool_calls: specs }),
    ])
    expect(out.map(m => m.role)).toEqual(['user'])
  })

  it('普通对话原样保留', () => {
    const out: RecentMessage[] = rebuildRecentMessages([
      row({ role: 'user', content: 'a' }),
      row({ role: 'assistant', content: 'b' }),
    ])
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
  })
})
