/**
 * HTTP 装配：/health、/metrics、/v1/identity/*、/v1/models、/v1/chat/completions、/v1/admin/*、/internal/broker/token。
 * 限流（§13.4 职责声明）：应用层 per client_key 固定窗 + per IP，Redis 计数；Redis 异常 fail-open。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { env } from '../config.js'
import { IdentityError, AttemptLimiter, resolveSession, registerClient, rotateClientKey, authClient, getUserById, type ClientRow, type UserRow } from '../identity/service.js'
import { handleChatCompletion, type ChatDeps } from '../chat/pipeline.js'
import { renderMetrics } from '../observability/metrics.js'
import { registerBrokerRoute } from '../broker/tokenBroker.js'
import { redactText } from '../observability/redact.js'
import { loadCapabilities, getForLane } from '../router/capabilities.js'
import { MODEL_REGISTRY } from '../context/modelRegistry.js'
import { extractClientKey, rateLimit } from './shared.js'
import { registerWebRoutes } from './webRoutes.js'

export interface RouteDeps extends ChatDeps {
  limiter: AttemptLimiter
  identityAuth: (clientKey: string) => Promise<ClientRow | null>
  userOf: (userId: string) => Promise<UserRow | null>
}

const SIGNATURE_64HEX = /^[a-f0-9]{64}$/

// /v1/models 的 created 字段：注册表无创建时间语义、客户端不读；固定值保证响应稳定、测试可断言
const MODEL_LIST_CREATED = 1788048000

const RegisterSchema = z.object({
  user_eternal_id: z.string().regex(/^[a-f0-9]{64}$/),
  client_type: z.enum(['operit', 'rikkahub', 'telegram', 'web', 'mobile', 'api']),
  display_name: z.string().max(255).optional(),
  webhook_url: z.string().max(2048).optional(),
  credential: z.discriminatedUnion('type', [
    z.object({ type: z.literal('master_key'), master_key: z.string().min(8) }),
    z.object({
      type: z.literal('client_signature'),
      client_key: z.string().startsWith('mn_'),
      timestamp: z.number(),
      signature: z.string().regex(SIGNATURE_64HEX),
    }),
  ]),
})

const ChatBodySchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.any() })).min(1),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
})

async function webhookGuardOptions() {
  return {
    allowInsecure: env.ALLOW_INSECURE_WEBHOOK,
    allowlist: env.WEBHOOK_HOST_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean),
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // —— health（§8.3 启动断言在 index.ts；此处为运行期探针）——
  app.get('/health', async () => {
    const out: Record<string, unknown> = { ok: true }
    try {
      await deps.db.query('SELECT 1')
      out.db = 'ok'
    } catch (e) {
      out.ok = false
      out.db = e instanceof Error ? e.message : 'error'
    }
    try {
      out.redis = (await deps.redis.ping()) === 'PONG' ? 'ok' : 'error'
    } catch {
      out.ok = false
      out.redis = 'error'
    }
    try {
      const h = await deps.twig.health()
      out.twig = h.ok ? (h.auth ? 'ok' : 'auth_missing') : 'error'
      if (!h.ok || !h.auth) out.ok = false
    } catch {
      out.ok = false
      out.twig = 'unreachable'
    }
    try {
      // 只报不拦：mcp-gateway 挂了工具废，但不该让编排器重启主服务（ok 语义只含数据面）
      out.mcp = `ok:${await deps.mcp.ping()}`
    } catch {
      out.mcp = 'unreachable'
    }
    return out
  })

  app.get('/metrics', async () => await renderMetrics())

  // —— identity ——
  app.post('/v1/identity/register', async (req, reply) => {
    const parsed = RegisterSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: { message: 'bad_request', detail: parsed.error.message } })
    const body = parsed.data
    const result = await registerClient(
      deps.db,
      {
        userEternalId: body.user_eternal_id,
        clientType: body.client_type,
        displayName: body.display_name,
        webhookUrl: body.webhook_url,
        credential:
          body.credential.type === 'master_key'
            ? { type: 'master_key', masterKey: body.credential.master_key }
            : {
                type: 'client_signature',
                clientKey: body.credential.client_key,
                timestamp: body.credential.timestamp,
                signature: body.credential.signature,
              },
      },
      await webhookGuardOptions(),
      deps.limiter,
      req.ip,
    )
    return reply.code(201).send({
      client_key: result.clientKey, // 仅此一次返回明文
      eternal_session_id: result.eternalSessionId,
      created_at: new Date().toISOString(),
    })
  })

  app.post('/v1/identity/session', async (req, reply) => {
    const clientKey = extractClientKey(req.headers as Record<string, unknown>)
    if (!clientKey) return reply.code(401).send({ error: { message: 'X-Client-Key required', type: 'missing_key' } })
    const client = await deps.identityAuth(clientKey)
    if (!client) return reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    const user = await deps.userOf(client.user_id)
    if (!user) return reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    const body = (req.body ?? {}) as { session_type?: string; eternal_session_id?: string }
    const session = await resolveSession(deps.db, user, {
      eternalSessionId: body.eternal_session_id,
      sessionType: body.session_type,
    })
    return {
      session_id: session.sessionId,
      eternal_session_id: session.eternalSessionId,
      user_id: session.userId,
      session_type: session.sessionType,
      is_new: session.isNew,
    }
  })

  app.post('/v1/identity/rotate', async (req, reply) => {
    const clientKey = extractClientKey(req.headers as Record<string, unknown>)
    if (!clientKey) return reply.code(401).send({ error: { message: 'X-Client-Key required', type: 'missing_key' } })
    const client = await deps.identityAuth(clientKey)
    if (!client) return reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    const newKey = await rotateClientKey(deps.db, client)
    return { client_key: newKey } // 仅此一次返回明文
  })

  // —— models（OpenAI 兼容模型列表；事实源 §6.4 MODEL_REGISTRY，RikkaHub 等 OpenAI 客户端连接探测用）——
  app.get('/v1/models', async (req, reply) => {
    const clientKey = extractClientKey(req.headers as Record<string, unknown>)
    if (!clientKey) return reply.code(401).send({ error: { message: 'X-Client-Key required', type: 'missing_key' } })
    const client = await deps.identityAuth(clientKey)
    if (!client) return reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    return {
      object: 'list',
      data: Object.entries(MODEL_REGISTRY).map(([id, spec]) => ({
        id,
        object: 'model',
        created: MODEL_LIST_CREATED,
        owned_by: spec.provider,
        lane: spec.lane, // Mnemosyne 扩展字段，标准 OpenAI 客户端忽略
        context_window: spec.contextWindow,
        max_output_tokens: spec.maxOutput,
      })),
    }
  })

  // —— chat（OpenAI-compatible，§14.2）——
  app.post('/v1/chat/completions', async (req, reply) => {
    const clientKey = extractClientKey(req.headers as Record<string, unknown>)
    if (!clientKey) return reply.code(401).send({ error: { message: 'X-Client-Key required', type: 'missing_key' } })
    if (!(await rateLimit(deps.redis, `key:${clientKey}`, 120, 60)) ||
        !(await rateLimit(deps.redis, `ip:${req.ip}`, 240, 60))) {
      return reply.code(429).send({ error: { message: 'too many requests', type: 'rate_limited' } })
    }
    const client = await deps.identityAuth(clientKey)
    if (!client) return reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    const parsed = ChatBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: { message: 'bad_request', detail: parsed.error.message } })
    const user = await deps.userOf(client.user_id)
    if (!user) return reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })

    const outcome = await handleChatCompletion(deps, {
      client,
      user,
      messages: parsed.data.messages,
      model: parsed.data.model,
      temperature: parsed.data.temperature,
      metadata: parsed.data.metadata,
      eternalSessionId: (req.headers['x-eternal-session-id'] as string | undefined) || undefined,
      sessionType: (req.headers['x-session-type'] as string | undefined) || undefined,
    })
    // 假流式（§14.2 现状：管线为同步补全）：200 结果按 OpenAI chunk 协议切片重放，
    // 兼容默认 stream=true 的客户端（RikkaHub 等）；错误路径仍走 JSON 错误通道
    if (parsed.data.stream) {
      if (outcome.status !== 200) return reply.code(outcome.status).send(outcome.payload)
      return renderStreamCompletion(reply, outcome.payload)
    }
    return reply.code(outcome.status).send(outcome.payload)
  })

  // —— admin（§12.4：独立凭证，与 client_key 体系分离）——
  const adminGuard = (req: { headers: Record<string, unknown> }): boolean => {
    const token = req.headers['x-admin-token']
    return env.ADMIN_TOKEN.length > 0 && typeof token === 'string' && token === env.ADMIN_TOKEN
  }

  app.get('/v1/admin/metrics', async (req, reply) => {
    if (!adminGuard(req)) return reply.code(403).send({ error: { message: 'admin token required', type: 'forbidden' } })
    const { rows } = await deps.db.query<{
      requests: string; errors: string; avg_latency: string | null; cache_hits: string; cost: string | null
    }>(
      `SELECT COUNT(*)::text AS requests,
              COUNT(*) FILTER (WHERE error)::text AS errors,
              AVG(latency_ms)::text AS avg_latency,
              COUNT(*) FILTER (WHERE cache_hit_type <> 'miss')::text AS cache_hits,
              COALESCE(SUM(cost_usd), 0)::text AS cost
         FROM usage_logs WHERE timestamp > NOW() - INTERVAL '24 hours'`,
    )
    const r = rows[0]
    const requests = Number(r?.requests ?? 0)
    return {
      requests_total: requests,
      errors_total: Number(r?.errors ?? 0),
      avg_latency_ms: r?.avg_latency ? Math.round(Number(r.avg_latency)) : null,
      cache_hit_rate: requests > 0 ? Number(r?.cache_hits ?? 0) / requests : 0,
      cost_today_usd: Number(r?.cost ?? 0),
    }
  })

  app.get('/v1/admin/capabilities', async (req, reply) => {
    if (!adminGuard(req)) return reply.code(403).send({ error: { message: 'admin token required', type: 'forbidden' } })
    const file = loadCapabilities()
    return {
      lanes: file.lanes,
      capabilities: Object.keys(file.capabilities),
      sample_lane_chat: getForLane('chat', file).map(c => c.name),
    }
  })

  registerBrokerRoute(app, { db: deps.db, box: deps.box })

  // —— 爱琴海之夜 Dashboard BFF（web 前端唯一对话面；凭证在服务端持有）——
  registerWebRoutes(app, deps)

  // —— Huginn → Telegram 出站（OutreachDeliverer 的 webhook 落点；内部共享密钥守卫）——
  app.post('/internal/outbound/telegram', async (req, reply) => {
    const t = req.headers['x-broker-token']
    if (typeof t !== 'string' || t !== env.BROKER_INTERNAL_TOKEN) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const body = (req.body ?? {}) as { content?: string; chat_id?: number }
    if (!body.content) return reply.code(400).send({ error: 'content required' })
    const { outboundToTelegram } = await import('../telegram/adapter.js')
    const result = await outboundToTelegram({ db: deps.db, botToken: env.TELEGRAM_BOT_TOKEN }, body.content, body.chat_id)
    return result
  })

  // —— 统一错误映射（消息过 PII 脱敏再出站）——
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof IdentityError) {
      return reply.code(err.status).send({
        error: { message: redactText(err.message), type: err.code, code: err.code },
      })
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode
    if (typeof statusCode === 'number' && statusCode === 429) {
      return reply.code(429).send({ error: { message: 'rate limited', type: 'rate_limited' } })
    }
    req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled')
    return reply.code(500).send({ error: { message: 'internal error', type: 'internal_error' } })
  })
}

/** 200 补全按 OpenAI chunk 协议重放（payload 由 pipeline 保证为 chat.completion 形状）。 */
function renderStreamCompletion(reply: FastifyReply, payload: Record<string, unknown>): void {
  const choices = payload.choices as Array<{ message: { content: unknown } }> | undefined
  const content = typeof choices?.[0]?.message?.content === 'string' ? choices[0].message.content : ''
  const base = { id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model }
  reply.hijack()
  // x-accel-buffering：禁 Zeabur/nginx 边缘对 SSE 的响应缓冲
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  const send = (chunk: Record<string, unknown>): void => {
    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  for (const piece of content.match(/[\s\S]{1,120}/g) ?? []) {
    send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  if (payload.usage) send({ ...base, choices: [], usage: payload.usage })
  reply.raw.end('data: [DONE]\n\n')
}

// authClient / getUserById 由 index.ts 组装为 identityAuth / userOf 注入
void authClient
void getUserById
