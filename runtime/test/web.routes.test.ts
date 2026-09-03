import { describe, it, expect } from 'vitest'
import { hash as argon2Hash } from '@node-rs/argon2'
import Fastify from 'fastify'
import { webLogin, AttemptLimiter, IdentityError } from '../src/identity/service.js'
import { registerWebRoutes, buildFeedEvents, type FeedEvent } from '../src/http/webRoutes.js'
import { TwigError } from '../src/memory/TwigAdapter.js'

/* ---------- 假 Db：按 queue 出行，记录调用 ---------- */
class FakeDb {
  calls: { sql: string; params: unknown[] }[] = []
  queue: { rows: unknown[] }[] = []
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, params })
    return this.queue.shift() ?? { rows: [] }
  }
}

const USER = {
  id: 'u-1',
  eternal_id: 'a'.repeat(64),
  display_name: '小月亮',
  email: 'user@example.com',
  master_key_hash: '',
  crisis_silence_until: null,
  preferences: {},
}

describe('webLogin（/v1/web/login 的服务端语义）', () => {
  it('首次登录：签发新 web client（scopes=chat），rotated=false', async () => {
    const db = new FakeDb()
    USER.master_key_hash = await argon2Hash('correct horse battery staple')
    db.queue.push({ rows: [USER] }) // getUserByEternalId
    db.queue.push({ rows: [] }) // 无既有 web client
    const limiter = new AttemptLimiter()
    const out = await webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'correct horse battery staple' }, limiter, '1.2.3.4')
    expect(out.rotated).toBe(false)
    expect(out.clientKey.startsWith('mn_')).toBe(true)
    const insert = db.calls.find(c => c.sql.includes('INSERT INTO clients'))
    expect(insert).toBeDefined()
    expect(insert!.params[0]).toBe(USER.id)
    expect(insert!.params[1]).toMatch(/^[a-f0-9]{64}$/) // key_hash = sha256(client_key)
    expect(insert!.params[2]).toBe('Aegean Night Dashboard')
  })

  it('再次登录：轮换既有 web client 的 key（旧会话失效），rotated=true', async () => {
    const db = new FakeDb()
    db.queue.push({ rows: [USER] })
    db.queue.push({ rows: [{ id: 'client-web-1' }] })
    const out = await webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'correct horse battery staple' }, new AttemptLimiter(), '1.2.3.4')
    expect(out.rotated).toBe(true)
    const update = db.calls.find(c => c.sql.includes('UPDATE clients'))
    expect(update).toBeDefined()
    expect(update!.params[1]).toBe('client-web-1')
  })

  it('master_key 错误 → 401，且不区分「用户不存在」（防枚举）', async () => {
    const db = new FakeDb()
    db.queue.push({ rows: [] }) // 用户不存在
    await expect(
      webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'wrong-wrong-wrong' }, new AttemptLimiter(), '1.2.3.4'),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credential' })
    db.queue.push({ rows: [USER] }) // 用户存在但口令错
    await expect(
      webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'wrong-wrong-wrong' }, new AttemptLimiter(), '1.2.3.4'),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credential' })
  })

  it('T1.5：10 次失败后限流 429', async () => {
    const db = new FakeDb()
    const limiter = new AttemptLimiter()
    for (let i = 0; i < 10; i++) {
      db.queue.push({ rows: [USER] })
      await expect(
        webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'wrong-wrong-wrong' }, limiter, '5.6.7.8'),
      ).rejects.toBeInstanceOf(IdentityError)
    }
    db.queue.push({ rows: [USER] })
    await expect(
      webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'correct horse battery staple' }, limiter, '5.6.7.8'),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
  })
})

