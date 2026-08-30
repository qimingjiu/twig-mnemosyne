/**
 * Identity 层回环（真实 Postgres）：
 * - master_key 签发 → authClient → session 解析
 * - D-02 / T-session：跨用户 session 归属 → 403
 * - T1.2：轮换后旧 key 失效
 * - provision scope 校验、错误凭证 401
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { hasDb, db, resetDb } from './helpers.js'
import {
  createUser, registerClient, authClient, resolveSession, rotateClientKey,
  getUserByEternalId, AttemptLimiter,
} from '../../src/identity/service.js'

const guard = { allowInsecure: false, allowlist: [] }

describe.skipIf(!hasDb())('identity roundtrip (integration)', () => {
  beforeAll(async () => { await resetDb() })
  afterAll(async () => { await db.end() })

  it('master_key 签发 → 认证 → session 解析 → 签发新 client', async () => {
    const { user } = await createUser(db, { email: 'a@example.com', masterKey: 'correct horse battery' })
    const limiter = new AttemptLimiter()

    const reg = await registerClient(db, {
      userEternalId: user.eternal_id,
      clientType: 'operit',
      credential: { type: 'master_key', masterKey: 'correct horse battery' },
    }, guard, limiter, '127.0.0.1')

    expect(reg.clientKey.startsWith('mn_')).toBe(true)

    const client = await authClient(db, reg.clientKey)
    expect(client).not.toBeNull()
    expect(client?.scopes).toContain('provision') // master_key 签发的首批 client 含 provision

    // session 归属解析
    const session = await resolveSession(db, user, { eternalSessionId: reg.eternalSessionId })
    expect(session.isNew).toBe(false)
    expect(session.userId).toBe(user.id)

    // client_signature 代签发（provision client 为手机签发新 client）
    const ts = Math.floor(Date.now() / 1000)
    const { hmacHex } = await import('../../src/util/crypto.js')
    const signature = hmacHex(reg.clientKey, `${user.eternal_id}telegram${ts}`)
    const reg2 = await registerClient(db, {
      userEternalId: user.eternal_id,
      clientType: 'telegram',
      credential: { type: 'client_signature', clientKey: reg.clientKey, timestamp: ts, signature },
    }, guard, limiter, '127.0.0.1')
    expect(reg2.clientKey).not.toBe(reg.clientKey)
  })

  it('D-02：他用户的 eternal_session_id → 403，而非创建或静默挂靠', async () => {
    const u1 = await createUser(db, { email: 'u1@example.com', masterKey: 'password-123456' })
    const u2 = await createUser(db, { email: 'u2@example.com', masterKey: 'password-654321' })
    const reg = await registerClient(db, {
      userEternalId: u1.user.eternal_id, clientType: 'web',
      credential: { type: 'master_key', masterKey: 'password-123456' },
    }, guard, new AttemptLimiter(), '127.0.0.1')

    await expect(resolveSession(db, u2.user, { eternalSessionId: reg.eternalSessionId }))
      .rejects.toMatchObject({ status: 403, code: 'session_forbidden' })
    // 归属者本人可继续解析
    await expect(resolveSession(db, u1.user, { eternalSessionId: reg.eternalSessionId })).resolves.toBeTruthy()
  })

  it('T1.2：轮换后旧 key 立即失效', async () => {
    const { user } = await createUser(db, { email: 'r@example.com', masterKey: 'rotate-me-12345' })
    const reg = await registerClient(db, {
      userEternalId: user.eternal_id, clientType: 'api',
      credential: { type: 'master_key', masterKey: 'rotate-me-12345' },
    }, guard, new AttemptLimiter(), '127.0.0.1')

    const oldClient = await authClient(db, reg.clientKey)
    expect(oldClient).not.toBeNull()
    const newKey = await rotateClientKey(db, oldClient!)

    expect(await authClient(db, reg.clientKey)).toBeNull() // 旧 key 失效
    expect((await authClient(db, newKey))?.id).toBe(oldClient!.id)
  })

  it('凭证错误：错 master_key → 401；无 provision 的 client 代签发 → 403；eternal_id 不构成授权', async () => {
    const { user } = await createUser(db, { email: 'e@example.com', masterKey: 'the-right-key-123' })
    const limiter = new AttemptLimiter()

    await expect(registerClient(db, {
      userEternalId: user.eternal_id, clientType: 'web',
      credential: { type: 'master_key', masterKey: 'wrong-key-123456' },
    }, guard, limiter, '127.0.0.1')).rejects.toMatchObject({ status: 401 })

    // 错误 eternal_id（不存在用户）与错误凭证同语义 401，防枚举
    await expect(registerClient(db, {
      userEternalId: 'f'.repeat(64), clientType: 'web',
      credential: { type: 'master_key', masterKey: 'whatever-123456' },
    }, guard, limiter, '127.0.0.1')).rejects.toMatchObject({ status: 401 })

    // chat-only client（无 provision）不能代签发
    const reg = await registerClient(db, {
      userEternalId: user.eternal_id, clientType: 'web',
      credential: { type: 'master_key', masterKey: 'the-right-key-123' },
    }, guard, new AttemptLimiter(), '127.0.0.1')
    // master_key 签发默认含 provision，此处手动降级模拟 chat-only client
    await db.query(`UPDATE clients SET scopes = '{chat}' WHERE key_hash = $1`, [
      (await import('../../src/util/crypto.js')).sha256Hex(reg.clientKey),
    ])
    const ts = Math.floor(Date.now() / 1000)
    const { hmacHex } = await import('../../src/util/crypto.js')
    await expect(registerClient(db, {
      userEternalId: user.eternal_id, clientType: 'mobile',
      credential: { type: 'client_signature', clientKey: reg.clientKey, timestamp: ts, signature: hmacHex(reg.clientKey, `${user.eternal_id}mobile${ts}`) },
    }, guard, new AttemptLimiter(), '127.0.0.1')).rejects.toMatchObject({ status: 403, code: 'missing_scope' })

    // 不存在的用户不可见（getUserByEternalId null）
    expect(await getUserByEternalId(db, 'a'.repeat(64))).toBeNull()
  })
})
