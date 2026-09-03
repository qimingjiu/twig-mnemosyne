/**
 * §5 Tool Resolver：Capability（抽象）→ MCP Tool（具体）。
 * 工具名对模型暴露为 `${capability}_${tool}`（OpenAI function 名不允许点号）。
 * 意图分类归 Router（§10.2），本模块只做「该泳道能看见哪些工具」的收敛与映射。
 */
import { getForLane, loadCapabilities, dynamicToolsPolicy, type Capability, type ToolDef } from '../router/capabilities.js'
import type { GatewayToolInfo } from './executor.js'

export interface RuntimeTool {
  fnName: string
  server: string
  tool: string
  capability: string
  description: string
  parameters: unknown
  confirmationRequired: boolean
}

function toolConfirmation(cap: Capability, tool: ToolDef): boolean {
  return tool.confirmation_required ?? cap.confirmation_required
}

export function toolsForLane(lane: string): RuntimeTool[] {
  const file = loadCapabilities()
  const map = file.mcp_servers ?? {}
  const out: RuntimeTool[] = []
  for (const cap of getForLane(lane, file)) {
    for (const tool of cap.tools) {
      out.push({
        fnName: `${cap.name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
        server: map[cap.provider] ?? cap.provider,
        tool: tool.name,
        capability: cap.name,
        description: tool.description,
        // 占位 schema；送往模型前由 enrichSchemas 用网关真实 input_schema 替换
        parameters: { type: 'object', properties: {} },
        confirmationRequired: toolConfirmation(cap, tool),
      })
    }
  }
  return out
}

/**
 * §5.4 schema 合并：网关 /tools 里是真实 input_schema，capabilities.yaml 只管确认要求与泳道过滤。
 * 匹配不到（server 挂了/未登记）保留占位空参数，调用时会报 unknown-server 错误——绝不静默。
 *
 * 2026-09-01 增补：把网关动态注册但 capabilities.yaml 未列出的工具也加进来（Smithery 等第三方 MCP）。
 * 2026-09-03 债务 #13 收口：动态工具只进 dynamic_tools.lanes 白名单泳道（lane 参数）；
 * 其他泳道经 registry.invoke 逃生舱仍可达（确认票兜底）。lane 缺省=不收敛（兼容旧调用与单测）。
 */
export function enrichSchemas(tools: RuntimeTool[], gatewayTools: GatewayToolInfo[], lane?: string): RuntimeTool[] {
  const byKey = new Map(gatewayTools.map(g => [`${g.server}/${g.name}`, g] as const))
  // 1. 补全已有工具的 schema（capability 声明的工具不受泳道白名单约束——已由 §10.2 管理）
  const enriched = tools.map(t => {
    const real = byKey.get(`${t.server}/${t.tool}`)
    return real ? { ...t, parameters: real.input_schema ?? t.parameters } : t
  })
  // 2. 把 gateway 中有但 capabilities 未列出的新工具加进来。
  //    键集与 fnName 集必须随追加实时更新：gateway 聚合层若返回重复条目，同一 function 名
  //    进系统提示会被上游模型 API 整包 400 拒绝（2026-09-01「AI 死了」：scholar_search_papers
  //    duplicated），宁可少一个工具也不能让重名工具污染提示。
  const policy = dynamicToolsPolicy()
  const laneAllowed = !lane || policy.lanes === '*' || policy.lanes.includes(lane)
  const seenKeys = new Set(tools.map(t => `${t.server}/${t.tool}`))
  const seenFnNames = new Set(enriched.map(t => t.fnName))
  for (const g of gatewayTools) {
    if (!laneAllowed) break
    const key = `${g.server}/${g.name}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const fnName = `${g.server}_${g.name}`.replace(/[^a-zA-Z0-9_]/g, '_')
    if (seenFnNames.has(fnName)) continue
    seenFnNames.add(fnName)
    enriched.push({
      fnName,
      server: g.server,
      tool: g.name,
      capability: g.server,
      description: g.description,
      parameters: g.input_schema ?? { type: 'object', properties: {} },
      confirmationRequired: policy.confirmationRequired, // 第三方工具默认需要确认（安全方向）
    })
  }
  return enriched
}

/** 按 fnName 反查（模型回传的 tool_call.function.name）。 */
export function resolveTool(fnName: string, tools: RuntimeTool[]): RuntimeTool | undefined {
  return tools.find(t => t.fnName === fnName)
}

export function toOpenAiTools(tools: RuntimeTool[]): {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.fnName, description: t.description, parameters: t.parameters },
  }))
}

/** 参数摘要（确认提示用），超长截断。 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args)
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}
