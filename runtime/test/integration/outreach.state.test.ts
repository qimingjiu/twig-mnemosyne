/**
 * Huginn 状态机集成测试（真实 Postgres + 本地 webhook）：
 * - T9.5：8 worker 并发抢槽，cap=3 → 无穿洞
 * - T9.8：相同 dedupe_key 二次写入必失败（部分唯一索引对 <> '' 生效）；空键占位行互不阻塞
 * - T9.7：幂等投递（Idempotency-Key = dedupe_key，64-hex 稳定）
 * - T9.1/INV-H01：daily_cap=3，第 4 次扫描零投递；remention 7 天防纠缠冷却生效
 * - T9.6/T9.11（INV-H02/H06）：delivered+pending 经 outbox worker 补报 → completed
 * - INV-H03/H04：muted 与 crisis_silence 硬过滤，零投递
 *
 * 运行：TEST_DATABASE_URL=postgresql://... npm run test:integration
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { hasDb, db, resetDb } from './helpers.js'
import { createUser, type UserRow } from '../../src/identity/service.js'
import type { TwigAdapter } from '../../src/memory/TwigAdapter.js'
import type { ModelGateway } from '../../src/gateways/litellm.js'
import { reserveOutreachSlot } from '../../src/outreach/reserve.js'
import { runScan, type OutreachDeps } from '../../src/outreach/pipeline.js'
import { runOutboxWorker } from '../../src/outreach/outboxWorker.js'
import { HUGINN_DEFAULTS, type HuginnConfig } from '../../src/outreach/policy.js'

interface RecordedIntervention {
  claimId?: string
  text: string
  extra?: Record<string, unknown>
}

/** fake twig：始终提供一个 pending remention 邀请 + 递增的 vein-nudge 线索池；记录 intervene 调用。 */
function fakeTwig() {
  const interventions: RecordedIntervention[] = []
  let threadSeq = 0
  const twig = {
    listClaims: async () => [{
      id: 'c1', text: '某观察', conviction: 0.5, boundary: '', status: 'contested',
      rementionInvitation: { at: new Date().toISOString(), text: '再提一下之前你纠正过我的判断' },
    }],
    getContextPacket: async () => {
      threadSeq++
      return {
        userId: 'u', generatedAt: new Date().toISOString(),
        threads: Array.from({ length: 9 }, (_, i) => ({
          id: `t${i + 1}`, label: `线索${i + 1}`, openQuestion: `问题${i + 1}`,
          pool: 'ACTIVE', daysOpen: 5, dragonVein: 0.9 - i * 0.01,
        })),
        claims: [], recentFragments: [], promptText: 'P',
      }
    },
    intervene: async (_uid: string, claimId: string | undefined, text: string, extra?: Record<string, unknown>) => {
      interventions.push({ claimId, text, extra })
      return {}
    },
  }
  return { twig: twig as unknown as TwigAdapter, interventions }
}

const fakeGateway = {
  chat: async () => ({
    id: 'x', model: 'gpt-4o', content: '嘿，想起你了，最近好吗？',
    promptTokens: 1, completionTokens: 1, cachedTokens: 0, latencyMs: 1,
  }),
} as unknown as ModelGateway

const testCfg: HuginnConfig = {
  ...HUGINN_DEFAULTS,
  daily_cap: 3,
  min_interval_minutes: 0,
  quiet_hours: '00:00-00:00', // s===e → 永不静默
}

interface WebhookBag {
  url: string
  hits: { idem: string | null; body: Record<string, unknown> }[]
  close: () => Promise<void>
}

