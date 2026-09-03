import { describe, it, expect } from 'vitest'
import { toolsForLane, resolveTool, toOpenAiTools, summarizeArgs, enrichSchemas } from '../src/tools/resolver.js'
import { dynamicToolsPolicy } from '../src/router/capabilities.js'
import { mergeClientTools } from '../src/tools/resolver.js'
import { matchesContestedDomain } from '../src/tools/contested.js'
import type { TwigClaim } from '../src/memory/types.js'

describe('§5.4 dynamic_tools 泳道白名单', () => {
  it('显式空数组 = 处处禁用动态工具（fail-closed；此前被当成不收敛放行全部泳道）', () => {
    expect(dynamicToolsPolicy({ lanes: {}, cap_domains: { contested_keywords: {} }, capabilities: {}, dynamic_tools: { lanes: [] } }).lanes).toEqual([])
    expect(dynamicToolsPolicy({ lanes: {}, cap_domains: { contested_keywords: {} }, capabilities: {}, dynamic_tools: { lanes: ['tool'] } }).lanes).toEqual(['tool'])
  })

  it('dynamic_tools 键整体缺失 = 不收敛（3d66d07 历史行为，兼容未升级配置）', () => {
    expect(dynamicToolsPolicy({ lanes: {}, cap_domains: { contested_keywords: {} }, capabilities: {} }).lanes).toBe('*')
  })

  it('enrichSchemas 按真实 dynamic_tools.lanes=[tool] 收敛：白名单外泳道不追加', () => {
    const gw = [
      { server: 'third_party', name: 'dynamic_fn', description: 'd', input_schema: { type: 'object', properties: {} } },
    ]
    expect(enrichSchemas(toolsForLane('chat'), gw, 'chat').find(t => t.fnName === 'third_party_dynamic_fn')).toBeUndefined()
    expect(enrichSchemas(toolsForLane('tool'), gw, 'tool').find(t => t.fnName === 'third_party_dynamic_fn')).toBeDefined()
  })
})

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

  it('enrichSchemas 对 gateway 重复条目去重：同名 function 永不进系统提示（2026-09-01「AI 死了」回归）', () => {
    // chat 泳道不含 research，scholar/* 走「gateway 独有工具」追加路径；
    // gateway 聚合层若把同一 server 列两遍，追加必须只收第一份
    const tools = toolsForLane('chat')
    const duplicated = ['search_papers', 'get_paper_details'].flatMap(name => [
      { server: 'scholar', name, description: 'd', input_schema: { type: 'object', properties: {} } },
      { server: 'scholar', name, description: 'd', input_schema: { type: 'object', properties: {} } },
    ])
    const enriched = enrichSchemas(tools, duplicated)
    const fnNames = enriched.map(t => t.fnName)
    expect(new Set(fnNames).size).toBe(fnNames.length)
    expect(enriched.filter(t => t.fnName === 'scholar_search_papers')).toHaveLength(1)
  })

  it('enrichSchemas 追加键不同但 fnName 与 capability 工具撞名时跳过', () => {
    const tools = toolsForLane('chat') // 已有 time_get_current_time（server=core）
    const enriched = enrichSchemas(tools, [
      { server: 'time', name: 'get_current_time', description: '', input_schema: { type: 'object', properties: {} } },
    ])
    expect(enriched.filter(t => t.fnName === 'time_get_current_time')).toHaveLength(1)
  })

  it('§4.6 确认要求按工具级 override 解析（mail.send_mail ✓ / search_mail ✗）', () => {
    const tools = toolsForLane('tool')
    expect(tools.find(t => t.fnName === 'mail_send_mail')?.confirmationRequired).toBe(true)
    expect(tools.find(t => t.fnName === 'mail_search_mail')?.confirmationRequired).toBe(false)
    expect(tools.find(t => t.fnName === 'calendar_create_event')?.confirmationRequired).toBe(true)
    expect(tools.find(t => t.fnName === 'calendar_list_events')?.confirmationRequired).toBe(false)
  })

  it('registry capability（pi-mcp 借鉴，AI 自助注册）：tool 泳道挂带确认门', () => {
    const tools = toolsForLane('tool')
    const reg = tools.find(t => t.fnName === 'registry_register_server')
    expect(reg).toMatchObject({ server: 'registry', tool: 'register_server' })
    expect(reg?.confirmationRequired).toBe(true)
    expect(tools.find(t => t.fnName === 'registry_list_servers')?.confirmationRequired).toBe(false)
    // invoke 逃生舱必须带确认票（§5.4 注记的承诺）：不带的话一条网页注入就能
    // registry_invoke(server=gmail, tool=send_mail)，把 mail 域的确认纪律整个旁路
    expect(tools.find(t => t.fnName === 'registry_invoke')?.confirmationRequired).toBe(true)
  })

  it('债务 #13 收口：动态工具只进 dynamic_tools.lanes 白名单泳道（config 现为 [tool]）', () => {
    const smithery = { server: 'smithery_gmail', name: 'send_email', description: 'd', input_schema: { type: 'object', properties: {} } }
    // chat 泳道不在白名单 → 不追加；能力不丢失，经 registry.invoke 逃生舱仍可达（确认票兜底）
    const chat = enrichSchemas(toolsForLane('chat'), [smithery], 'chat')
    expect(chat.find(t => t.fnName === 'smithery_gmail_send_email')).toBeUndefined()
    // tool 泳道在白名单 → 追加且默认带确认
    const tool = enrichSchemas(toolsForLane('tool'), [smithery], 'tool')
    expect(tool.find(t => t.fnName === 'smithery_gmail_send_email')).toMatchObject({ confirmationRequired: true })
    // lane 缺省 = 不收敛（兼容旧调用方与 3d66d07 行为）
    const legacy = enrichSchemas(toolsForLane('chat'), [smithery])
    expect(legacy.find(t => t.fnName === 'smithery_gmail_send_email')).toBeDefined()
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

describe('origin=client 工具透传（mergeClientTools）', () => {
  const gw = (fnName: string): Parameters<typeof mergeClientTools>[0][number] =>
    ({ fnName, server: 'core', tool: fnName, capability: 'time', description: 'd', parameters: {}, confirmationRequired: false })

  it('客户端工具逐字保留（改名客户端就不认识），function 型之外的不进 client 列表', () => {
    const m = mergeClientTools([gw('time_get_current_time')], [
      { type: 'function', function: { name: 'my_local_scanner', description: '本地扫描', parameters: { type: 'object', properties: {} } } },
      { type: 'web_search' }, // 厂商原生条目：走 nativeToolsPassthrough 门控，不属于 client 列表
      { type: 'function' },   // 缺 function.name：丢弃
    ])
    expect(m.client).toHaveLength(1)
    expect(m.client[0]?.function?.name).toBe('my_local_scanner')
    expect(m.gateway).toHaveLength(1)
    expect(m.shadowed).toEqual([])
  })

  it('撞名时客户端显式声明压过注册表：同名 fnName 本轮退场', () => {
    const m = mergeClientTools([gw('web_search'), gw('time_get_current_time')], [
      { type: 'function', function: { name: 'web_search' } },
    ])
    expect(m.gateway.map(t => t.fnName)).toEqual(['time_get_current_time'])
    expect(m.shadowed).toEqual(['web_search'])
  })
})
