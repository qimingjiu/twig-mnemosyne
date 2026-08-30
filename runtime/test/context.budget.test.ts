import { describe, it, expect } from 'vitest'
import { computeBudget, ContextTooSmallError } from '../src/context/budget.js'
import { estimateTokens } from '../src/util/tokens.js'
import { MODEL_REGISTRY, requireModel, lookupModel } from '../src/context/modelRegistry.js'
import { formatCapabilities, type Capability } from '../src/router/capabilities.js'

describe('§3.2 预算模型（VULN-04 修复）', () => {
  it('128K 窗口：先扣刚性支出，余额归对话（对齐文档表格）', () => {
    const b = computeBudget(128000, { voice: true, crisis: false, maxMessageTokens: 4096 })
    expect(b.persona).toBe(2048)
    expect(b.voicePersona).toBe(300)
    expect(b.crisis).toBe(0)
    expect(b.promptText).toBe(4096)
    expect(b.capabilities).toBe(6144)
    expect(b.currentMessage).toBe(4096)
    expect(b.outputReserve).toBe(8192)
    expect(b.safetyBuffer).toBe(4096)
    expect(b.recent).toBeGreaterThan(90000)
  })

  it('危机模式：叙事包预算被危机指令替换（§3.5/§3.9）', () => {
    const normal = computeBudget(128000, { voice: false, crisis: false, maxMessageTokens: 4096 })
    const crisis = computeBudget(128000, { voice: false, crisis: true, maxMessageTokens: 4096 })
    expect(crisis.promptText).toBe(0)
    expect(crisis.crisis).toBe(512)
    expect(crisis.recent).toBe(normal.recent + normal.promptText - crisis.crisis)
  })

  it('小窗口 fail-closed：本地 lane（无工具 schema）32K 可用；更小窗口装不下安全语义即抛错', () => {
    // §20：local lane 不注入 capability schema → capabilities=0
    expect(() => computeBudget(32768, { voice: true, crisis: true, maxMessageTokens: 4096, capabilities: 0 })).not.toThrow()
    expect(() => computeBudget(4096, { voice: true, crisis: true, maxMessageTokens: 4096 })).toThrow(ContextTooSmallError)
  })

  it('token 估算：CJK 权重大于拉丁（保守高估）', () => {
    expect(estimateTokens('一二三四五')).toBe(5)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('一二三四五六七八九十abcdefghij')).toBe(13) // 10 CJK + ceil(10/4)=3
  })
})

describe('§6.4 模型注册表（VULN-06 配套）', () => {
  it('登记表包含 §6.4 全部条目与 lane 字段', () => {
    expect(MODEL_REGISTRY['gpt-4o']).toMatchObject({ contextWindow: 128000, lane: 'cloud' })
    expect(MODEL_REGISTRY['claude-sonnet']).toMatchObject({ contextWindow: 200000, lane: 'cloud' })
    expect(MODEL_REGISTRY['gemini-pro']).toMatchObject({ contextWindow: 1000000, lane: 'cloud' })
    expect(MODEL_REGISTRY['deepseek-flash']).toMatchObject({ contextWindow: 32000, lane: 'cloud' })
    expect(MODEL_REGISTRY['ollama/qwen3:8b']).toMatchObject({ contextWindow: 32768, lane: 'local' })
  })

  it('fail-closed：未登记模型拒绝路由', () => {
    expect(lookupModel('gpt-9-turbo-ultra')).toBeUndefined()
    expect(() => requireModel('gpt-9-turbo-ultra')).toThrow(/not registered/)
  })

  it('OpenAI 兼容中转模型已登记（2026-08-30 接入）', () => {
    expect(lookupModel('gemini-3.7-flash')).toMatchObject({ lane: 'cloud', provider: 'commandcode' })
    expect(lookupModel('kimi-k3')).toMatchObject({ lane: 'cloud', provider: 'opencode' })
    expect(lookupModel('gpt-5.6-luna')).toMatchObject({ lane: 'cloud', provider: 'opencode' })
    expect(lookupModel('glm-5.2')).toMatchObject({ lane: 'cloud', provider: 'siliconflow' })
    expect(lookupModel('gemini-3.1-flash-lite')).toBeUndefined() // 套餐不含，已下架
  })
})

describe('§4.2 Capability 注入与预算压缩', () => {
  const caps: Capability[] = [
    {
      name: 'calendar', description: 'Calendar management', provider: 'google_calendar',
      confirmation_required: false,
      tools: [{ name: 'list_events', description: 'List calendar events' }, { name: 'create_event', description: 'Create event', confirmation_required: true }],
    },
    {
      name: 'mail', description: 'Email management', provider: 'gmail',
      confirmation_required: true,
      tools: [{ name: 'send_mail', description: 'Send an email', confirmation_required: true }],
    },
  ]
  const estimate = (s: string) => Math.ceil(s.length / 4)

  it('预算充足 → 完整 schema；超预算 → 压缩而非截断安全语义', () => {
    const full = formatCapabilities(caps, 10_000, estimate)
    expect(full).toContain('create_event')
    expect(full).toContain('confirmation_required: true')
    const tight = formatCapabilities(caps, 8, estimate)
    expect(tight.length).toBeLessThan(full.length)
  })
})
