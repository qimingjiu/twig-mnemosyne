/**
 * §5 Tool Resolver：Capability（抽象）→ MCP Tool（具体）。
 * 工具名对模型暴露为 `${capability}_${tool}`（OpenAI function 名不允许点号）。
 * 意图分类归 Router（§10.2），本模块只做「该泳道能看见哪些工具」的收敛与映射。
 */
import { getForLane, loadCapabilities, type Capability, type ToolDef } from '../router/capabilities.js'

export interface RuntimeTool {
  fnName: string
  server: string
  tool: string
  capability: string
  description: string
  parameters: unknown
  confirmationRequired: boolean
}

// capabilities.yaml 的 provider → gateway 里的 mcp server 名
const DEFAULT_PROVIDER_MAP: Record<string, string> = {
  system: 'core',
  browser: 'ddg-search',
  google_calendar: 'google-calendar',
  gmail: 'gmail',
  netease_mcp: 'netease-mcp',
  semantic_scholar: 'semantic-scholar',
}

function serverFor(cap: Capability, map: Record<string, string>): string {
  return map[cap.provider] ?? cap.provider
}

function toolConfirmation(cap: Capability, tool: ToolDef): boolean {
  return tool.confirmation_required ?? cap.confirmation_required
}

export function toolsForLane(lane: string): RuntimeTool[] {
  const file = loadCapabilities()
  const map = { ...DEFAULT_PROVIDER_MAP, ...(file.mcp_servers ?? {}) }
  const out: RuntimeTool[] = []
  for (const cap of getForLane(lane, file)) {
    for (const tool of cap.tools) {
      out.push({
        fnName: `${cap.name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
        server: serverFor(cap, map),
        tool: tool.name,
        capability: cap.name,
        description: tool.description,
        parameters: { type: 'object', properties: {}, ...(tool.name === 'get_current_time' ? { properties: { tz: { type: 'string' } } } : {}) },
        confirmationRequired: toolConfirmation(cap, tool),
      })
    }
  }
  return out
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
