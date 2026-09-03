/**
 * Huginn 手动/独立入口：主管线扫描 + Outbox Worker。
 * 容器内由 index.ts 自带调度；本脚本用于本地调试与外部 cron 托管形态。
 *
 *   npm run huginn -- --once scan
 *   npm run huginn -- --once outbox
 *   npm run huginn -- --loop
 */
import { parseArgs } from 'node:util'
import cronParser from 'cron-parser'
import { migrate, pool } from '../src/db.js'
import { env } from '../src/config.js'
import { TwigAdapter } from '../src/memory/TwigAdapter.js'
import { ModelGateway } from '../src/gateways/litellm.js'
import { loadHuginnConfig } from '../src/outreach/policy.js'
import { runScan, defaultGuard } from '../src/outreach/pipeline.js'
import { runOutboxWorker } from '../src/outreach/outboxWorker.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { once: { type: 'string' }, loop: { type: 'boolean', default: false } },
  })
  await migrate()
  const cfg = loadHuginnConfig()
  const twig = new TwigAdapter(env.TWIG_URL, env.MUNINN_AUTH_TOKEN)
  const gateway = new ModelGateway(env.LITELLM_URL, env.LITELLM_API_KEY)
  const scanDeps = { db: pool, twig, gateway, guard: defaultGuard(), cfg, log: (m: string) => console.log(m) }
  const outboxDeps = { db: pool, twig, guard: scanDeps.guard, cfg, log: (m: string) => console.log(m) }

  if (values.once === 'scan') {
    await runScan(scanDeps)
    await pool.end()
  } else if (values.once === 'outbox') {
    await runOutboxWorker(outboxDeps)
    await pool.end()
  } else if (values.loop) {
    console.log(`[huginn] loop: scan="${cfg.scan_interval}" outbox=${cfg.outbox_worker_interval}s`)
    // 常驻形态：池保持打开（此前控制流落到 pool.end()，之后每轮都对着已关闭的池报错）；
    // scan 按 cron 表达式分钟匹配调度，而非拍脑袋的 15min 轮询
    let lastMinute = ''
    setInterval(() => void runOutboxWorker(outboxDeps).catch(console.error), cfg.outbox_worker_interval * 1000)
    setInterval(() => {
      const now = new Date()
      try {
        const prev = cronParser.parseExpression(cfg.scan_interval, { currentDate: now }).prev().toDate()
        const minuteKey = now.toISOString().slice(0, 16)
        if (now.getTime() - prev.getTime() >= 60_000 || prev > now || minuteKey === lastMinute) return
        lastMinute = minuteKey
        void runScan(scanDeps).catch(console.error)
      } catch {
        // 非法 cron：不调度
      }
    }, 30_000)
  } else {
    console.error('usage: npm run huginn -- --once scan|outbox | --loop')
    await pool.end()
    process.exit(2)
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
