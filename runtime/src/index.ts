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

  // §8.3 部署自检：启动断言 twig auth === true，否则拒绝启动（T8.10）
  try {
    const h = await twig.health()
    if (!h.ok || !h.auth) throw new Error(`twig health ok=${h.ok} auth=${h.auth}`)
    console.log(`[twig] health ok, auth=true, llm=${h.llm}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (env.NODE_ENV === 'production') {
      console.error(`[twig] startup assertion failed, refusing to start: ${msg}`)
      process.exit(1)
    }
    console.warn(`[twig] health check failed (development mode continues): ${msg}`)
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

  // §1 传输层：Telegram 长轮询（token 缺省时自动关闭）
  startTelegramPolling({
    db: pool, redis, twig, gateway, builder, ingestion, box, mcp,
    botToken: env.TELEGRAM_BOT_TOKEN,
  })

  // Huginn 调度（§19.3/v0.3.1）：主管线 cron + Outbox Worker 轮询
  const timers: ReturnType<typeof setInterval>[] = []
  const huginn = loadHuginnConfig()
  if (huginn.enabled) {
    const deps = { db: pool, twig, gateway, guard: defaultGuard(), cfg: huginn, log: (m: string) => app.log.info(m) }
    timers.push(scheduleCron(huginn.scan_interval, () => runScan(deps), m => app.log.error(m)))
    timers.push(
      setInterval(() => {
        runOutboxWorker({ db: pool, twig, cfg: huginn, log: m => app.log.info(m) }).catch(e =>
          app.log.error(`[outbox] worker failed: ${e instanceof Error ? e.message : String(e)}`),
        )
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
