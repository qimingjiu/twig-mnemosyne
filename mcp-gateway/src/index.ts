/**
 * Mnemosyne MCP Gateway（§5）—— 轻量 MCP 客户端聚合器。
 *
 * 与 eznix86 fork 的关系（NOTICE.md 已注记）：鸦巢网关（qimingjiu/mcp-gateway）已演化成
 * TG 陪伴 bot，不再承担工具路由职责；本服务为 Mnemosyne 专用重建，保留原扩展语义：
 * 懒连接（首次使用才建连）、动态聚合 tools、skill_document 透传。
 *
 * 铁律（§5.3 / VULN-08）：本服务永不接触 DB、ENCRYPTION_KEY、长期 refresh token。
 * OAuth 凭证经 Runtime 的 Token Broker 短票取件（TODO：随首个 OAuth 型远程 MCP server 接入）。
 *
 * 内置 server「core」保证任何部署都有一个可 E2E 验证的工具（get_current_time）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { BUILTIN_SERVERS, type ToolInfo } from './builtin.js'

const PORT = Number(process.env.PORT || 3000)
const CONFIG_PATH = process.env.MCP_CONFIG_PATH || 'config.default.json'

interface ServerConfig {
  type: 'builtin' | 'local' | 'remote'
  command?: string[]
  url?: string
  enabled?: boolean
  skill_document?: string
}

interface GatewayConfig {
  mcpServers: Record<string, ServerConfig>
}

function loadConfig(): GatewayConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as GatewayConfig
  } catch {
    return { mcpServers: { core: { type: 'builtin' } } }
  }
}

const config = loadConfig()

// ── 懒连接注册表 ────────────────────────────────────────────────────────────
interface Conn {
  client: Client
  connectedAt: number
}

const conns = new Map<string, Conn>()
const toolsCache = new Map<string, { tools: ToolInfo[]; at: number }>()
// 每 server 最近一次故障，/health 透出（listTools 失败不再只沉在日志里）
const lastError = new Map<string, string>()
const TOOLS_TTL_MS = 60_000

async function getConnection(server: string): Promise<Conn> {
  const existing = conns.get(server)
  if (existing) return existing
  const cfg = config.mcpServers[server]
  if (!cfg || cfg.enabled === false) throw new Error(`server disabled or unknown: ${server}`)
  if (cfg.type === 'builtin') throw new Error('builtin handled directly, never via getConnection')

  let transport
  if (cfg.type === 'local' && cfg.command) {
    const [command, ...args] = cfg.command
    if (!command) throw new Error(`bad command for ${server}`)
    transport = new StdioClientTransport({ command, args, stderr: 'ignore' })
  } else if (cfg.type === 'remote' && cfg.url) {
    // TODO(broker): OAuth 型远程 server 在此注入 Broker 短票 header（§5.3）
    transport = new StreamableHTTPClientTransport(new URL(cfg.url))
  } else {
    throw new Error(`bad server config: ${server}`)
  }

  const client = new Client({ name: 'mnemosyne-mcp-gateway', version: '0.1.0' })
  await client.connect(transport)
  const conn: Conn = { client, connectedAt: Date.now() }
  conns.set(server, conn)
  return conn
}

// builtin 走独立快路径，避免与 SDK transport 类型纠缠
function isBuiltin(server: string): boolean {
  return server in BUILTIN_SERVERS
}

// ── 工具聚合与调用 ──────────────────────────────────────────────────────────
async function listToolsFor(server: string): Promise<ToolInfo[]> {
  if (isBuiltin(server)) return BUILTIN_SERVERS[server].tools
  const cached = toolsCache.get(server)
  if (cached && Date.now() - cached.at < TOOLS_TTL_MS) return cached.tools
  const conn = await getConnection(server)
  const res = await conn.client.listTools()
  const tools: ToolInfo[] = (res.tools ?? []).map(t => ({
    server,
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema,
  }))
  toolsCache.set(server, { tools, at: Date.now() })
  return tools
}

async function allTools(): Promise<ToolInfo[]> {
  const enabled = Object.entries(config.mcpServers).filter(([, c]) => c.enabled !== false).map(([n]) => n)
  const out: ToolInfo[] = []
  for (const server of enabled) {
    try {
      out.push(...(await listToolsFor(server)))
      lastError.delete(server)
    } catch (e) {
      // 单个 server 故障不拖垮聚合（懒连接失败即跳过，下次再试）；故障原因透到 /health
      lastError.set(server, e instanceof Error ? e.message : String(e))
      console.error(`[gateway] listTools ${server} failed:`, e instanceof Error ? e.message : e)
    }
  }
  return out
}

async function callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  if (isBuiltin(server)) return await BUILTIN_SERVERS[server].call(tool, args)
  const conn = await getConnection(server)
  const res = await conn.client.callTool({ name: tool, arguments: args })
  if (res.isError) {
    const text = Array.isArray(res.content)
      ? res.content.map((c: { text?: string }) => c.text ?? '').join('\n')
      : JSON.stringify(res)
    throw new Error(`tool error: ${text.slice(0, 500)}`)
  }
  if (Array.isArray(res.content)) {
    return res.content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')
      .slice(0, 8000)
  }
  return JSON.stringify(res).slice(0, 8000)
}

// ── HTTP 层（node:http 零依赖）────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      // 每 server 状态透出：Runtime 可以判断某项能力实际是活的还是死的
      const servers = Object.entries(config.mcpServers).map(([name, c]) => ({
        name,
        type: isBuiltin(name) ? 'builtin' : c.type,
        enabled: c.enabled !== false,
        connected: isBuiltin(name) ? true : conns.has(name),
        tools: isBuiltin(name) ? BUILTIN_SERVERS[name].tools.length : (toolsCache.get(name)?.tools.length ?? null),
        last_error: lastError.get(name) ?? null,
      }))
      return json(res, 200, { ok: true, servers })
    }
    if (req.method === 'GET' && url.pathname === '/tools') {
      return json(res, 200, { tools: await allTools() })
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      const body = JSON.parse((await readBody(req)) || '{}') as { server?: string; tool?: string; args?: Record<string, unknown> }
      if (!body.server || !body.tool) return json(res, 400, { error: 'server and tool required' })
      const content = await callTool(body.server, body.tool, body.args ?? {})
      return json(res, 200, { ok: true, content })
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 502, { error: e instanceof Error ? e.message.slice(0, 400) : 'gateway error' })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp-gateway] listening on :${PORT}; servers: ${Object.keys(config.mcpServers).join(', ')}`)
})
