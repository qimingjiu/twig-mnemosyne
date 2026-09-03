/**
 * §14.2 POST /v1/chat/completions 主管线。
 *
 * 时序（各节编号均为 TID 文档锚点）：
 *   Identity（§2）→ 危机预扫（§3.9，先于一切缓存与模型调用）→ Session 解析
 *   → 泳道分类（§10.2）→ 隐私评分（§20.2）→ 目标链选定
 *   → Context Cache（§7.5）→ Exact Cache（§7.1/§7.2）→ 装配与 fallback 重装配（§3.8）
 *   → 模型调用（stream 客户端经 onDelta 真·token 级透传，债务 #5；已发帧后禁链内 fallback）
 *   → 持久化/缓存写/用量/摄入（异步）/危机审计（§18.2）/TTS（§21）
 */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { env, DEFAULT_CHAIN } from '../config.js'
import { isCrisis } from '../crisis/lexicon.js'
import { resolveSession, IdentityError, type UserRow, type ClientRow } from '../identity/service.js'
import { ContextBuilder, type BuildContext, type BuiltContext, type OutgoingMessage } from '../context/builder.js'
import { lookupModel, providerOf, clampTemperature } from '../context/modelRegistry.js'
import { ContextTooSmallError } from '../context/budget.js'
import { buildCacheKey, narrativeVersionOf } from '../cache/keys.js'
import { exactGet, exactSet } from '../cache/exact.js'
import { contextCacheKey, contextGet, contextSet } from '../cache/contextCache.js'
import { shouldCache } from '../cache/policy.js'
import { isRetryableError, LiteLlmError, type ChatResult, type ChatMessage, type ChatOptions, type ToolCallSpec } from '../gateways/litellm.js'
import { classifyLane } from '../router/lanes.js'
import { privacyScore } from '../privacy/score.js'
import { recordUsage } from '../usage/engine.js'
import type { MemoryIngestionPipeline } from '../memory/ingestion.js'
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import type { ModelGateway } from '../gateways/litellm.js'
import { toolsForLane, resolveTool, toOpenAiTools, summarizeArgs, enrichSchemas, mergeClientTools, type ClientToolEntry } from '../tools/resolver.js'
import type { McpGatewayClient } from '../tools/executor.js'
import { contestedGate } from '../tools/contested.js'
import { issueTicket, verifyTicket } from '../router/confirmation.js'
import { estimateTokens } from '../util/tokens.js'
import { Box } from '../util/crypto.js'
import { shouldTTS, ttsSanitize, synthesizeTts, stashAudio } from '../voice/tts.js'
import { cacheHitsTotal, errorsTotal, latencySeconds, requestsTotal, tokensTotal } from '../observability/metrics.js'
import { capThreadSection } from '../context/builder.js'

export interface ChatDeps {
  db: Pool
  redis: Redis
  twig: TwigAdapter
  gateway: ModelGateway
  builder: ContextBuilder
  ingestion: MemoryIngestionPipeline
  box: Box
  mcp: McpGatewayClient
}

export interface ChatRequest {
  client: ClientRow
  user: UserRow
  /** OpenAI 消息序列；assistant 的 tool_calls / tool 的 tool_call_id 在客户端工具续轮里出现 */
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }[]
  model?: string
  temperature?: number
  metadata?: Record<string, unknown>
  eternalSessionId?: string
  sessionType?: string
  /** 客户端声明的工具（OpenAI tools 字段，origin=client 透传） */
  tools?: ClientToolEntry[]
  toolChoice?: unknown
}

export interface ChatOutcome {
  status: number
  payload: Record<string, unknown>
}

/** 真流式（债务 #5）：内容 delta 外发口（text, upstreamModel）。由路由层 sink 实现；缺省=同步补全。 */
export type DeltaSink = (text: string, model: string) => void

