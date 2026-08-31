import { describe, it, expect } from 'vitest'
import { toolsForLane, resolveTool, toOpenAiTools, summarizeArgs, enrichSchemas } from '../src/tools/resolver.js'
import { matchesContestedDomain } from '../src/tools/contested.js'
import type { TwigClaim } from '../src/memory/types.js'

describe('§5 Tool Resolver（capability → MCP tool）', () => {
  it('泳道收敛 + provider→server 映射：chat 泳道含 time(core) 与 web(web 内置 server)', () => {
    const tools = toolsForLane('chat')
    const time = tools.find(t => t.fnName === 'time_get_current_time')
    const search = tools.find(t => t.fnName === 'web_search')
    expect(time).toMatchObject({ server: 'core', tool: 'get_current_time', confirmationRequired: false })
    expect(search).toMatchObject({ server: 'web', tool: 'search' })
    // OpenAI function 名不允许点号
    for (const t of tools) expect(t.fnName).toMatch(/^[a-zA-Z0-9_]{1,64}$/)
  })

  it('§5.4 enrichSchemas 用网关真实 input_schema 替换占位；未匹配工具保留占位', () => {
    const tools = toolsForLane('chat')
    const enriched = enrichSchemas(tools, [
      { server: 'web', name: 'search', description: '', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ])
    const search = enriched.find(t => t.fnName === 'web_search')
    expect(search?.parameters).toMatchObject({ required: ['query'] })
    const time = enriched.find(t => t.fnName === 'time_get_current_time')
    expect(time?.parameters).toMatchObject({ type: 'object', properties: {} }) // 占位保留
  })

  it('§4.6 确认要求按工具级 override 解析（mail.send_mail ✓ / search_mail ✗）', () => {
    const tools = toolsForLane('tool')
    expect(tools.find(t => t.fnName === 'mail_send_mail')?.confirmationRequired).toBe(true)
    expect(tools.find(t => t.fnName === 'mail_search_mail')?.confirmationRequired).toBe(false)
    expect(tools.find(t => t.fnName === 'calendar_create_event')?.confirmationRequired).toBe(true)
    expect(tools.find(t => t.fnName === 'calendar_list_events')?.confirmationRequired).toBe(false)
  })

  it('按 fnName 反查 + OpenAI schema 形状', () => {
    const tools = toolsForLane('chat')
    expect(resolveTool('time_get_current_time', tools)?.server).toBe('core')
    expect(resolveTool('nonexistent', tools)).toBeUndefined()
    const schemas = toOpenAiTools(tools)
    expect(schemas[0]?.type).toBe('function')
    expect(schemas[0]?.function.name).not.toContain('.')
  })

  it('summarizeArgs 超长截断', () => {
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}')
    const long = { s: 'x'.repeat(200) }
    expect(summarizeArgs(long).length).toBeLessThanOrEqual(120)
  })
})

describe('§4.7 contested 域匹配', () => {
  const claim = (text: string): TwigClaim => ({ id: 'c', text, conviction: 0.5, boundary: '', status: 'contested' })

  it('论断「我不喜欢邮件」命中 mail 域，不命中 calendar 域', () => {
    expect(matchesContestedDomain([claim('我不喜欢邮件，别给我发')], 'mail')).toBeDefined()
    expect(matchesContestedDomain([claim('我不喜欢邮件，别给我发')], 'calendar')).toBeUndefined()
  })

  it('无关键词的 capability 恒不命中；反证：正常论断不命中', () => {
    expect(matchesContestedDomain([claim('随便什么')], 'music')).toBeUndefined()
    expect(matchesContestedDomain([claim('我喜欢日历提醒')], 'mail')).toBeUndefined()
  })
})
