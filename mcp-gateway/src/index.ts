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
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { BUILTIN_SERVERS, installBuiltin, type ToolInfo } from './builtin.js'

const PORT = Number(process.env.PORT || 3000)
const CONFIG_PATH = process.env.MCP_CONFIG_PATH || 'config.default.json'

interface ServerConfig {
  type: 'builtin' | 'local' | 'remote'
  command?: string[]
  url?: string
  enabled?: boolean
  skill_document?: string
  headers?: Record<string, string>
  /** 动态注册的 remote server 实际连接成功用的传输方式（register 时探测一次记入） */
  transport?: 'streamable-http' | 'sse'
}

interface GatewayConfig {
  mcpServers: Record<string, ServerConfig>
}

/** 运行时动态注册的 remote server（register/unregister 端点维护；重启即清空） */
const dynamicServers = new Map<string, ServerConfig & { name: string }>()

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

function serverConfig(name: string): ServerConfig | undefined {
  return config.mcpServers[name] ?? dynamicServers.get(name)
}

/**
 * remote 传输探测（pi-mcp 借鉴）：顺序尝试 Streamable HTTP → SSE，谁先建连成功用谁。
 * 旧 MCP 服务多半只实现了 SSE；新协议绝大多数人只跑 Streamable HTTP——两边各试一次就分清了。
 */
async function probeRemote(url: string, headers?: Record<string, string>): Promise<{ client: Client; transport: 'streamable-http' | 'sse' }> {
  const target = new URL(url)
  const client = new Client({ name: 'mnemosyne-mcp-gateway', version: '0.1.0' })
  try {
    // TODO(broker): OAuth 型远程 server 在此注入 Broker 短票 header（§5.3）
    await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers } }))
    return { client, transport: 'streamable-http' }
  } catch (err) {
    await client.close().catch(() => undefined)
    const sseClient = new Client({ name: 'mnemosyne-mcp-gateway', version: '0.1.0' })
    try {
      await sseClient.connect(new SSEClientTransport(target, { requestInit: { headers } }))
      return { client: sseClient, transport: 'sse' }
    } catch (sseErr) {
      await sseClient.close().catch(() => undefined)
      const a = err instanceof Error ? err.message : String(err)
      const b = sseErr instanceof Error ? sseErr.message : String(sseErr)
      throw new Error(`remote connect failed (streamable-http: ${a}; sse: ${b})`)
    }
  }
}

async function getConnection(server: string): Promise<Conn> {
  const existing = conns.get(server)
  if (existing) return existing
  const cfg = serverConfig(server)
  if (!cfg || cfg.enabled === false) throw new Error(`server disabled or unknown: ${server}`)
  if (isBuiltin(server)) throw new Error('builtin handled directly, never via getConnection')

  let client: Client
  if (cfg.type === 'local' && cfg.command) {
    const [command, ...args] = cfg.command
    if (!command) throw new Error(`bad command for ${server}`)
    const local = new Client({ name: 'mnemosyne-mcp-gateway', version: '0.1.0' })
    await local.connect(new StdioClientTransport({ command, args, stderr: 'ignore' }))
    client = local
  } else if (cfg.type === 'remote' && cfg.url) {
    client = (await probeRemote(cfg.url, cfg.headers)).client
  } else {
    throw new Error(`bad server config: ${server}`)
  }

  const conn: Conn = { client, connectedAt: Date.now() }
  conns.set(server, conn)
  return conn
}

/**
 * 断连清理 + 懒重连（pi-mcp 借鉴）：辅助线程每 30s ping 一次非内置连接，
 * 失败就丢出 conn（下次 use 时自动重建）。校验：配置 static / dynamic map 都不动。
 */
