/**
 * /v1/web/* —— 爱琴海之夜 Dashboard BFF（浏览器只对 runtime 说话）。
 *
 * 设计：ADMIN_TOKEN、MUNINN_AUTH_TOKEN、broker token 都不进浏览器；web 在 identity
 * 体系里就是一个 client_type='web' 的客户端，浏览器只持有自己的 client_key。
 * 面：
 *   POST /v1/web/login                     master_key 换 web client_key（可重复，旧会话失效）
 *   GET  /v1/web/me                        当前用户信息（rail 用户牌）
 *   GET  /v1/web/memory/*                  twig-memory 只读代理（凭证在服务端）
 *   GET  /v1/web/metrics/summary           24h 用量聚合（§9 usage_logs，user 侧视图）
 *   GET  /v1/web/feed                      铭文流：usage + outreach 最近事件合并
 * 只读 + 一个登录 POST：Dashboard 的写操作（contest/correct/relocate）留待后续阶段，
 * 届时应沿用「runtime 校验 + 服务端持 twig 凭证」的同一模式。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { DEFAULT_CHAIN } from '../config.js'
import type { Db } from '../db.js'
import type { Redis } from 'ioredis'
import { TwigError } from '../memory/TwigAdapter.js'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import { webLogin, type AttemptLimiter, type ClientRow, type UserRow } from '../identity/service.js'
import { loadHuginnConfig } from '../outreach/policy.js'
import { extractClientKey, rateLimit } from './shared.js'

export interface WebDeps {
  db: Db
  redis: Redis
  twig: TwigAdapter
  limiter: AttemptLimiter
  identityAuth: (clientKey: string) => Promise<ClientRow | null>
  userOf: (userId: string) => Promise<UserRow | null>
}

const LoginSchema = z.object({
  user_eternal_id: z.string().regex(/^[a-f0-9]{64}$/),
  master_key: z.string().min(8),
})

/** BFF 读路径限流：比 chat 宽（面板一次拉多路数据），但仍按 key 封顶。 */
const WEB_RATE_PER_MIN = 300

async function requireUser(
  deps: WebDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ client: ClientRow; user: UserRow } | null> {
  const clientKey = extractClientKey(req.headers as Record<string, unknown>)
  if (!clientKey) {
    void reply.code(401).send({ error: { message: 'X-Client-Key required', type: 'missing_key' } })
    return null
  }
  if (!(await rateLimit(deps.redis, `web:${clientKey}`, WEB_RATE_PER_MIN, 60))) {
    void reply.code(429).send({ error: { message: 'too many requests', type: 'rate_limited' } })
    return null
  }
  const client = await deps.identityAuth(clientKey)
  if (!client) {
    void reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    return null
  }
  const user = await deps.userOf(client.user_id)
  if (!user) {
    void reply.code(401).send({ error: { message: 'invalid key', type: 'invalid_key' } })
    return null
  }
  return { client, user }
}

function twigFailure(e: unknown, reply: FastifyReply): void {
  // TwigError.body 可能含记忆内容，不透传；只给状态码与固定短语
  if (e instanceof TwigError) {
    void reply.code(502).send({ error: { message: 'twig_error', type: 'twig_error', upstream_status: e.status } })
    return
  }
  void reply.code(502).send({ error: { message: 'twig_unreachable', type: 'twig_unreachable' } })
}

function num(v: string | null): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/* ---------- 铭文流：usage + outreach → 事件（纯函数，测试锚点） ---------- */

export interface FeedEvent {
  ts: string
  tag: string
  body: string
  ok: boolean
}

interface UsageRow {
  timestamp: Date | string
  provider: string | null
  model: string | null
  latency_ms: number | null
  output_tokens: number | null
  cache_hit_type: string | null
  cache_saved_tokens: number | null
  error: boolean | null
  error_type: string | null
}

interface OutreachRow {
  delivered_at: Date | string | null
  created_at: Date | string | null
  outreach_type: string | null
  status: string
  slot_number: number | null
  filter_reason: string | null
  last_delivery_error: string | null
}

const iso = (d: Date | string | null): string =>
  d == null ? new Date(0).toISOString() : d instanceof Date ? d.toISOString() : new Date(d).toISOString()

