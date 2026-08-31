/** MCP Gateway HTTP 客户端（§5.4）。gateway 永不持有 DB 凭证，工具执行走这里。 */
import { env } from '../config.js'

export class McpGatewayError extends Error {
  constructor(message: string) {
    super(message.slice(0, 500))
    this.name = 'McpGatewayError'
  }
}

export interface GatewayToolInfo {
  server: string
  name: string
  description: string
  input_schema: unknown
}

export class McpGatewayClient {
  constructor(private readonly baseUrl = env.MCP_GATEWAY_URL) {}

  async listTools(): Promise<GatewayToolInfo[]> {
    const res = await fetch(`${this.baseUrl}/tools`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new McpGatewayError(`tools ${res.status}`)
    const data = (await res.json()) as { tools: GatewayToolInfo[] }
    return data.tools ?? []
  }

  /** 短超时探活（/health 与启动自检用；listTools 的 15s 超时太拖）。返回工具数。 */
  async ping(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/tools`, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) throw new McpGatewayError(`tools ${res.status}`)
    const data = (await res.json()) as { tools?: GatewayToolInfo[] }
    return data.tools?.length ?? 0
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, tool, args }),
      signal: AbortSignal.timeout(60_000),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; content?: string; error?: string }
    if (!res.ok || !data.ok) throw new McpGatewayError(data.error ?? `call ${res.status}`)
    return data.content ?? ''
  }
}