async function checkHealth(): Promise<void> {
  const names = [...Object.keys(config.mcpServers), ...dynamicServers.keys()]
  for (const name of names) {
    if (isBuiltin(name)) continue
    const conn = conns.get(name)
    if (!conn) continue
    try {
      await Promise.race([conn.client.listTools(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5_000))])
      lastError.delete(name)
    } catch (e) {
      conns.delete(name)
      toolsCache.delete(name)
      await conn.client.close().catch(() => undefined)
      lastError.set(name, e instanceof Error ? e.message : String(e))
      console.error(`[gateway] health check dropped ${name}:`, e instanceof Error ? e.message : e)
    }
  }
}

setInterval(() => { checkHealth().catch(() => undefined) }, 30_000).unref()

// ── 动态注册（pi-mcp 借鉴：URL 必须显式给出）────────────────────────────────

/** 动态注册 remote server：URL 必填、可探测 transmissions、oauth/skill_document 可选省略。 */
async function registerServer(
  name: string,
  url: string,
  opts: { oauth?: boolean; skill_document?: string; headers?: Record<string, string> } = {},
): Promise<{ name: string; transport: 'streamable-http' | 'sse'; tools: ToolInfo[] }> {
  // builtin override：同名 builtin 会永久遮蔽 dynamic 定义，注册前就拒掉
  if (name in (config.mcpServers ?? {})) throw new Error(`name collides with static server: ${name}`)
  if (name in BUILTIN_SERVERS) throw new Error(`name collides with builtin server: ${name}`)
  if (!/^https?:\/\//.test(url)) throw new Error('url must start with http(s)')
  const probed = await probeRemote(url, opts.headers)
  dynamicServers.delete(name)
  conns.delete(name)
  toolsCache.delete(name)
  dynamicServers.set(name, {
    name,
    type: 'remote',
    url,
    enabled: true,
    transport: probed.transport,
    skill_document: opts.skill_document,
    headers: opts.headers,
  })
  const tools = (await probed.client.listTools()).tools ?? []
  return { name, transport: probed.transport, tools: tools.map(t => ({ server: name, name: t.name, description: t.description ?? '', input_schema: t.inputSchema })) }
}

/** 动态注销：连、清缓存、移除内联定义。 */
async function unregisterServer(name: string): Promise<void> {
  if (!dynamicServers.has(name)) throw new Error(`not a dynamic server: ${name}`)
  const conn = conns.get(name)
  if (conn) await conn.client.close().catch(() => undefined)
  conns.delete(name)
  toolsCache.delete(name)
  dynamicServers.delete(name)
  lastError.delete(name)
}

// ── registry 内置工具（AI 自助注册的主要通道；纯文本 PII 勿写 skill_document）──
installBuiltin('registry', {
  tools: [
    {
      name: 'list_servers',
      description: 'List all MCP servers known to the gateway (static + dynamic), with type/enabled/last_error',
      input_schema: {
        type: 'object',
        properties: { include_health: { type: 'boolean', description: 'Try a 5s listTools ping to confirm liveness (default false)' } },
      },
    },
    {
      name: 'register_server',
      description: 'Register a remote MCP server by URL (tensed URL 必须给出); detects Streamable HTTP vs SSE automatically; optional headers for auth (e.g., Authorization Bearer token)',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Alphanumeric server handle (max 32 chars; this is what /call uses)' },
          url: { type: 'string', description: 'MCP endpoint URL (required; AI 需要外部渠道/用户给出了解才知)' },
          skill_document: { type: 'string', description: 'Optional Markdown usage note for this server' },
          headers: { type: 'object', description: 'Optional HTTP headers (e.g., { Authorization: "Bearer <token>" }) for servers requiring authentication' },
        },
        required: ['name', 'url'],
      },
    },
    {
      name: 'unregister_server',
      description: 'Remove a dynamically registered remote server (static config.requires file edit + gateway restart)',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    {
      name: 'invoke',
      description: "Escape hatch: call any registered (static+dynamic) server's tool directly through the registry",
      input_schema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          tool: { type: 'string' },
          args: { type: 'object' },
        },
        required: ['server', 'tool'],
      },
    },
  ],
  call: async (tool, args) => {
    const s = (k: string) => String(args[k] ?? '')
    if (tool === 'list_servers') return JSON.stringify(await allServers(args.include_health === true), null, 2)
    if (tool === 'register_server') return JSON.stringify(await registerServer(s('name'), s('url'), { skill_document: args.skill_document ? String(args.skill_document) : undefined, headers: args.headers as Record<string, string> | undefined }), null, 2)
    if (tool === 'unregister_server') { await unregisterServer(s('name')); return `unregistered: ${s('name')}` }
    if (tool === 'invoke') return await callTool(s('server'), s('tool'), (args.args as Record<string, unknown>) ?? {})
    throw new Error(`unknown registry tool: ${tool}`)
  },
})