/** 媒体附件（当前仅音乐）：TG/web 客户端拿它发 sendAudio 或带链接预览的卡片（§5.5）。 */
export interface Attachment {
  kind: 'music'
  title: string
  artist: string
  page_url: string
  play_url: string
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

async function quickRecent(db: Pool, sessionId: string, n: number, excludeId?: string): Promise<{ role: string; content: string }[]> {
  const { rows } = await db.query<{ role: string; content: string }>(
    `SELECT role, content FROM conversation_messages
      WHERE session_id = $1 AND role IN ('user','assistant') AND ($2::uuid IS NULL OR id <> $2)
      ORDER BY created_at DESC LIMIT ${n}`,
    [sessionId, excludeId ?? null],
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

export async function handleChatCompletion(deps: ChatDeps, req: ChatRequest, onDelta?: DeltaSink): Promise<ChatOutcome> {
  const started = Date.now()
  const requestId = randomUUID()
  const clientType = req.client.client_type

  // 当前轮语义：messages 以 user 收尾 = 新用户轮；user 之后还跟着 assistant(tool_calls)/tool
  // = 客户端工具续轮（origin=client 的 tool_calls 由客户端执行后携结果回传）
  let lastUserIdx = -1
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]?.role === 'user') { lastUserIdx = i; break }
  }
  const trailing = req.messages.slice(lastUserIdx + 1)
  const continuation = trailing.length > 0
  const lastUser = lastUserIdx >= 0 ? req.messages[lastUserIdx] : undefined
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
    const t0 = Date.now()
    await deps.db.query(
      `UPDATE users
          SET crisis_silence_until = GREATEST(COALESCE(crisis_silence_until, to_timestamp(0)), NOW() + ($2 || ' hours')::interval)
        WHERE id = $1`,
      [req.user.id, String(env.CRISIS_SILENCE_HOURS)],
    )
    latencySeconds.observe({ stage: 'crisis_prescan', provider: 'none' }, (Date.now() - t0) / 1000)
  }

  // 对话事实源先落库（§8.1）：工具轮次/缓存命中路径都以此为准，finalize 不重复写。
  let currentMessageId: string | undefined
  if (continuation) {
    // 续轮：原 user 行在上一请求已落库——按内容找回（不限 60s，客户端执行工具可能耗时），
    // 找不到（上请求在落库前崩溃）才补插；防抖条件插入在这里没有意义。
    const existing = await deps.db.query<{ id: string }>(
      `SELECT id FROM conversation_messages
        WHERE session_id = $1 AND role = 'user' AND content = $2
        ORDER BY created_at DESC LIMIT 1`,
      [session.sessionId, currentMessage],
    )
    currentMessageId = existing.rows[0]?.id
    if (!currentMessageId) {
      const inserted = await deps.db.query<{ id: string }>(
        `INSERT INTO conversation_messages (session_id, role, content, token_count)
         VALUES ($1, 'user', $2, $3) RETURNING id`,
        [session.sessionId, currentMessage, estimateTokens(currentMessage)],
      )
      currentMessageId = inserted.rows[0]?.id
    }
    await persistClientToolTurn(deps.db, session.sessionId, trailing)
  } else {
    // 重试防抖：客户端对失败请求自动重试时（502/超时），同会话同内容 60s 内只落一次——
    // 否则每次重试都往近期历史多灌一份，下一轮装配出现「同一句 ×N」（2026-09-01 RikkaHub 重试风暴事故）。
    // 单语句条件插入：SELECT→INSERT 两步在并发下会双双通过检查各插一行，WHERE NOT EXISTS 把检查并进写入。
    const retried = await deps.db.query<{ id: string }>(
      `SELECT id FROM conversation_messages
        WHERE session_id = $1 AND role = 'user' AND content = $2
          AND created_at > NOW() - INTERVAL '60 seconds'
        LIMIT 1`,
      [session.sessionId, currentMessage],
    )
    currentMessageId = retried.rows[0]?.id
    if (!currentMessageId) {
      const inserted = await deps.db.query<{ id: string }>(
        `INSERT INTO conversation_messages (session_id, role, content, token_count)
         SELECT $1, 'user', $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_messages
             WHERE session_id = $1 AND role = 'user' AND content = $2
               AND created_at > NOW() - INTERVAL '60 seconds')
         RETURNING id`,
        [session.sessionId, currentMessage, estimateTokens(currentMessage)],
      )
      currentMessageId = inserted.rows[0]?.id
    }
  }

  // §10.2 唯一意图决策点 + §20.2 隐私评分（分类器只读信号）
  // laneRecent/装配都排除刚落库的当前消息行（excludeMessageId）：当前消息由调用方追加（§3.5），
  // 不排除会把同一句话灌给模型两遍（token 双倍计费 + 提示词重复）。续轮例外：当前消息在 DB 历史
  // 里位于工具结果之前（顺序由 created_at 保证），不排除也不追加。
  const laneRecent = await quickRecent(deps.db, session.sessionId, 4, continuation ? undefined : currentMessageId)
  // 续轮直接沿用 tool 泳道：意图在原轮已定，对旧文本重跑分类器只会误判，还白付一次模型往返
  const lane = crisis ? 'chat' : continuation ? 'tool' : await classifyLane(deps.gateway, laneRecent, currentMessage)
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
    excludeMessageId: continuation ? undefined : currentMessageId,
  }

  // 客户端带了 tools 或处于续轮 → 缓存全关（读和写都关）：exact 键不含 tools 语义，
  // 带/不带工具的同文请求会互相错命中；续轮的装配含工具结果，键形状也对不上
  const clientTools = req.tools ?? []
  const cacheEligible = !crisis && privacy.lane === 'cloud' && !continuation && clientTools.length === 0
  let cacheHitType: 'exact' | 'context' | 'miss' = 'miss'

  // Context Cache（§7.5）：键含 narrativeVersion + model；packet 本地取（读无副作用）。
  // try 只包缓存层读取（twig/redis 异常 → 走完整装配路径）——模型执行与 finalize 必须在
  // 保护圈之外：包在内的话，任何一次上游失败都会被吞掉并整链重跑（重复流式文本/双倍计费/重复落库）。
  let narrativeVersion: string | null = null
  let contextHit: { built: BuiltContext; exactHit: { response: string; model: string } | null } | null = null
  if (cacheEligible) {
    try {
      const t0 = Date.now()
      const packet = await deps.twig.getContextPacket(req.user.eternal_id)
      latencySeconds.observe({ stage: 'twig_packet', provider: 'twig' }, (Date.now() - t0) / 1000)
      ctxBase.packet = packet
      // 与 builder 同一裁剪：nv 必须基于实际进 prompt 的文本（capThreadSection 产物）
      narrativeVersion = narrativeVersionOf(capThreadSection(packet.promptText))
      const ck = contextCacheKey(req.user.eternal_id, session.sessionId, narrativeVersion, chain[0] ?? '')
      const hit = await contextGet(deps.redis, ck)
      if (hit) {
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
          [...built.messages, { role: 'user', content: currentMessage }], chain[0] ?? '',
          { temperature: clampTemperature(temperature, chain[0] ?? '') })
        contextHit = { built, exactHit: await exactGet(deps.redis, exactKey) ?? null }
      }
    } catch {
      narrativeVersion = null // twig/redis 异常 → 走完整装配路径
    }
  }
  if (contextHit) {
    cacheHitType = 'context'
    if (contextHit.exactHit) {
      cacheHitType = 'exact'
      return await finalize(deps, req, {
        started, requestId, clientType, session, crisis, content: contextHit.exactHit.response,
        usedModel: contextHit.exactHit.model, result: null, built: contextHit.built,
        chain: [chain[0] ?? ''], fallbackCount: 0, cacheHitType, routeReason, temperature,
        lane, privacyLane: 'cloud', ctxBase, narrativeVersion, currentMessage,
        clientTools, toolChoice: req.toolChoice, continuation,
      })
    }
  return await runModelLoop(deps, req, { started, requestId, clientType, session, crisis, ctxBase,
      built: contextHit.built, chain, fallbackCount: 0, cacheHitType, routeReason, temperature, lane,
      narrativeVersion, privacyLane: 'cloud', currentMessage,
      clientTools, toolChoice: req.toolChoice, continuation }, onDelta)
  }

  return await runModelLoop(deps, req, {
    started, requestId, clientType, session, crisis, ctxBase, built: null,
    chain, fallbackCount: 0, cacheHitType: 'miss', routeReason, temperature, lane,
    narrativeVersion,
    // §20.5：危机路径走云端强模型——privacyLane 若沿用评分产物（+100 → 'local'），
    // 会把危机轮错标成 local（usage 口径错、链耗尽时报「local offline」假错、工具被误剥离）
    privacyLane: crisis ? 'cloud' : privacy.lane,
    currentMessage,
    clientTools, toolChoice: req.toolChoice, continuation,
  }, onDelta)
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
  /** 入口已校验的当前用户消息（last user role）——全链复用，不得用 req.messages.at(-1) 重 derive */
  currentMessage: string
  /** 客户端声明的工具（origin=client 透传）；空数组 = 无透传 */
  clientTools: ClientToolEntry[]
  toolChoice?: unknown
  /** 客户端工具续轮：messages 里 user 之后跟有 assistant(tool_calls)/tool */
  continuation: boolean
  /** 用户消息已在管线入口落库（finalize 跳过重复插入） */
  userPersisted?: boolean
  /** 回交路径已在回路内落库 assistant(tool_calls) 行——finalize 跳过重复插入 */
  assistantPersisted?: boolean
  /** origin=client 的 tool_calls（回交客户端执行；响应带 finish_reason: tool_calls） */
  clientToolCalls?: { id: string; name: string; args: string }[]
  /** 因型号未放行被丢弃的厂商原生工具条目数 */
  nativeDropped?: number
  /** 工具回路统计（§5） */
  toolMeta?: { rounds: number; executed: number; pending: number }
  /** 媒体附件（音乐 play 工具结果收集；TG sendAudio/web 卡片用） */
  attachments?: Attachment[]
}

