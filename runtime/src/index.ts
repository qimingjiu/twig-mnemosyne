/**
 * Mnemosyne Runtime 入口：迁移 → 依赖装配 → twig 启动断言（§8.3）→ HTTP → Huginn 调度（§19）。
 */
import Fastify from 'fastify'
import { Redis } from 'ioredis'
import cronParser from 'cron-parser'
import { env } from './config.js'
import { pool, migrate } from './db.js'
import { TwigAdapter } from './memory/TwigAdapter.js'
import { MemoryIngestionPipeline } from './memory/ingestion.js'
import { ModelGateway } from './gateways/litellm.js'
import { ContextBuilder } from './context/builder.js'
import { Box } from './util/crypto.js'
import { AttemptLimiter, authClient, getUserById } from './identity/service.js'
import { registerRoutes } from './http/routes.js'
import { McpGatewayClient } from './tools/executor.js'
import { startTelegramPolling } from './telegram/adapter.js'
import { loadHuginnConfig } from './outreach/policy.js'
import { runScan, defaultGuard } from './outreach/pipeline.js'
import { runOutboxWorker } from './outreach/outboxWorker.js'

/** cron 表达式调度：每 30s 检查一次，按分钟去重（调度器重复触发由 outbox/幂等键兜底，T9.12）。 */
function scheduleCron(expr: string, fn: () => Promise<void>, log: (m: string) => void): ReturnType<typeof setInterval> {
  let lastMinute = ''
  let running = false
  const timer = setInterval(() => {
    const now = new Date()
    try {
      const prev = cronParser.parseExpression(expr, { currentDate: now }).prev().toDate()
      const hits = now.getTime() - prev.getTime() < 60_000 && prev <= now
      const minuteKey = now.toISOString().slice(0, 16)
      if (!hits || minuteKey === lastMinute || running) return
      lastMinute = minuteKey
      running = true
      fn().catch(e => log(`[scheduler] task failed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => { running = false })
    } catch {
      // 非法 cron：不调度（配置校验应在部署前完成）
    }
  }, 30_000)
  return timer
}

async function main(): Promise<void> {
  const applied = await migrate()
  if (applied.length > 0) console.log('[migrate] applied:', applied.join(', '))

  const redis = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 })
  const twig = new TwigAdapter(env.TWIG_URL, env.MUNINN_AUTH_TOKEN)
  const gateway = new ModelGateway(env.LITELLM_URL, env.LITELLM_API_KEY)
  const builder = new ContextBuilder(pool, twig)
  const ingestion = new MemoryIngestionPipeline(twig)
  const box = new Box(env.ENCRYPTION_KEY)

  // §8.3 部署自检：启动断言 twig auth === true，否则拒绝启动（T8.10）。
  // 滚动部署/镜像重建期间 twig 会短暂不可达——先前一次失败即 process.exit(1)，把机器人打进
  // CrashLoopBackOff 直到 twig 稳定（2026-09-01「AI 死了」事故）；现改为 60s 内重试，耗尽才拒启。
  const TWIG_RETRY_LIMIT = 30
  let twigCheck = ''
  for (let attempt = 1; attempt <= TWIG_RETRY_LIMIT; attempt++) {
    try {
      const h = await twig.health()
      if (!h.ok || !h.auth) throw new Error(`twig health ok=${h.ok} auth=${h.auth}`)
      console.log(`[twig] health ok, auth=true, llm=${h.llm}`)
      twigCheck = ''
      break
    } catch (e) {
      twigCheck = e instanceof Error ? e.message : String(e)
      if (attempt < TWIG_RETRY_LIMIT) {
        console.warn(`[twig] health attempt ${attempt}/${TWIG_RETRY_LIMIT} failed: ${twigCheck}; retrying in 2s`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }
  if (twigCheck) {
    if (env.NODE_ENV === 'production') {
      console.error(`[twig] startup assertion failed after ${TWIG_RETRY_LIMIT} attempts, refusing to start: ${twigCheck}`)
      process.exit(1)
    }
    console.warn(`[twig] health check failed (development mode continues): ${twigCheck}`)
  }

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      // §11.5：PII 管控在观测侧履行——请求体绝不整体入日志
      redact: { paths: ['req.headers.authorization', 'req.headers["x-client-key"]'], censor: '[REDACTED]' },
    },
  })

  const mcp = new McpGatewayClient()
  registerRoutes(app, {
    db: pool,
    redis,
    twig,
    gateway,
    builder,
    ingestion,
    box,
    mcp,
    limiter: new AttemptLimiter(),
    identityAuth: k => authClient(pool, k),
    userOf: id => getUserById(pool, id),
  })

  // MCP 管道自检：接线错误（mcp-gateway 服务没建 / MCP_GATEWAY_URL 没配）此前只在工具调用时
  // 静默失败、模型拿不到结果就开始瞎编（2026-09-01「自己查時間」事故）；启动时打真探针暴露断点。
  try {
    const n = await mcp.ping()
    app.log.info(`[mcp] gateway ok: ${n} tools (${env.MCP_GATEWAY_URL})`)
  } catch (e) {
    app.log.warn(
      `[mcp] gateway unreachable at ${env.MCP_GATEWAY_URL} (${e instanceof Error ? e.message : String(e)}) — ` +
      '工具将不可用。检查：① mcp-gateway 服务是否已创建 ② mnemosyne 的 MCP_GATEWAY_URL 是否指向其私有地址',
    )
  }

  // §1 传输层：Telegram 长轮询（token 缺省时自动关闭）
  startTelegramPolling({
    db: pool, redis, twig, gateway, builder, ingestion, box, mcp,
    botToken: env.TELEGRAM_BOT_TOKEN,
  })

  // Huginn 调度（§19.3/v0.3.1）：主管线 cron + Outbox Worker 轮询
  const timers: ReturnType<typeof setInterval>[] = []
  const huginn = loadHuginnConfig()
  if (huginn.enabled) {
    const guard = defaultGuard()
    const deps = { db: pool, twig, gateway, guard, cfg: huginn, log: (m: string) => app.log.info(m) }
    timers.push(scheduleCron(huginn.scan_interval, () => runScan(deps), m => app.log.error(m)))
    // 防重叠：twig 故障时单轮可拖 ~100s（10 行 × 10s 超时），裸 setInterval 会叠出并发轮——
    // 同一批 pending 行被重复 intervene、attempts 基于过期快照回写
    let outboxRunning = false
    timers.push(
      setInterval(() => {
        if (outboxRunning) return
        outboxRunning = true
        runOutboxWorker({ db: pool, twig, guard, cfg: huginn, log: m => app.log.info(m) })
          .catch(e => app.log.error(`[outbox] worker failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => { outboxRunning = false })
      }, huginn.outbox_worker_interval * 1000),
    )
    app.log.info(`[huginn] enabled: scan="${huginn.scan_interval}" cap=${huginn.daily_cap}`)
  }

  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  console.log(`[mnemosyne] listening on :${env.PORT} (${env.NODE_ENV})`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[mnemosyne] ${signal} received, shutting down`)
    for (const t of timers) clearInterval(t)
    await app.close().catch(() => undefined)
    redis.disconnect()
    await pool.end().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(e => {
  console.error('[mnemosyne] fatal:', e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
