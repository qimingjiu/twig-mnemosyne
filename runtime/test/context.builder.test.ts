import { describe, it, expect } from 'vitest'
import type { Pool } from 'pg'
import { ContextBuilder, capThreadSection, type BuildContext } from '../src/context/builder.js'
import type { TwigAdapter } from '../src/memory/TwigAdapter.js'
import type { TwigContextPacket } from '../src/memory/types.js'
import { CRISIS_PROMPT } from '../src/crisis/lexicon.js'

// §3.2 原则三（2026-09-03 R1 修订）：装配 stable→volatile。
// 稳定段（persona+schemas）在前，对话历史居中，逐轮漂移的叙事包独立 system 消息垫在历史之后——
// 叙事一变，历史仍留在 provider 前缀缓存命中面内（R2：cache_control 断点只标稳定段）。

const packet: TwigContextPacket = {
  userId: 'eternal-1',
  generatedAt: '2026-09-03T00:00:00Z',
  threads: [],
  claims: [],
  recentFragments: [],
  promptText: '【叙事 volatile 段】今日心迹……',
}

// 按 created_at DESC（新→旧）排列：getRecentMessages 翻页取回后在代码内 reverse 成时间序
const history = [
  { role: 'assistant', content: '历史回复', token_count: null, tool_calls: null, tool_results: null },
  { role: 'user', content: '历史消息一', token_count: null, tool_calls: null, tool_results: null },
]

// getRecentMessages 按 BATCH 翻页直到空页，mock 第一页给数据、第二页给空
const fakeDb = (): Pool => {
  let call = 0
  return {
    query: async () => (call++ === 0 ? { rows: history } : { rows: [] }),
  } as unknown as Pool
}
const fakeTwig = (p: TwigContextPacket | null): TwigAdapter =>
  ({ getContextPacket: async () => { if (!p) throw new Error('twig down'); return p } }) as unknown as TwigAdapter

const baseCtx: BuildContext = {
  user: { id: 'u1', eternalId: 'eternal-1', preferences: {} },
  session: { id: 'sess-1', contextWindow: 128000, sessionType: 'personal' },
  lane: 'chat',
  crisis: false,
  voice: false,
  maxMessageTokens: 4096,
}

describe('§3.5 装配顺序（R1 stable→volatile + R2 断点）', () => {
  it('叙事包独立成消息置于历史之后；稳定 system 不含叙事内容', async () => {
    const built = await new ContextBuilder(fakeDb(), fakeTwig(packet)).build(baseCtx, 'claude-sonnet')
    const roles = built.messages.map(m => m.role)
    expect(roles[0]).toBe('system')
    expect(roles.at(-1)).toBe('system')
    // 稳定段在最前且不含 promptText；历史居中；叙事包垫底
    expect(built.messages[0]!.content).not.toContain('叙事 volatile 段')
    expect(built.messages[0]!.content).toContain('Mnemosyne')
    expect(built.messages.at(-1)!.content).toBe(packet.promptText)
    const historyIdx = built.messages.findIndex(m => m.content === '历史消息一')
    expect(historyIdx).toBeGreaterThan(0)
    expect(historyIdx).toBeLessThan(built.messages.length - 1)
  })

  it('R2：cache_control 只标稳定段（Anthropic）；叙事包消息无断点', async () => {
    const built = await new ContextBuilder(fakeDb(), fakeTwig(packet)).build(baseCtx, 'claude-sonnet')
    expect(built.messages[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(built.messages.at(-1)!.cache_control).toBeUndefined()
  })

  it('非 Anthropic provider 不携带 cache_control（LiteLLM 对其他 provider 丢弃该字段）', async () => {
    const built = await new ContextBuilder(fakeDb(), fakeTwig(packet)).build(baseCtx, 'deepseek-chat')
    expect(built.messages.every(m => m.cache_control === undefined)).toBe(true)
  })

  it('危机：危机指令随叙事包槽位（历史之后），稳定段不含危机指令', async () => {
    const built = await new ContextBuilder(fakeDb(), fakeTwig(packet)).build(
      { ...baseCtx, crisis: true }, 'claude-sonnet',
    )
    expect(built.narrativeVersion).toBe('crisis')
    const last = built.messages.at(-1)!
    expect(last.role).toBe('system')
    expect(last.content).toContain(CRISIS_PROMPT.slice(0, 12))
    expect(built.messages[0]!.content).not.toContain(CRISIS_PROMPT.slice(0, 12))
  })

  it('twig 故障 fail-open：无叙事包消息，序列以历史收尾', async () => {
    const built = await new ContextBuilder(fakeDb(), fakeTwig(null)).build(baseCtx, 'claude-sonnet')
    expect(built.narrativeUnavailable).toBe(true)
    expect(built.messages.at(-1)!.role).not.toBe('system')
    expect(built.messages.at(-1)!.content).toBe('历史回复')
  })
})

describe('③ 线索剂量：capThreadSection', () => {
  const prompt = [
    '【叙事上下文 · 雾尼 Muninn】',
    '进行中的线索（悬置、等待闭合的问题）：',
    '- 「线索甲」问题一（已开放 5 天，3）',
    '- 「线索乙」问题二（已开放 4 天，2）',
    '- 「线索丙」问题三（已开放 3 天，1）',
    '对用户的当前理解（随证据修正，括号为置信度）：',
    '- 认识一（0.90）',
  ].join('\n')

  it('线索行封顶，其余段落原样保留', () => {
    const out = capThreadSection(prompt, 2)
    expect(out).toContain('「线索甲」')
    expect(out).toContain('「线索乙」')
    expect(out).not.toContain('「线索丙」')
    expect(out).toContain('对用户的当前理解')
    expect(out).toContain('认识一（0.90）')
  })

  it('无线索段落（上游改格式）优雅降级为原样透传', () => {
    expect(capThreadSection('没有线索头的自由文本\n- 不是线索行', 2)).toBe('没有线索头的自由文本\n- 不是线索行')
  })
})
