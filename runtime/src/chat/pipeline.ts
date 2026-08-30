/**
 * §14.2 POST /v1/chat/completions 主管线。
 *
 * 时序（各节编号均为 TID 文档锚点）：
 *   Identity（§2）→ 危机预扫（§3.9，先于一切缓存与模型调用）→ Session 解析
 *   → 泳道分类（§10.2）→ 隐私评分（§20.2）→ 目标链选定
 *   → Context Cache（§7.5）→ Exact Cache（§7.1/§7.2）→ 装配与 fallback 重装配（§3.8）
 *   → 模型调用 → 持久化/缓存写/用量/摄入（异步）/危机审计（§18.2）/TTS（§21）
 */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { env, DEFAULT_CHAIN } from '../config.js'
import { isCrisis } from '../crisis/lexicon.js'
import { resolveSession, IdentityError, type UserRow, type ClientRow } from '../identity/service.js'
import { ContextBuilder, type BuildContext, type BuiltContext, type OutgoingMessage } from '../context/builder.js'
import { lookupModel, providerOf } from '../context/modelRegistry.js'
import { buildCacheKey, narrativeVersionOf } from '../cache/keys.js'
import { exactGet, exactSet } from '../cache/exact.js'
import { contextCacheKey, contextGet, contextSet } from '../cache/contextCache.js'
import { shouldCache } from '../cache/policy.js'
import { isRetryableError, LiteLlmError, type ChatResult } from '../gateways/litellm.js'
import { classifyLane } from '../router/lanes.js'
import { privacyScore } from '../privacy/score.js'
import { recordUsage } from '../usage/engine.js'
import type { MemoryIngestionPipeline } from '../memory/ingestion.js'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import type { ModelGateway } from '../gateways/litellm.js'
import { estimateTokens } from '../util/tokens.js'
import { Box } from '../util/crypto.js'
import { shouldTTS, ttsSanitize, synthesizeTts, stashAudio } from '../voice/tts.js'
import { cacheHitsTotal, errorsTotal, latencySeconds, requestsTotal, tokensTotal } from '../observability/metrics.js'

export interface ChatDeps {
  db: Pool
  redis: Redis
  twig: TwigAdapter
  gateway: ModelGateway
  builder: ContextBuilder
  ingestion: MemoryIngestionPipeline
  box: Box
}

export interface ChatRequest {
  client: ClientRow
  user: UserRow
  messages: { role: string; content?: unknown }[]
  model?: string
  temperature?: number
  metadata?: Record<string, unknown>
  eternalSessionId?: string
  sessionType?: string
}

export interface ChatOutcome {
  status: number
  payload: Record<string, unknown>
}

// §20.3：本地 lane 的 fallback chain 只含本地模型，绝不允许「降级」到云端
const LOCAL_CHAIN = ['ollama/qwen3:8b'] as const

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

async function quickRecent(db: Pool, sessionId: string, n: number): Promise<{ role: string; content: string }[]> {
  const { rows } = await db.query<{ role: string; content: string }>(
    `SELECT role, content FROM conversation_messages
      WHERE session_id = $1 AND role IN ('user','assistant')
      ORDER BY created_at DESC LIMIT ${n}`,
    [sessionId],
  )
  return rows.reverse()
}