export function buildFeedEvents(usage: UsageRow[], outreach: OutreachRow[]): FeedEvent[] {
  const events: FeedEvent[] = []
  for (const u of usage) {
    const ts = iso(u.timestamp)
    const model = u.model ?? u.provider ?? 'unknown'
    if (u.error) {
      events.push({ ts, tag: 'model.call', body: `${model} · 失败${u.error_type ? ` · ${u.error_type}` : ''}`, ok: false })
    } else if (u.cache_hit_type && u.cache_hit_type !== 'miss') {
      events.push({
        ts,
        tag: 'cache',
        body: `HIT ${u.cache_hit_type}${u.cache_saved_tokens ? ` · saved ${u.cache_saved_tokens} tok` : ''}`,
        ok: true,
      })
    } else {
      const parts = [model]
      if (u.latency_ms != null) parts.push(`${u.latency_ms}ms`)
      if (u.output_tokens != null) parts.push(`${u.output_tokens} out tok`)
      events.push({ ts, tag: 'model.call', body: parts.join(' · '), ok: true })
    }
  }
  for (const o of outreach) {
    const ts = iso(o.delivered_at ?? o.created_at)
    const type = o.outreach_type ?? 'outreach'
    if (o.status === 'delivered' || o.status === 'completed') {
      events.push({ ts, tag: `huginn.${type}`, body: `已投递 · slot ${o.slot_number ?? '—'}${o.status === 'completed' ? ' · 干预已上报' : ''}`, ok: true })
    } else if (o.status === 'failed') {
      events.push({ ts, tag: `huginn.${type}`, body: `投递失败${o.last_delivery_error ? ` · ${o.last_delivery_error.slice(0, 80)}` : ''}`, ok: false })
    } else if (o.status === 'filtered') {
      events.push({ ts, tag: 'huginn.filter', body: `filtered · ${o.filter_reason ?? 'policy'}`, ok: true })
    }
  }
  return events.sort((a, b) => b.ts.localeCompare(a.ts))
}

