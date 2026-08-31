/**
 * §5 Tool Resolver：Capability（抽象）→ MCP Tool（具体）。
 * 工具名对模型暴露为 `${capability}_${tool}`（OpenAI function 名不允许点号）。
 * 意图分类归 Router（§10.2），本模块只做「该泳道能看见哪些工具」的收敛与映射。
 */
import { getForLane, loadCapabilities, type Capability, type ToolDef } from '../router/capabilities.js'
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
 */
export function enrichSchemas(tools: RuntimeTool[], gatewayTools: GatewayToolInfo[]): RuntimeTool[] {
  const byKey = new Map(gatewayTools.map(g => [`${g.server}/${g.name}`, g] as const))
  return tools.map(t => {
    const real = byKey.get(`${t.server}/${t.tool}`)
    return real ? { ...t, parameters: real.input_schema ?? t.parameters } : t
  })
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