async function recentTtsCount(db: Pool, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT was_tts FROM conversation_messages
        WHERE session_id = $1 AND role = 'assistant'
        ORDER BY created_at DESC LIMIT 3
     ) t WHERE was_tts`,
    [sessionId],
  )
  return Number(rows[0]?.n ?? 0)
}

export async function handleChatCompletion(deps: ChatDeps, req: ChatRequest): Promise<ChatOutcome> {
  const started = Date.now()
  const requestId = randomUUID()
  const clientType = req.client.client_type

  const lastUser = [...req.messages].reverse().find(m => m.role === 'user')
  const currentMessage = extractText(lastUser?.content)
  if (!currentMessage) throw new IdentityError(400, 'no_user_message', 'messages must contain a user message')
  // §3.2：当前用户消息 API 层硬限长，不可截断
  if (estimateTokens(currentMessage) > env.MAX_MESSAGE_TOKENS) {
    throw new IdentityError(413, 'message_too_long', `current message exceeds ${env.MAX_MESSAGE_TOKENS}-token hard limit`)
  }

  const session = await resolveSession(deps.db, req.user, {
    eternalSessionId: req.eternalSessionId,
    sessionType: req.sessionType,
  })

  // §3.9 危机预扫：预扫在缓存查询与模型调用之前；monotonic 延长静默期（GREATEST 只延长不缩短）
  const crisis = isCrisis(currentMessage)
  if (crisis) {
    await deps.db.query(
      `UPDATE users
          SET crisis_silence_until = GREATEST(COALESCE(crisis_silence_until, to_timestamp(0)), NOW() + ($2 || ' hours')::interval)
        WHERE id = $1`,
      [req.user.id, String(env.CRISIS_SILENCE_HOURS)],
    )
  }

  // §10.2 唯一意图决策点 + §20.2 隐私评分（分类器只读信号）
  const laneRecent = await quickRecent(deps.db, session.sessionId, 4)
  const lane = crisis ? 'chat' : await classifyLane(deps.gateway, laneRecent, currentMessage)
  const privacy = privacyScore({ contents: [currentMessage], metadata: req.metadata, crisis }, env.PRIVACY_LOCAL_THRESHOLD)

  // 目标链（§3.8）：危机路径走云端强模型（§20.5 tradeoff），temperature 0.3
  let chain: string[]
  let temperature = req.temperature ?? 0.7
  let routeReason = 'default'
  if (crisis) {
    chain = [...DEFAULT_CHAIN]
    temperature = 0.3
    routeReason = 'crisis_path'
  } else if (privacy.lane === 'local') {
    chain = [...LOCAL_CHAIN]
    routeReason = 'privacy_tier:local'
  } else {
    // 用户可请求、不可强制（§6.5）：仅登记且 cloud lane 的模型可作首选
    const requested = req.model
    const spec = requested ? lookupModel(requested) : undefined
    chain = requested && spec && spec.lane === 'cloud'
      ? [requested, ...DEFAULT_CHAIN.filter(m => m !== requested)]
      : [...DEFAULT_CHAIN]
  }

  const ctxBase: BuildContext = {
    user: { id: req.user.id, eternalId: req.user.eternal_id, preferences: req.user.preferences ?? {} },
    session: { id: session.sessionId, contextWindow: session.contextWindow, sessionType: session.sessionType },
    lane,
    crisis,
    voice: req.client.metadata?.['voice_capable'] === true,
    maxMessageTokens: env.MAX_MESSAGE_TOKENS,
  }

  const cacheEligible = !crisis && privacy.lane === 'cloud' // 危机零缓存（§3.9）；local lane 不缓存（保守）
  let cacheHitType: 'exact' | 'context' | 'miss' = 'miss'

  // Context Cache（§7.5）：键含 narrativeVersion + model；packet 本地取（读无副作用）
  let narrativeVersion: string | null = null
  if (cacheEligible) {
    try {
      const packet = await deps.twig.getContextPacket(req.user.eternal_id)
      ctxBase.packet = packet
      narrativeVersion = narrativeVersionOf(packet.promptText)
      const ck = contextCacheKey(req.user.eternal_id, session.sessionId, narrativeVersion, chain[0] ?? '')
      const hit = await contextGet(deps.redis, ck)
      if (hit) {
        cacheHitType = 'context'
        const built: BuiltContext = {
          messages: hit.assembled as OutgoingMessage[],
          narrativeVersion,
          packet,
          budget: {
            persona: 0, voicePersona: 0, crisis: 0, promptText: 0, capabilities: 0, toolState: 0,
            currentMessage: 0, outputReserve: 0, safetyBuffer: 0, recent: 0,
          },
          narrativeUnavailable: false,
        }
        const exactKey = buildCacheKey('exact', req.user.eternal_id, narrativeVersion,
          [...built.messages, { role: 'user', content: currentMessage }], chain[0] ?? '', { temperature })
        const exactHit = await exactGet(deps.redis, exactKey)
        if (exactHit) {
          cacheHitType = 'exact'
          return await finalize(deps, req, {
            started, requestId, clientType, session, crisis, content: exactHit.response, usedModel: exactHit.model,
            result: null, built, chain: [chain[0] ?? ''], fallbackCount: 0, cacheHitType, routeReason, temperature,
            lane, privacyLane: 'cloud', ctxBase, narrativeVersion,
          })
        }
        return await runModelLoop(deps, req, { started, requestId, clientType, session, crisis, ctxBase, built,
          chain, fallbackCount: 0, cacheHitType, routeReason, temperature, lane, narrativeVersion,
          privacyLane: 'cloud' })
      }
    } catch {
      narrativeVersion = null // twig/redis 异常 → 走完整装配路径
    }
  }

  return await runModelLoop(deps, req, {
    started, requestId, clientType, session, crisis, ctxBase, built: null,
    chain, fallbackCount: 0, cacheHitType: 'miss', routeReason, temperature, lane,
    narrativeVersion, privacyLane: privacy.lane,
  })
}

interface LoopState {
  started: number
  requestId: string
  clientType: string
  session: { sessionId: string; eternalSessionId: string; sessionType: string; contextWindow: number }
  crisis: boolean
  ctxBase: BuildContext
  built: BuiltContext | null
  chain: string[]
  fallbackCount: number
  cacheHitType: 'exact' | 'context' | 'miss'
  routeReason: string
  temperature: number
  lane: string
  narrativeVersion: string | null
  privacyLane: 'cloud' | 'local'
}

/**
 * 沿链跳过的上游错误：401/403（凭证缺失或地区被拒）、404（模型组不存在/无可用部署）。
 * 这些都意味着「这个 provider 现在用不了」，跳到链上下一个候选，而不是中断整条 fallback。
 */
function isProviderMisconfig(e: unknown): boolean {
  return e instanceof LiteLlmError && (e.status === 401 || e.status === 403 || e.status === 404)
}

/** §3.8 每个候选独立装配（重装配），retryable/凭证缺失错误沿链降级；其余非 retryable 直接映射。 */
async function runModelLoop(deps: ChatDeps, req: ChatRequest, st: LoopState): Promise<ChatOutcome> {
  let result: ChatResult | null = null
  let usedModel = ''
  let built = st.built
  let lastError: unknown = null

  for (const model of st.chain) {
    const spec = lookupModel(model)
    if (!spec) continue // fail-closed：未登记模型跳过
    // 重装配：仅首个候选可用缓存命中的装配产物（其键绑定 chain[0]）
    const builtForModel = built && model === st.chain[0] ? built : await deps.builder.build(st.ctxBase, model)
    if (model === st.chain[0]) built = builtForModel

    const exactKey = buildCacheKey('exact', req.user.eternal_id, builtForModel.narrativeVersion,
      [...builtForModel.messages, { role: 'user', content: extractText(req.messages.at(-1)?.content) }],
      model, { temperature: st.temperature })

    if (st.cacheHitType === 'miss' && !st.crisis && st.privacyLane === 'cloud') {
      const exactHit = await exactGet(deps.redis, exactKey)
      if (exactHit) {
        return await finalize(deps, req, {
          ...st, content: exactHit.response, usedModel: exactHit.model, result: null,
          built: builtForModel, chain: [model], fallbackCount: 0, cacheHitType: 'exact',
        })
      }
    }

    const t0 = Date.now()
    try {
      result = await deps.gateway.chat(
        model,
        [...builtForModel.messages, { role: 'user', content: extractText(req.messages.at(-1)?.content) }],
        { temperature: st.temperature },
      )
      latencySeconds.observe({ stage: 'model.call', provider: spec.provider }, (Date.now() - t0) / 1000)
      usedModel = model
      break
    } catch (e) {
      lastError = e
      if (!isRetryableError(e) && !isProviderMisconfig(e)) throw mapGatewayError(e)
      st.fallbackCount++
    }
  }

  if (!result || !usedModel) {
    errorsTotal.inc({ error_type: st.privacyLane === 'local' ? 'privacy_unavailable' : 'all_providers_down', provider: 'none' })
    if (st.privacyLane === 'local') {
      // fail-closed：本地不可用 → 503，绝不允许「降级」到云端（T10.1）
      throw new IdentityError(503, 'privacy_unavailable', 'local model offline; refusing cloud fallback')
    }
    if (isProviderMisconfig(lastError)) {
      throw new IdentityError(502, 'provider_misconfigured', 'all chain models rejected provider credentials; check provider keys')
    }
    throw new IdentityError(502, 'all_providers_down', lastError instanceof Error ? lastError.message : 'all providers failed')
  }

  return await finalize(deps, req, {
    ...st, content: result.content, usedModel, result, built,
    cacheHitType: st.cacheHitType,
  })
}

function mapGatewayError(e: unknown): IdentityError {
  if (e instanceof IdentityError) return e
  const status = typeof e === 'object' && e !== null && 'status' in e ? Number((e as { status: unknown }).status) : NaN
  // 上游 401/403 = 服务端 provider 凭证未配置/失效，映射 502 而非透传 401——
  // 否则用户会误判为自己的 client_key 出错（两者必须可区分）
  if (status === 401 || status === 403) {
    return new IdentityError(502, 'provider_misconfigured', 'model gateway rejected provider credentials; check provider keys')
  }
  if (!Number.isNaN(status)) return new IdentityError(status >= 400 && status < 600 ? status : 502, 'gateway_error', String(e))
  return new IdentityError(502, 'gateway_error', String(e))
}

/** 成功/缓存命中后的统一出口：持久化、缓存写、用量、摄入（异步）、危机审计、TTS。 */
async function finalize(
  deps: ChatDeps,
  req: ChatRequest,
  st: LoopState & { content: string; usedModel: string; result: ChatResult | null },
): Promise<ChatOutcome> {
  const currentMessage = extractText(req.messages.at(-1)?.content)
  const provider = providerOf(st.usedModel)
  const prefs = req.user.preferences ?? {}
  const clientType = st.clientType

  // TTS（§21.6，v0.3.1 PATCH-06：独立情绪分类器）
  let audio: { data: string; mime: string; expires_in: number } | undefined
  let ttsChars: number | undefined
  const voiceCapable = req.client.metadata?.['voice_capable'] === true
  if (voiceCapable) {
    const ttsCount = await recentTtsCount(deps.db, st.session.sessionId)
    if (shouldTTS(st.content, {
      crisis: st.crisis,
      alwaysTTS: prefs['alwaysTTS'] === true,
      recentTtsCount: ttsCount,
    })) {
      const sanitized = ttsSanitize(st.content, { crisis: st.crisis })
      ttsChars = [...sanitized].length
      const synthesized = await synthesizeTts(sanitized, {
        apiKey: process.env.ELEVENLABS_API_KEY || undefined,
        voiceId: process.env.ELEVENLABS_VOICE_ID || undefined,
      })
      if (synthesized) {
        const key = await stashAudio(deps.redis, st.requestId, synthesized)
        audio = { data: key, mime: synthesized.mime, expires_in: 60 } // data 为即焚键，非内联音频
      }
    }
  }

  // 对话持久化（DB = 会话 replay 与审计的事实源，§8.1）；exact 命中同样落库（保持 DB 与用户实际经历一致）
  const userTokens = estimateTokens(currentMessage)
  const assistantTokens = estimateTokens(st.content)
  await deps.db.query(
    `INSERT INTO conversation_messages (session_id, role, content, token_count, model_used, tokens_input, latency_ms, was_tts)
     VALUES ($1, 'user', $2, $3, $4, $5, $6, FALSE)`,
    [st.session.sessionId, currentMessage, userTokens, st.usedModel, st.result?.promptTokens ?? 0, st.result?.latencyMs ?? 0],
  )
  const { rows: asstRows } = await deps.db.query<{ id: string }>(
    `INSERT INTO conversation_messages (session_id, role, content, token_count, model_used, tokens_output, latency_ms, was_tts)
     VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [st.session.sessionId, st.content, assistantTokens, st.usedModel, st.result?.completionTokens ?? 0, st.result?.latencyMs ?? 0, audio !== undefined],
  )
  const assistantMessageId = asstRows[0]?.id

  // 缓存写（§7.6 Policy；危机/local 不写）
  if (!st.crisis && st.privacyLane === 'cloud' && st.built) {
    const decision = shouldCache({
      crisis: false,
      status: 200,
      metadata: req.metadata as { cache?: boolean } | undefined,
      hasToolResults: req.messages.some(m => m.role === 'tool'),
    })
    if (decision.shouldCache && decision.ttl) {
      const exactKey = buildCacheKey('exact', req.user.eternal_id, st.built.narrativeVersion,
        [...st.built.messages, { role: 'user', content: currentMessage }], st.usedModel, { temperature: st.temperature })
      await exactSet(deps.redis, exactKey, { response: st.content, model: st.usedModel, output_tokens: st.result?.completionTokens ?? 0 }, decision.ttl)
      if (st.narrativeVersion) {
        await contextSet(deps.redis,
          contextCacheKey(req.user.eternal_id, st.session.sessionId, st.narrativeVersion, st.usedModel),
          { session_id: st.session.sessionId, assembled: st.built.messages, thread_ids: st.built.packet?.threads.map(t => t.id) ?? [] })
      }
    }
  }

  // 危机独立加密审计轨迹（§18.2/§18.3）：append-only，不进 usage_logs、不进任何缓存
  if (st.crisis) {
    const payload = deps.box.encrypt(JSON.stringify({
      message: currentMessage, response: st.content, model: st.usedModel, ts: new Date().toISOString(),
    }))
    await deps.db.query('INSERT INTO crisis_audit (user_id, payload_enc) VALUES ($1, $2)', [req.user.id, payload])
  }

  // 用量（§9.2）
  const savedTokens = st.cacheHitType === 'exact' ? st.result?.completionTokens ?? assistantTokens : 0
  await recordUsage(deps.db, {
    requestId: st.requestId,
    userId: req.user.id,
    sessionId: st.session.sessionId,
    clientType,
    provider,
    model: st.usedModel,
    inputTokens: st.result?.promptTokens ?? 0,
    outputTokens: st.result?.completionTokens ?? assistantTokens,
    cacheReadTokens: st.result?.cachedTokens ?? 0,
    latencyMs: Date.now() - st.started,
    cacheHitType: st.cacheHitType,
    cacheSavedTokens: savedTokens,
    routeReason: st.routeReason,
    fallbackCount: st.fallbackCount,
    ttsChars,
    privacyTier: st.privacyLane,
  })

  // 摄入（§3.6）：只灌用户原文；危机路径照常 ingest（twig 内部自动中止全部对照窗口）
  deps.ingestion.ingestTurn(req.user.eternal_id, currentMessage).catch(err => {
    errorsTotal.inc({ error_type: 'twig_ingest', provider: 'twig' })
    console.error('[ingest] failed:', err instanceof Error ? err.message : err)
  })

  // 指标（§11，async sidecar 语义）
  requestsTotal.inc({ client_type: clientType, session_type: st.session.sessionType, provider, model: st.usedModel })
  tokensTotal.inc({ type: 'input', provider }, st.result?.promptTokens ?? 0)
  tokensTotal.inc({ type: 'output', provider }, st.result?.completionTokens ?? 0)
  if (st.cacheHitType !== 'miss') cacheHitsTotal.inc({ cache_type: st.cacheHitType })

  return {
    status: 200,
    payload: {
      id: st.result?.id ?? st.requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: st.usedModel,
      choices: [{ index: 0, message: { role: 'assistant', content: st.content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: st.result?.promptTokens ?? 0,
        completion_tokens: st.result?.completionTokens ?? assistantTokens,
        total_tokens: (st.result?.promptTokens ?? 0) + (st.result?.completionTokens ?? assistantTokens),
        cache_read_tokens: st.result?.cachedTokens ?? 0,
        cache_write_tokens: 0,
      },
      ...(audio ? { audio } : {}),
      mnemosyne: {
        cache_hit_type: st.cacheHitType,
        narrative_version: st.built?.narrativeVersion ?? 'unknown',
        privacy_tier: st.privacyLane,
        route_reason: st.routeReason,
        fallback_count: st.fallbackCount,
        assistant_message_id: assistantMessageId,
      },
    },
  }
}