describe('buildFeedEvents（铭文流合成）', () => {
  const base = {
    provider: 'litellm', model: 'claude-sonnet', latency_ms: 1090, output_tokens: 312,
    cache_hit_type: null, cache_saved_tokens: null, error: false, error_type: null,
  }
  const outreachBase = {
    delivered_at: null, created_at: null, outreach_type: null, status: '',
    slot_number: null, filter_reason: null, last_delivery_error: null,
  }

  it('model.call 成功 / cache HIT / 失败 三态映射', () => {
    const events = buildFeedEvents(
      [
        { ...base, timestamp: '2026-08-30T08:02:47Z' },
        { ...base, timestamp: '2026-08-30T08:02:45Z', model: 'gpt-4o', latency_ms: null, output_tokens: null, cache_hit_type: 'context', cache_saved_tokens: 2041 },
        { ...base, timestamp: '2026-08-30T08:03:00Z', model: 'gemini-pro', error: true, error_type: 'provider_error' },
      ],
      [],
    )
    expect(events).toHaveLength(3)
    expect(events[0]!.ts).toBe('2026-08-30T08:03:00.000Z') // 倒序
    expect(events[0]!.tag).toBe('model.call')
    expect(events[0]!.ok).toBe(false)
    expect(events[0]!.body).toContain('provider_error')
    const hit = events.find(e => e.tag === 'cache')!
    expect(hit.body).toContain('HIT context')
    expect(hit.body).toContain('2041')
    const ok = events.find(e => e.ts === '2026-08-30T08:02:47.000Z')!
    expect(ok.body).toContain('claude-sonnet')
    expect(ok.body).toContain('1090ms')
  })

  it('huginn 投递 / 失败 / filtered 映射，时间倒序合并', () => {
    const events: FeedEvent[] = buildFeedEvents(
      [{ ...base, timestamp: '2026-08-30T08:02:47Z' }],
      [
        { ...outreachBase, created_at: '2026-08-30T08:14:00Z', delivered_at: '2026-08-30T08:14:05Z', outreach_type: 'vein-nudge', status: 'delivered', slot_number: 1 },
        { ...outreachBase, created_at: '2026-08-30T07:00:00Z', status: 'filtered', filter_reason: 'quiet_hours' },
        { ...outreachBase, created_at: '2026-08-29T21:00:00Z', delivered_at: '2026-08-29T21:00:10Z', outreach_type: 'remention', status: 'failed', last_delivery_error: 'webhook timeout' },
      ],
    )
    expect(events.map(e => e.tag)).toEqual(['huginn.vein-nudge', 'model.call', 'huginn.filter', 'huginn.remention'])
    expect(events[0]!.body).toContain('slot 1')
    expect(events[2]!.body).toContain('quiet_hours')
    expect(events[3]!.ok).toBe(false)
  })
})

/* ---------- POST /v1/web/memory/* 写操作（BFF：runtime 校验 + 服务端持凭证） ---------- */
describe('web 写操作路由', () => {
  const CLIENT = { id: 'cw-1', user_id: 'u-1', client_type: 'web' }
  const redisOk = { incr: async () => 1, expire: async () => 1, get: async () => null, set: async () => null, del: async () => null, ping: async () => 'PONG' }

  function buildWebApp(twig: Record<string, unknown>) {
    const app = Fastify({ logger: false })
    registerWebRoutes(app, {
      db: { query: async () => ({ rows: [] }) },
      redis: redisOk,
      twig,
      limiter: new AttemptLimiter(),
      identityAuth: async (k: string) => (k === 'mn_ok' ? CLIENT : null),
      userOf: async () => USER,
    } as never)
    return app
  }

  it('contest：userId 钉死认证用户 eternal_id，成功 200', async () => {
    const calls: unknown[][] = []
    const app = buildWebApp({
      contest: async (...args: unknown[]) => { calls.push(args); return { ok: true } },
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/web/memory/claims/contest',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { claim_id: 'c-9', note: '这不是真的，我否决' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(calls[0]?.[0]).toBe(USER.eternal_id) // 不能指定他人
    expect(calls[0]?.[1]).toBe('c-9')
    await app.close()
  })

  it('缺 note → 400；无 key → 401', async () => {
    const app = buildWebApp({ contest: async () => ({ ok: true }) })
    const bad = await app.inject({
      method: 'POST', url: '/v1/web/memory/claims/contest',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { claim_id: 'c-1' },
    })
    expect(bad.statusCode).toBe(400)
    const noKey = await app.inject({
      method: 'POST', url: '/v1/web/memory/claims/contest',
      headers: { 'content-type': 'application/json' },
      payload: { claim_id: 'c-1', note: 'x' },
    })
    expect(noKey.statusCode).toBe(401)
    await app.close()
  })

  it('twig 404 透传 not_found；500 脱敏为 502 twig_error', async () => {
    const app404 = buildWebApp({
      correct: async () => { throw new TwigError('POST', '/v1/correct', 404, 'fragment 不存在') },
    })
    const r404 = await app404.inject({
      method: 'POST', url: '/v1/web/memory/correct',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { fragment_id: 'f-1', note: '修正' },
    })
    expect(r404.statusCode).toBe(404)
    expect(r404.json().error.type).toBe('not_found')
    await app404.close()

    const app502 = buildWebApp({
      correct: async () => { throw new TwigError('POST', '/v1/correct', 500, '内部含记忆内容不下传') },
    })
    const r502 = await app502.inject({
      method: 'POST', url: '/v1/web/memory/correct',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { fragment_id: 'f-1', note: '修正' },
    })
    expect(r502.statusCode).toBe(502)
    expect(r502.json().error.message).toBe('twig_error') // 细节不透传
    await app502.close()
  })

  it('notes：手写便签创建', async () => {
    const calls: unknown[][] = []
    const app = buildWebApp({
      createNote: async (...args: unknown[]) => { calls.push(args); return { id: 'n-1' } },
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/web/memory/notes',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { content: '今天把阳台的薄荷换了个大盆。' },
    })
    expect(res.statusCode).toBe(200)
    expect(calls[0]?.[0]).toBe(USER.eternal_id)
    expect(calls[0]?.[1]).toContain('薄荷')
    await app.close()
  })
})