/** /health 报告用的合并视图（static + dynamic）；当 includeHealth=true 做一次低延时探活。 */
async function allServers(includeHealth = false): Promise<{ name: string; type: string; enabled: boolean; connected: boolean; tools: number | null; last_error: string | null }[]> {
  const primary = [...Object.keys(config.mcpServers).filter(n => !dynamicServers.has(n)), ...dynamicServers.keys()]
  // 与 allTools 同一去重规则：static 配置里的 builtin 不与 BUILTIN_SERVERS 重复列出
  const names = [...primary, ...Object.keys(BUILTIN_SERVERS).filter(n => !primary.includes(n))]
  const out = []
  for (const name of names) {
    const builtin = isBuiltin(name)
    const cfg = builtin ? undefined : serverConfig(name)
    const enabled = cfg ? cfg.enabled !== false : true
    const connected = builtin ? true : conns.has(name)
    const tools = builtin ? BUILTIN_SERVERS[name].tools.length : (toolsCache.get(name)?.tools.length ?? null)
    let lastE = lastError.get(name) ?? null
    if (includeHealth && !builtin && connected) {
      try {
        await Promise.race([conns.get(name)!.client.listTools(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2_000))])
        lastE = null
      } catch (e) {
        lastE = e instanceof Error ? e.message : String(e)
      }
    }
    out.push({ name, type: builtin ? 'builtin' : (cfg?.type ?? 'remote'), enabled, connected, tools, last_error: lastE })
  }
  return out
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
  // server 聚合必须按名去重：static 配置显式声明的 builtin 与 BUILTIN_SERVERS 重叠，
  // 各聚合一次会让同一工具在 /tools 出现两遍（2026-09-01 重复 function 名事故的源头）
  const staticNames = Object.entries(config.mcpServers).filter(([, c]) => c.enabled !== false).map(([n]) => n)
  const dynamicNames = [...dynamicServers.keys()]
  const names = [...staticNames, ...dynamicNames, ...Object.keys(BUILTIN_SERVERS).filter(n => !staticNames.includes(n) && !dynamicNames.includes(n))]
  const out: ToolInfo[] = []
  for (const server of names) {
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
      return json(res, 200, { ok: true, servers: await allServers(false) })
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; url?: string; skill_document?: string; headers?: Record<string, string> }
      if (!body.name || !/^[a-zA-Z0-9_-]{1,32}$/.test(body.name)) return json(res, 400, { error: 'name must be alphanumeric (max 32)' })
      if (!body.url || !/^https?:\/\//.test(body.url)) return json(res, 400, { error: 'url must start with http(s)' })
      const meta = await registerServer(body.name, body.url, { skill_document: body.skill_document, headers: body.headers })
      return json(res, 200, { ok: true, name: meta.name, transport: meta.transport, tools: meta.tools.map(t => t.name) })
    }
    if (req.method === 'POST' && url.pathname === '/unregister') {
      const body = JSON.parse((await readBody(req)) || '{}') as { name?: string }
      if (!body.name) return json(res, 400, { error: 'name required' })
      await unregisterServer(body.name)
      return json(res, 200, { ok: true })
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