/** §10.5：工具回路硬上限 */
const MAX_TOOL_ROUNDS = 10
const TOOL_LOOP_DEADLINE_MS = 60_000

interface ToolLoopOutcome {
  result: ChatResult
  meta: { rounds: number; executed: number; pending: number }
  /** 多轮用量合计：每轮上游调用都是真实计费，只记末轮会低估工具密集轮次（§9.2） */
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number }
  /** origin=client 的 tool_calls：终止回路、原样回交客户端执行（网关不执行外来工具） */
  clientToolCalls?: { id: string; name: string; args: string }[]
  /** 回交路径已在回路内落库 assistant(tool_calls) 行——finalize 跳过重复插入 */
  assistantPersisted?: boolean
  /** 因型号未放行被丢弃的厂商原生工具条目数（modelRegistry.nativeToolsPassthrough） */
  nativeDropped?: number
}

function rawSpecs(calls: { id: string; name: string; args: string }[]): ToolCallSpec[] {
  return calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
}

/** 客户端重放的 assistant.tool_calls 规格化（形状与服务端 rawSpecs 一致，DB 回放同构）。 */
function normalizeClientToolCalls(raw: unknown): { id: string; name: string; args: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(c => {
    const o = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const id = typeof o?.id === 'string' ? o.id : ''
    const name = typeof o?.function?.name === 'string' ? o.function.name : ''
    if (!id || !name) return []
    const args = typeof o.function?.arguments === 'string'
      ? o.function.arguments
      : JSON.stringify(o.function?.arguments ?? {})
    return [{ id, name, args }]
  })
}