export function registerWebRoutes(app: FastifyInstance, deps: WebDeps): void {
  // —— 登录：master_key → web client_key（唯一无鉴权端点；T1.5 与 register 同参）——
  app.post('/v1/web/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: 'bad_request', detail: parsed.error.message } })
    }
    const { clientKey, user, rotated } = await webLogin(
      deps.db,
      { eternalId: parsed.data.user_eternal_id, masterKey: parsed.data.master_key },
      deps.limiter,
      req.ip,
    )
    return {
      client_key: clientKey, // 仅此一次返回明文
      display_name: user.display_name,
      eternal_id: user.eternal_id,
      rotated, // true = 其他 web 会话已被顶下线
    }
  })

  app.get('/v1/web/me', async (req, reply) => {
    const ctx = await requireUser(deps, req, reply)
    if (!ctx) return
    return {
      display_name: ctx.user.display_name,
      eternal_id: ctx.user.eternal_id,
      client_type: ctx.client.client_type,
      client_id: ctx.client.id,
    }
  })

  // —— twig-memory 只读代理：userId 一律取认证用户的 eternal_id，前端无法指定他人 ——
  const proxy = (fn: (user: UserRow, req: FastifyRequest) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await requireUser(deps, req, reply)
      if (!ctx) return
      try {
        return await fn(ctx.user, req)
      } catch (e) {
        twigFailure(e, reply)
      }
    }

  app.get('/v1/web/memory/context', proxy(u => deps.twig.getContextPacket(u.eternal_id)))
  app.get('/v1/web/memory/claims', proxy(u => deps.twig.listClaims(u.eternal_id)))
  app.get('/v1/web/memory/audit/last', proxy(u => deps.twig.lastAudit(u.eternal_id)))
  app.get('/v1/web/memory/journal/export', proxy(u => deps.twig.exportJournals(u.eternal_id)))
  app.get('/v1/web/memory/soliloquy/export', proxy(u => deps.twig.exportSoliloquies(u.eternal_id)))
  app.get('/v1/web/memory/state', proxy((u, req) => {
    const q = req.query as Record<string, string | undefined>
    return deps.twig.getState(u.eternal_id, num(q.page ?? null), num(q.limit ?? null))
  }))
  app.get('/v1/web/memory/notes', proxy((u, req) => {
    const q = req.query as Record<string, string | undefined>
    return deps.twig.listNotes(u.eternal_id, num(q.page ?? null) ?? 1, num(q.limit ?? null) ?? 20)
  }))
  app.get('/v1/web/memory/stamps/recent', proxy((u, req) => {
    const q = req.query as Record<string, string | undefined>
    return deps.twig.recentStamps(u.eternal_id, num(q.limit ?? null) ?? 7)
  }))
  app.get('/v1/web/memory/calendar', proxy((u, req) => {
    const q = req.query as Record<string, string | undefined>
    return deps.twig.calendar(u.eternal_id, q.month ?? undefined)
  }))

  // —— 写操作（2026-09-03）：沿用「runtime 校验 + 服务端持 twig 凭证」模式，userId 一律钉死认证用户 ——
  // 原文永不改动：correct 追加本人修正标注 / contest 降级论断（twig 侧语义）；便签是用户手写小事（§8.4）。
  const ContestSchema = z.object({ claim_id: z.string().min(1).max(128), note: z.string().min(1).max(2000) })
  const CorrectSchema = z.object({ fragment_id: z.string().min(1).max(128), note: z.string().min(1).max(2000) })
  const NoteCreateSchema = z.object({ content: z.string().min(1).max(4000) })

  const writeProxy = <T>(schema: z.ZodTypeAny, fn: (user: UserRow, body: T) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await requireUser(deps, req, reply)
      if (!ctx) return
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: { message: 'bad_request', detail: parsed.error.message } })
      }
      try {
        await fn(ctx.user, parsed.data as T)
        return { ok: true }
      } catch (e) {
        // 404 = 目标不存在（claim/fragment 已被上游合并或清除），透传；其余按纪律脱敏为 502
        if (e instanceof TwigError && e.status === 404) {
          return reply.code(404).send({ error: { message: 'not_found', type: 'not_found' } })
        }
        twigFailure(e, reply)
      }
    }

  app.post('/v1/web/memory/claims/contest', writeProxy(ContestSchema, (u, b: z.infer<typeof ContestSchema>) => deps.twig.contest(u.eternal_id, b.claim_id, b.note)))
  app.post('/v1/web/memory/correct', writeProxy(CorrectSchema, (u, b: z.infer<typeof CorrectSchema>) => deps.twig.correct(u.eternal_id, b.fragment_id, b.note)))
  app.post('/v1/web/memory/notes', writeProxy(NoteCreateSchema, (u, b: z.infer<typeof NoteCreateSchema>) => deps.twig.createNote(u.eternal_id, b.content)))

  // —— 24h 用量聚合（user 侧视图；走 idx_usage_user_time）——
  app.get('/v1/web/metrics/summary', async (req, reply) => {
    const ctx = await requireUser(deps, req, reply)
    if (!ctx) return
    const uid = ctx.user.id
    const [totals, breakdown, providers, tts, outreachToday] = await Promise.all([
      deps.db.query<Record<string, string | null>>(
        `SELECT COUNT(*)::text AS requests,
                COUNT(*) FILTER (WHERE error)::text AS errors,
                AVG(latency_ms)::text AS avg_latency,
                COUNT(*) FILTER (WHERE cache_hit_type IS NOT NULL AND cache_hit_type <> 'miss')::text AS cache_hits,
                COALESCE(SUM(cost_usd), 0)::text AS cost,
                COALESCE(SUM(estimated_savings), 0)::text AS savings,
                COALESCE(SUM(input_tokens), 0)::text AS tokens_in,
                COALESCE(SUM(output_tokens), 0)::text AS tokens_out,
                COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read,
                COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write,
                COALESCE(SUM(cache_saved_tokens), 0)::text AS cache_saved
           FROM usage_logs WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '24 hours'`,
        [uid],
      ),
      deps.db.query<{ cache_hit_type: string | null; n: string }>(
        `SELECT cache_hit_type, COUNT(*)::text AS n FROM usage_logs
          WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '24 hours'
          GROUP BY cache_hit_type`,
        [uid],
      ),
      deps.db.query<{ provider: string; calls: string; avg_latency: string | null; errors: string }>(
        `SELECT provider, COUNT(*)::text AS calls, AVG(latency_ms)::text AS avg_latency,
                COUNT(*) FILTER (WHERE error)::text AS errors
           FROM usage_logs
          WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '24 hours' AND provider IS NOT NULL
          GROUP BY provider ORDER BY COUNT(*) DESC LIMIT 6`,
        [uid],
      ),
      deps.db.query<{ tts_chars: string }>(
        `SELECT COALESCE(SUM(tts_chars), 0)::text AS tts_chars FROM usage_logs
          WHERE user_id = $1 AND timestamp >= date_trunc('month', NOW())`,
        [uid],
      ),
      deps.db.query<{ delivered: string; slots: string }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('delivered','completed','intervention_pending'))::text AS delivered,
                COUNT(*) FILTER (WHERE status <> 'filtered')::text AS slots
           FROM outreach WHERE user_id = $1 AND reservation_date = CURRENT_DATE`,
        [uid],
      ),
    ])

    const t = totals.rows[0] ?? {}
    const requests = Number(t.requests ?? 0)
    const cacheHits = Number(t.cache_hits ?? 0)
    let dailyCap = 0
    try {
      const cfg = loadHuginnConfig()
      dailyCap = cfg.enabled ? cfg.daily_cap : 0
    } catch {
      dailyCap = 0 // 配置缺失不拖垮面板
    }
    const cacheBreakdown: Record<string, number> = {}
    for (const row of breakdown.rows) cacheBreakdown[row.cache_hit_type ?? 'none'] = Number(row.n)

    return {
      window: '24h',
      requests_total: requests,
      errors_total: Number(t.errors ?? 0),
      avg_latency_ms: t.avg_latency ? Math.round(Number(t.avg_latency)) : null,
      cache_hit_rate: requests > 0 ? cacheHits / requests : 0,
      cache_breakdown: cacheBreakdown,
      tokens: {
        in: Number(t.tokens_in ?? 0),
        out: Number(t.tokens_out ?? 0),
        cache_read: Number(t.cache_read ?? 0),
        cache_write: Number(t.cache_write ?? 0),
        saved: Number(t.cache_saved ?? 0),
      },
      cost_usd: Number(t.cost ?? 0),
      savings_usd: Number(t.savings ?? 0),
      tts_chars_month: Number(tts.rows[0]?.tts_chars ?? 0),
      tts_budget_chars: 10_000, // §21.6 月度预算（与 voice 预算一致）
      tts_alert_chars: 8_000,
      providers: providers.rows.map(r => ({
        provider: r.provider,
        calls: Number(r.calls),
        avg_latency_ms: r.avg_latency ? Math.round(Number(r.avg_latency)) : null,
        error_rate: Number(r.calls) > 0 ? Number(r.errors) / Number(r.calls) : 0,
      })),
      default_chain: DEFAULT_CHAIN,
      outreach: {
        delivered_today: Number(outreachToday.rows[0]?.delivered ?? 0),
        slots_today: Number(outreachToday.rows[0]?.slots ?? 0),
        daily_cap: dailyCap,
      },
    }
  })

  // —— 铭文流：最近事件（usage + outreach 合并）——
  app.get('/v1/web/feed', async (req, reply) => {
    const ctx = await requireUser(deps, req, reply)
    if (!ctx) return
    const q = req.query as Record<string, string | undefined>
    const limit = Math.min(num(q.limit ?? null) ?? 40, 100)
    const [usage, outreach] = await Promise.all([
      deps.db.query<UsageRow>(
        `SELECT timestamp, provider, model, latency_ms, output_tokens, cache_hit_type,
                cache_saved_tokens, error, error_type
           FROM usage_logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2`,
        [ctx.user.id, limit],
      ),
      deps.db.query<OutreachRow>(
        `SELECT delivered_at, created_at, outreach_type, status, slot_number, filter_reason, last_delivery_error
           FROM outreach
          WHERE user_id = $1 AND status IN ('delivered','completed','failed','filtered','intervention_pending')
          ORDER BY COALESCE(delivered_at, created_at) DESC LIMIT $2`,
        [ctx.user.id, limit],
      ),
    ])
    const events = buildFeedEvents(usage.rows, outreach.rows).slice(0, limit)
    let dailyCap = 0
    try {
      const cfg = loadHuginnConfig()
      dailyCap = cfg.enabled ? cfg.daily_cap : 0
    } catch {
      dailyCap = 0
    }
    return {
      events,
      outreach: {
        delivered_today: Number(
          outreach.rows.filter(o => {
            const day = iso(o.delivered_at ?? o.created_at).slice(0, 10)
            const today = new Date().toISOString().slice(0, 10)
            return day === today && (o.status === 'delivered' || o.status === 'completed' || o.status === 'intervention_pending')
          }).length,
        ),
        daily_cap: dailyCap,
      },
    }
  })
}
