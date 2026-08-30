/**
 * Huginn 手动/独立入口：主管线扫描 + Outbox Worker。
 * 容器内由 index.ts 自带调度；本脚本用于本地调试与外部 cron 托管形态。
 *
 *   npm run huginn -- --once scan
 *   npm run huginn -- --once outbox
 *   npm run huginn -- --loop
 */
import { parseArgs } from 'node:util'
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
  const outboxDeps = { db: pool, twig, cfg, log: (m: string) => console.log(m) }

  if (values.once === 'scan') {
    await runScan(scanDeps)
  } else if (values.once === 'outbox') {
    await runOutboxWorker(outboxDeps)
  } else if (values.loop) {
    console.log(`[huginn] loop: scan="${cfg.scan_interval}" outbox=${cfg.outbox_worker_interval}s`)
    setInterval(() => void runOutboxWorker(outboxDeps).catch(console.error), cfg.outbox_worker_interval * 1000)
    setInterval(() => {
      // 分钟级 cron 匹配交给 runScan 内部策略过滤；此处按 scan_interval 的分钟粒度近似轮询
      void runScan(scanDeps).catch(console.error)
    }, 15 * 60 * 1000)
  } else {
    console.error('usage: npm run huginn -- --once scan|outbox | --loop')
    process.exit(2)
  }
  await pool.end()
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