async function startWebhook(): Promise<WebhookBag> {
  const hits: { idem: string | null; body: Record<string, unknown> }[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      hits.push({ idem: (req.headers['idempotency-key'] as string | undefined) ?? null, body: JSON.parse(raw || '{}') })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/hook`, hits, close: () => new Promise(r => server.close(() => r())) }
}

async function setupUserWithWebhook(label: string): Promise<{ user: UserRow; deps: OutreachDeps; hook: WebhookBag; interventions: RecordedIntervention[] }> {
  const { user } = await createUser(db, { email: `${label}-${Date.now()}@example.com`, masterKey: 'huginn-test-1234' })
  const hook = await startWebhook()
  await db.query(
    `INSERT INTO clients (user_id, client_type, key_hash, webhook_url, scopes)
     VALUES ($1, 'api', 'test-hash', $2, '{chat}')`,
    [user.id, hook.url],
  )
  const { twig, interventions } = fakeTwig()
  return {
    user,
    interventions,
    hook,
    deps: {
      db,
      twig,
      gateway: fakeGateway,
      guard: { allowInsecure: true, allowlist: ['127.0.0.1'] },
      cfg: testCfg,
    },
  }
}

async function outreachRows(userId: string) {
  const { rows } = await db.query<{ status: string; intervention_status: string | null; dedupe_key: string; filter_reason: string | null; outreach_type: string | null }>(
    'SELECT status, intervention_status, dedupe_key, filter_reason, outreach_type FROM outreach WHERE user_id = $1 ORDER BY slot_number',
    [userId],
  )
  return rows
}

describe.skipIf(!hasDb())('outreach state machine (integration)', () => {
  beforeAll(async () => { await resetDb() })
  beforeEach(async () => { await resetDb() })
  afterAll(async () => { await db.end() })

  it('T9.5：8 个并发抢槽，cap=3 → 成功数恰为 3 且槽位互异', async () => {
    const { user } = await createUser(db, { email: `race-${Date.now()}@example.com`, masterKey: 'race-test-12345' })
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveOutreachSlot(db, user.id, 3)),
    )
    const won = results.filter((s): s is number => s !== null)
    expect(won).toHaveLength(3)
    expect(new Set(won).size).toBe(3) // UNIQUE(user_id, reservation_date, slot_number)
  })

  it('T9.8：相同 dedupe_key 二次写入必失败；空键占位行互不阻塞（补丁硬伤修正回归锚点）', async () => {
    const { user } = await createUser(db, { email: `dup-${Date.now()}@example.com`, masterKey: 'dup-test-123456' })
    const slot = await reserveOutreachSlot(db, user.id, 3)
    expect(slot).not.toBeNull()
    const key = 'k'.repeat(64)
    await db.query(
      `UPDATE outreach SET dedupe_key = $1, dedupe_key_set_at = NOW() WHERE user_id = $2 AND slot_number = $3`,
      [key, user.id, slot],
    )
    await expect(db.query(
      `INSERT INTO outreach (user_id, outreach_type, content, dedupe_key, status)
       VALUES ($1, 'ritual', 'x', $2, 'delivery_pending')`,
      [user.id, key],
    )).rejects.toMatchObject({ code: '23505' })
    // filtered 行保持空键 → 不阻塞后续抢槽（原补丁 UNIQUE(user_id, dedupe_key) 会在此永久卡死）
    await expect(reserveOutreachSlot(db, user.id, 3)).resolves.not.toBeNull()
  })

  it('T9.7 + T9.1/INV-H01：幂等投递键稳定；第 4 次扫描零投递；remention 7 天冷却', async () => {
    const { user, deps, hook } = await setupUserWithWebhook("cap")

    await runScan(deps)
    expect(hook.hits).toHaveLength(1)
    expect(hook.hits[0]?.idem).toMatch(/^[a-f0-9]{64}$/) // Idempotency-Key = dedupe_key
    expect(hook.hits[0]?.body.content).toBeTruthy()
    expect((await outreachRows(user.id)).find(r => r.status === 'delivered')?.outreach_type).toBe('remention')

    // 第 2 次扫描：同一邀请仍在（未 REDEEMED）→ 宿主侧 7 天冷却拦截 remention，回落 vein-nudge
    await runScan(deps)
    // 第 3 次扫描：下一个 vein-nudge 线索
    await runScan(deps)
    const types = (await outreachRows(user.id)).filter(r => r.status === 'delivered').map(r => r.outreach_type)
    expect(types).toEqual(['remention', 'vein-nudge', 'vein-nudge'])

    // 第 4 次扫描：daily_cap 已满 → reserve 返回 null，零投递（INV-H01）
    const before = hook.hits.length
    await runScan(deps)
    expect(hook.hits.length).toBe(before)
    await hook.close()
  })

  it('T9.6/T9.11（INV-H02/H06）：delivered+pending 经 outbox worker 补报 → completed', async () => {
    const { user, deps, interventions, hook } = await setupUserWithWebhook('outbox')
    await runScan(deps)

    // 模拟崩溃后重启现场：delivered 且 intervention pending（T9.11 的输入状态）
    const delivered = (await outreachRows(user.id)).find(r => r.status === 'delivered')
    expect(delivered?.intervention_status).toBe('pending')

    await runOutboxWorker({ db, twig: deps.twig, cfg: testCfg })
    expect(interventions).toHaveLength(1)
    expect(interventions[0]?.extra?.evidenceLevel).toBe('post_intervention') // 权重降级信号
    expect(interventions[0]?.claimId).toBe('c1') // remention 上报绑定 claim（user_engaged 消费的前提）

    const after = await outreachRows(user.id)
    expect(after[0]?.status).toBe('completed')
    expect(after[0]?.intervention_status).toBe('reported') // INV-H06：completed ⇒ delivered AND reported
    await hook.close()
  })

  it('INV-H03/H04：muted 与 crisis_silence 硬过滤，零投递', async () => {
    const { user, deps, hook } = await setupUserWithWebhook('mute')
    await db.query(`UPDATE users SET preferences = '{"huginn_muted":true}'::jsonb WHERE id = $1`, [user.id])
    await runScan(deps)
    expect(hook.hits).toHaveLength(0)
    expect((await outreachRows(user.id))[0]).toMatchObject({ status: 'filtered', filter_reason: 'muted' })

    // 解除静音 → 危机静默接管
    await db.query(`UPDATE users SET preferences = '{}'::jsonb, crisis_silence_until = NOW() + INTERVAL '24 hours' WHERE id = $1`, [user.id])
    await db.query(`DELETE FROM outreach WHERE user_id = $1`, [user.id])
    await runScan(deps)
    expect(hook.hits).toHaveLength(0)
    expect((await outreachRows(user.id))[0]).toMatchObject({ status: 'filtered', filter_reason: 'crisis_silence' })
    await hook.close()
  })
})