/**
 * 客户端回传的工具轮次落库（origin=client 协议的另一半）：assistant(tool_calls) 与 tool 结果行，
 * 按 tool_call_id 全量去重——客户端重放的历史不得重复入库。长度上限与服务端回路一致（4000）。
 */
async function persistClientToolTurn(db: Pool, sessionId: string, trailing: ChatRequest['messages']): Promise<void> {
  if (trailing.length === 0) return
  // 去重按角色分集：assistant 行声明的 id 与 tool 结果行的 id 是两张不同的票——
  // 混在一个集合里，工具结果行会因为 id 已存在于 assistant 行而被永久跳过
  const { rows } = await db.query<{ id: string | null; src: string }>(
    `SELECT jsonb_array_elements(tool_calls)->>'id' AS id, 'assistant' AS src FROM conversation_messages
      WHERE session_id = $1 AND tool_calls IS NOT NULL
      UNION ALL
      SELECT tool_results->>'tool_call_id', 'tool' FROM conversation_messages
      WHERE session_id = $1 AND role = 'tool' AND tool_results IS NOT NULL`,
    [sessionId],
  )
  const knownAssistant = new Set(rows.filter(r => r.src === 'assistant').map(r => r.id).filter((v): v is string => !!v))
  const knownTool = new Set(rows.filter(r => r.src === 'tool').map(r => r.id).filter((v): v is string => !!v))
  // 先收集 id→fn 映射（tool_results 里记 fn 供 Dashboard 展示）
  const fnById = new Map<string, string>()
  for (const m of trailing) {
    if (m.role !== 'assistant') continue
    for (const c of normalizeClientToolCalls(m.tool_calls)) fnById.set(c.id, c.name)
  }
  for (const m of trailing) {
    if (m.role === 'assistant') {
      const specs = normalizeClientToolCalls(m.tool_calls)
      if (specs.length === 0) continue // 纯文本 assistant 重放不落（当前轮语义不涉及）
      if (specs.every(c => knownAssistant.has(c.id))) continue
      await db.query(
        `INSERT INTO conversation_messages (session_id, role, content, tool_calls)
         VALUES ($1, 'assistant', $2, $3)`,
        [sessionId, extractText(m.content), JSON.stringify(rawSpecs(specs))],
      )
      for (const c of specs) knownAssistant.add(c.id)
    } else if (m.role === 'tool') {
      const tcid = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
      if (!tcid || knownTool.has(tcid)) continue
      await db.query(
        `INSERT INTO conversation_messages (session_id, role, content, tool_results)
         VALUES ($1, 'tool', $2, $3)`,
        [sessionId, extractText(m.content).slice(0, 4000), JSON.stringify({ tool_call_id: tcid, fn: fnById.get(tcid) ?? '' })],
      )
      knownTool.add(tcid)
    }
  }
}

async function safeToolCall(deps: ChatDeps, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    return (await deps.mcp.call(server, tool, args)) || '(empty result)'
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** 音乐工具成功结果的统一信封（与 mcp-gateway builtin music 对齐）；解析失败返回 undefined 当普通文本。 */
export function musicEnvelope(resultText: string): { songs: Attachment[] } | undefined {
  let data: { status?: string; action?: string; songs?: unknown } | null
  try { data = JSON.parse(resultText) as { status?: string; songs?: unknown } } catch { return undefined }
  if (data?.status !== 'music' || !Array.isArray(data.songs)) return undefined
  const songs = (data.songs as { title?: string; artist?: string; pageUrl?: string; playUrl?: string }[])
    .filter(s => s.title && s.pageUrl)
    .map(s => ({
      kind: 'music' as const,
      title: s.title ?? '',
      artist: s.artist ?? '',
      page_url: s.pageUrl ?? '',
      play_url: s.playUrl ?? '',
    }))
  return { songs }
}

/**
 * §5 工具执行回路：模型发起 tool_calls → contested 检查（§4.7）→ 确认票（§4.6）→ MCP 执行 →
 * 结果回灌 → 模型继续，直至给出最终回答或触及轮次/时限上限。
 * 确认闭环：首次调用返回 confirmation_required 合成 tool 结果并签发票据（redis 5 分钟）；
 * 用户回复「确认」后模型重新发起同一调用，票据按 session+tool+argsHash 验签兑现；
 * 用户回复「取消」则作废票据。
 */
async function executeToolLoop(
  deps: ChatDeps,
  req: ChatRequest,
  st: LoopState,
  model: string,
  built: BuiltContext,
  onDelta?: DeltaSink,
): Promise<ToolLoopOutcome> {
  const spec = lookupModel(model)
  // §20：local lane 降级纯对话，不暴露工具 schema
  let laneTools = !spec || spec.lane === 'local' || st.privacyLane === 'local' ? [] : toolsForLane(st.lane)
  // §5.4：用网关真实 input_schema 喂模型；网关不可达时保留占位空 schema（调用端报 unknown-server，不静默）
  try {
    laneTools = enrichSchemas(laneTools, await deps.mcp.listTools(), st.lane)
  } catch (e) {
    console.error('[tools] mcp-gateway unreachable; schemas stay empty:', e instanceof Error ? e.message : e)
  }
  // 客户端工具合流（origin=client）：撞名时客户端显式声明压过注册表（被顶掉的网关工具本轮退场）
  const merged = mergeClientTools(laneTools, st.clientTools)
  const clientFnNames = new Set(merged.client.map(t => t.function?.name ?? ''))
  // 厂商原生工具（非 function 条目，如联网搜索）按型号开关透传；未放行的型号直接丢弃——
  // 逐款确认 LiteLLM 透传行为后在 modelRegistry.nativeToolsPassthrough 显式开启
  const nativeEntries = st.clientTools.filter(t => t.type !== 'function')
  const allowedNative = spec?.nativeToolsPassthrough === true ? nativeEntries : []
  const nativeDropped = nativeEntries.length - allowedNative.length
  const openAiTools: NonNullable<ChatOptions['tools']> = [
    ...toOpenAiTools(merged.gateway),
    ...merged.client.map(t => ({
      type: 'function' as const,
      function: {
        name: t.function!.name,
        description: t.function?.description ?? '',
        parameters: t.function?.parameters ?? { type: 'object', properties: {} },
      },
    })),
    ...allowedNative,
  ]
  const currentMessage = st.currentMessage
  const cancelled = /取消/.test(currentMessage)
  const pendingKey = `confirm:pending:${st.session.sessionId}`
  // 续轮：当前 user 行已在 DB 历史里（位于工具结果之前），不追加；新用户轮照常追加（§3.5）
  const convo: ChatMessage[] = [...built.messages, ...(st.continuation ? [] : [{ role: 'user' as const, content: currentMessage }])]
  const deadline = Date.now() + TOOL_LOOP_DEADLINE_MS
  const meta = { rounds: 0, executed: 0, pending: 0 }
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }

  for (;;) {
    // 温度按模型上限收敛：推理型模型 temperature>1 会被上游拒（UnsupportedParamsError，RikkaHub 默认 2 会踩）
    const callOpts: ChatOptions = {
      temperature: clampTemperature(st.temperature, model),
      tools: openAiTools.length > 0 ? openAiTools : undefined,
      ...(openAiTools.length > 0 && st.toolChoice !== undefined ? { toolChoice: st.toolChoice } : {}),
    }
    // 真流式：有 sink 走 token 级透传（工具轮的中间文本同样外发，语义与客户端累计的 assistant 消息一致）
    const result = onDelta
      ? await deps.gateway.chatStream(model, convo, callOpts, t => onDelta(t, model))
      : await deps.gateway.chat(model, convo, callOpts)
    usage.promptTokens += result.promptTokens
    usage.completionTokens += result.completionTokens
    usage.cachedTokens += result.cachedTokens
    const calls = result.toolCalls ?? []
    if (calls.length === 0) return { result, meta, usage, nativeDropped: nativeDropped || undefined }
    // origin=client 的调用终止服务端回路：网关不执行外来工具，原样回交客户端。
    // 即便触及轮次/时限上限也要回交——否则客户端的工具链会在网关这里凭空断掉。
    const clientCalls = calls.filter(c => clientFnNames.has(c.name))
    const capped = meta.rounds >= MAX_TOOL_ROUNDS || Date.now() > deadline
    if (clientCalls.length === 0 && capped) {
      if (result.content === '') {
        result.content = '（工具执行轮次已达上限，先回答到这里。）'
        // 流式客户端也要看到这段占位文本（只落库不外发会让用户收到空气回复）
        onDelta?.(result.content, model)
      }
      return { result, meta, usage, nativeDropped: nativeDropped || undefined }
    }
    meta.rounds++

    const specs = rawSpecs(calls)
    convo.push({ role: 'assistant', content: result.content ?? '', tool_calls: specs })
    await deps.db.query(
      `INSERT INTO conversation_messages (session_id, role, content, tool_calls, model_used)
       VALUES ($1, 'assistant', $2, $3, $4)`,
      [st.session.sessionId, result.content ?? '', JSON.stringify(specs), model],
    )

    // origin=gateway：服务端执行，确认票/contested 纪律原样生效
    for (const call of calls) {
      if (clientFnNames.has(call.name)) continue
      const rt = resolveTool(call.name, laneTools)
      let resultText: string
      if (!rt) {
        resultText = `error: unknown tool ${call.name}`
      } else {
        let args: Record<string, unknown> = {}
        try { args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') as Record<string, unknown> : call.args } catch { args = {} }

        const contested = await contestedGate(deps.twig, req.user.eternal_id, rt.capability)
        const needConfirm = rt.confirmationRequired || contested
        const pendingRaw = needConfirm ? await deps.redis.get(pendingKey) : null
        let redeemed = false
        if (pendingRaw) {
          const p = JSON.parse(pendingRaw) as { ticket: string; fnName: string }
          if (p.fnName === rt.fnName) {
            const verdict = verifyTicket(p.ticket, { sid: st.session.sessionId, tool: rt.fnName, args }, env.CONFIRM_SECRET)
            if (verdict.ok) redeemed = true
          }
        }

        if (needConfirm && cancelled && pendingRaw) {
          await deps.redis.del(pendingKey)
          resultText = JSON.stringify({ status: 'cancelled', prompt: '用户已取消本次操作。请告知用户操作已取消。' })
        } else if (needConfirm && !redeemed) {
          const ticket = issueTicket({ sid: st.session.sessionId, tool: rt.fnName, args }, env.CONFIRM_SECRET)
          await deps.redis.set(pendingKey, JSON.stringify({ ticket, fnName: rt.fnName }), 'EX', 300)
          meta.pending++
          resultText = JSON.stringify({
            status: contested ? 'contested_ask_user_first' : 'confirmation_required',
            prompt: `我需要执行 ${rt.fnName}（${summarizeArgs(args)}）。${contested ? '注意：你此前否决过与这相关的偏好，请先确认是否仍要执行。' : ''}请回复「确认」执行，或「取消」放弃。`,
          })
        } else {
          if (needConfirm && redeemed) await deps.redis.del(pendingKey)
          meta.executed++
          resultText = await safeToolCall(deps, rt.server, rt.tool, args)
          // 音乐结果 → 附件收集（§5.5；仅 play 出结果集，search 只是候选列表）
          if (rt.capability === 'music' && resultText.includes('"music"')) {
            const env = musicEnvelope(resultText)
            if (env && rt.tool === 'play' && rt.server === 'music') {
              st.attachments = env.songs.slice(0, 1)
            }
          }
        }
      }

      convo.push({ role: 'tool', tool_call_id: call.id, content: resultText.slice(0, 4000) })
      await deps.db.query(
        `INSERT INTO conversation_messages (session_id, role, content, tool_results)
         VALUES ($1, 'tool', $2, $3)`,
        [st.session.sessionId, resultText.slice(0, 4000), JSON.stringify({ tool_call_id: call.id, fn: call.name })],
      )
    }

    // 回交客户端：origin=client 的调用到此终止回路，gateway-origin 的结果已落库，
    // 模型在下一请求的装配里（DB 回放）看到它们后再综合
    if (clientCalls.length > 0) {
      return { result, meta, usage, clientToolCalls: clientCalls, assistantPersisted: true, nativeDropped: nativeDropped || undefined }
    }
  }
}

/**
 * 沿链跳过的上游错误：401/403（凭证缺失或地区被拒）、404（模型组不存在/无可用部署）。
 * 这些都意味着「这个 provider 现在用不了」，跳到链上下一个候选，而不是中断整条 fallback。
 */
function isProviderMisconfig(e: unknown): boolean {
  return e instanceof LiteLlmError && (e.status === 401 || e.status === 403 || e.status === 404)
}

/** §3.8 每个候选独立装配（重装配），retryable/凭证缺失错误沿链降级；其余非 retryable 直接映射。 */
async function runModelLoop(deps: ChatDeps, req: ChatRequest, st: LoopState, onDelta?: DeltaSink): Promise<ChatOutcome> {
  let result: ChatResult | null = null
  let usedModel = ''
  let built = st.built
  let lastError: unknown = null
  // 真流式：一旦有 delta 外发即「已提交」——上游失败不允许换模型重试（客户端已收到部分文本，重试会重复）
  let streamedAny = false
  const sink: DeltaSink | undefined = onDelta
    ? (text, model) => { streamedAny = true; onDelta(text, model) }
    : undefined

  for (const model of st.chain) {
    const spec = lookupModel(model)
    if (!spec) continue // fail-closed：未登记模型跳过
    // 重装配：仅首个候选可用缓存命中的装配产物（其键绑定 chain[0]）。
    // ContextTooSmallError（窗口装不下 pin 项）按「跳到下一候选」处理而非 500——§3.8 的既定语义。
    let builtForModel: BuiltContext
    try {
      const tA = Date.now()
      builtForModel = built && model === st.chain[0] ? built : await deps.builder.build(st.ctxBase, model)
      latencySeconds.observe({ stage: 'assemble', provider: spec.provider }, (Date.now() - tA) / 1000)
    } catch (e) {
      if (e instanceof ContextTooSmallError) {
        st.fallbackCount++
        continue
      }
      throw e
    }

    const exactKey = buildCacheKey('exact', req.user.eternal_id, builtForModel.narrativeVersion,
      [...builtForModel.messages, { role: 'user', content: st.currentMessage }],
      model, { temperature: clampTemperature(st.temperature, model) })

    if (st.cacheHitType === 'miss' && !st.crisis && st.privacyLane === 'cloud'
      && !st.continuation && st.clientTools.length === 0) {
      const exactHit = await exactGet(deps.redis, exactKey)
      if (exactHit) {
        return await finalize(deps, req, {
          ...st, content: exactHit.response, usedModel: exactHit.model, result: null,
          built: builtForModel, chain: [model], cacheHitType: 'exact',
        })
      }
    }

    const t0 = Date.now()
    try {
      const outcome = await executeToolLoop(deps, req, st, model, builtForModel, sink)
      latencySeconds.observe({ stage: 'model.call', provider: spec.provider }, (Date.now() - t0) / 1000)
      // 装配必须与最终 usedModel 配对：fallback 命中后一候选时，finalize 的缓存写入若沿用
      // 首候选的装配，会把 A 模型窗口的上下文存进 B 模型的键（超出小窗口模型上限 → 上游 400）
      result = { ...outcome.result,
        promptTokens: outcome.usage.promptTokens, completionTokens: outcome.usage.completionTokens, cachedTokens: outcome.usage.cachedTokens }
      st.toolMeta = outcome.meta
      if (outcome.clientToolCalls) st.clientToolCalls = outcome.clientToolCalls
      if (outcome.assistantPersisted) st.assistantPersisted = true
      if (outcome.nativeDropped) st.nativeDropped = outcome.nativeDropped
      usedModel = model
      built = builtForModel
      break
    } catch (e) {
      lastError = e
      if (streamedAny) throw mapGatewayError(e) // 已向客户端发帧：换模型重试会重复文本
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
  const currentMessage = st.currentMessage
  const provider = providerOf(st.usedModel)
  const prefs = req.user.preferences ?? {}
  const clientType = st.clientType

  // TTS（§21.6，v0.3.1 PATCH-06：独立情绪分类器）。回交轮没有可读的最终文本，跳过
  let audio: { data: string; mime: string; expires_in: number } | undefined
  let ttsChars: number | undefined
  const voiceCapable = req.client.metadata?.['voice_capable'] === true
  if (voiceCapable && st.content.trim().length > 0 && !st.clientToolCalls) {
    const ttsCount = await recentTtsCount(deps.db, st.session.sessionId)
    if (shouldTTS(st.content, {
      crisis: st.crisis,
      alwaysTTS: prefs['alwaysTTS'] === true,
      recentTtsCount: ttsCount,
    })) {
      const sanitized = ttsSanitize(st.content, { crisis: st.crisis })
      ttsChars = [...sanitized].length
      const synthesized = await synthesizeTts(sanitized, {
        elevenlabs: {
          apiKey: process.env.ELEVENLABS_API_KEY || undefined,
          voiceId: process.env.ELEVENLABS_VOICE_ID || undefined,
        },
        siliconflow: { apiKey: process.env.SILICONFLOW_API_KEY || undefined },
        openai: { apiKey: process.env.OPENAI_API_KEY || undefined },
      })
      if (synthesized) {
        const key = await stashAudio(deps.redis, st.requestId, synthesized)
        audio = { data: key, mime: synthesized.mime, expires_in: 60 } // data 为即焚键，非内联音频
      }
    }
  }

  // 对话持久化（§8.1）：用户消息已在管线入口落库；exact 命中同样落助手行（保持 DB 与用户实际经历一致）。
  // 回交轮（origin=client tool_calls）的助手行已由工具回路落库，这里跳过
  const assistantTokens = estimateTokens(st.content)
  const assistantMessageId = st.assistantPersisted ? undefined : await (async () => {
    const { rows: asstRows } = await deps.db.query<{ id: string }>(
      `INSERT INTO conversation_messages (session_id, role, content, token_count, model_used, tokens_output, latency_ms, was_tts)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [st.session.sessionId, st.content, assistantTokens, st.usedModel, st.result?.completionTokens ?? 0, st.result?.latencyMs ?? 0, audio !== undefined],
    )
    return asstRows[0]?.id
  })()

  // 缓存写（§7.6 Policy；危机/local 不写；工具轮次短 TTL；待确认会话不缓存——下一轮语境会变；
  // 客户端工具轮与续轮的装配含 tools/工具结果语义，键形状不匹配，一并跳过）
  const toolUsed = (st.toolMeta?.executed ?? 0) > 0 || (st.toolMeta?.pending ?? 0) > 0
  if (!st.crisis && st.privacyLane === 'cloud' && st.built && !st.clientToolCalls && !st.continuation) {
    const decision = shouldCache({
      crisis: false,
      status: 200,
      metadata: req.metadata as { cache?: boolean } | undefined,
      hasToolResults: req.messages.some(m => m.role === 'tool') || toolUsed,
    })
    const cacheable = decision.shouldCache && (st.toolMeta?.pending ?? 0) === 0
    if (cacheable && decision.ttl) {
      const exactKey = buildCacheKey('exact', req.user.eternal_id, st.built.narrativeVersion,
        [...st.built.messages, { role: 'user', content: currentMessage }], st.usedModel,
        // 键用收敛后的实际采样参数：写入键与读取键一致（RikkaHub 默认 2 与默认 0.7 的请求由此可互相命中）
        { temperature: clampTemperature(st.temperature, st.usedModel) })
      await exactSet(deps.redis, exactKey, { response: st.content, model: st.usedModel, output_tokens: st.result?.completionTokens ?? 0 }, decision.ttl)
      if (st.narrativeVersion) {
        // assembled 带「当时那条用户消息」整段存储：命中方把它当既有历史，再由调用方追加新一轮
        // 当前消息（§3.5 契约）。若只存 builder 产物（排除当前消息行），命中回放会缺最后一条用户轮。
        await contextSet(deps.redis,
          contextCacheKey(req.user.eternal_id, st.session.sessionId, st.narrativeVersion, st.usedModel),
          { session_id: st.session.sessionId,
            assembled: [...st.built.messages, { role: 'user', content: currentMessage }],
            thread_ids: st.built.packet?.threads.map(t => t.id) ?? [] })
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

  // 摄入（§3.6）：只灌用户原文；危机路径照常 ingest（twig 内部自动中止全部对照窗口）。
  // 续轮的 currentMessage 是上一轮的旧文，重灌会制造重复碎片——跳过
  if (!st.continuation) {
    deps.ingestion.ingestTurn(req.user.eternal_id, currentMessage).catch(err => {
      errorsTotal.inc({ error_type: 'twig_ingest', provider: 'twig' })
      console.error('[ingest] failed:', err instanceof Error ? err.message : err)
    })
  }

  // 指标（§11，async sidecar 语义）
  requestsTotal.inc({ client_type: clientType, session_type: st.session.sessionType, provider, model: st.usedModel })
  tokensTotal.inc({ type: 'input', provider }, st.result?.promptTokens ?? 0)
  tokensTotal.inc({ type: 'output', provider }, st.result?.completionTokens ?? 0)
  if (st.cacheHitType !== 'miss') cacheHitsTotal.inc({ cache_type: st.cacheHitType })
  latencySeconds.observe({ stage: 'request_total', provider }, (Date.now() - st.started) / 1000)

  return {
    status: 200,
    payload: {
      id: st.result?.id ?? st.requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: st.usedModel,
      choices: [{
        index: 0,
        // 回交轮按 OpenAI 协议返回 tool_calls，finish_reason: tool_calls——客户端在其设备上执行后携结果续轮
        message: {
          role: 'assistant',
          content: st.content,
          ...(st.clientToolCalls ? { tool_calls: st.clientToolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}),
        },
        finish_reason: st.clientToolCalls ? 'tool_calls' : 'stop',
      }],
      usage: {
        prompt_tokens: st.result?.promptTokens ?? 0,
        completion_tokens: st.result?.completionTokens ?? assistantTokens,
        total_tokens: (st.result?.promptTokens ?? 0) + (st.result?.completionTokens ?? assistantTokens),
        cache_read_tokens: st.result?.cachedTokens ?? 0,
        cache_write_tokens: 0,
      },
      ...(audio ? { audio } : {}),
      ...(st.attachments && st.attachments.length > 0 ? { attachments: st.attachments } : {}),
      mnemosyne: {
        cache_hit_type: st.cacheHitType,
        narrative_version: st.built?.narrativeVersion ?? 'unknown',
        privacy_tier: st.privacyLane,
        route_reason: st.routeReason,
        fallback_count: st.fallbackCount,
        ...(assistantMessageId ? { assistant_message_id: assistantMessageId } : {}),
        ...(st.nativeDropped ? { native_tools_dropped: st.nativeDropped } : {}),
        ...(st.toolMeta ? { tool_rounds: st.toolMeta.rounds, tool_executed: st.toolMeta.executed, tool_pending: st.toolMeta.pending } : {}),
      },
    },
  }
}
