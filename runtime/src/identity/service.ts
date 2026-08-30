/**
 * §2 Identity Layer —— 第一且强制的门（Identity is Layer 1）。
 * VULN-02 修复：主凭证 = argon2id master_key；client_key 只存哈希；eternal_id 不再构成授权。
 */
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import type { Db } from '../db.js'
import { sha256Hex, hmacHex, timingSafeEq, randomHex } from '../util/crypto.js'
import { validateWebhookUrl, type WebhookGuardOptions } from './webhookGuard.js'

// OWASP 推荐：argon2id m=19MiB t=2 p=1
const ARGON2_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }

export interface UserRow {
  id: string
  eternal_id: string
  display_name: string | null
  email: string | null
  master_key_hash: string
  crisis_silence_until: Date | null
  preferences: Record<string, unknown>
}

export interface ClientRow {
  id: string
  user_id: string
  client_type: string
  key_hash: string
  display_name: string | null
  webhook_url: string | null
  scopes: string[]
  is_active: boolean
  metadata: Record<string, unknown>
}

export class IdentityError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityError'
  }
}

/** `mn_` + 48 字符 CSPRNG（base64url(36B)），明文只在签发时返回一次。 */
export function generateClientKey(): string {
  return `mn_${randomBytes(36).toString('base64url')}`
}

/** eternal_id = sha256(id_salt ‖ email ‖ created_at)，64-hex；盐不出库、不进日志（D-01 消解）。 */
export function deriveEternalId(idSalt: Buffer, email: string, createdAt: Date): string {
  return sha256Hex(Buffer.concat([idSalt, Buffer.from(email, 'utf8'), Buffer.from(createdAt.toISOString(), 'utf8')]))
}

export function isValidEternalSessionId(id: string): boolean {
  return /^sess_[a-f0-9]{64}$/.test(id)
}

function newEternalSessionId(): string {
  return `sess_${randomHex(32)}`
}

/**
 * T1.5：凭证暴力尝试限制（每 eternal_id+IP 10 次/15min）。进程内实现，多实例部署时迁 Redis。
 */
export class AttemptLimiter {
  private map = new Map<string, { count: number; resetAt: number }>()

  allow(key: string, max = 10, windowMs = 900_000): boolean {
    const now = Date.now()
    const entry = this.map.get(key)
    if (!entry || entry.resetAt < now) {
      this.map.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    if (entry.count >= max) return false
    entry.count++
    return true
  }

  reset(key: string): void {
    this.map.delete(key)
  }
}

export async function createUser(
  db: Db,
  input: { email: string; displayName?: string; masterKey: string; preferences?: Record<string, unknown> },
): Promise<{ user: UserRow; eternalId: string }> {
  const idSalt = randomBytes(32)
  const createdAt = new Date()
  const eternalId = deriveEternalId(idSalt, input.email, createdAt)
  const masterKeyHash = await argon2Hash(input.masterKey, ARGON2_OPTS)
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (eternal_id, display_name, email, master_key_hash, id_salt, preferences, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING id, eternal_id, display_name, email, master_key_hash, crisis_silence_until, preferences`,
    [eternalId, input.displayName ?? null, input.email, masterKeyHash, idSalt, JSON.stringify(input.preferences ?? {}), createdAt],
  )
  const user = rows[0]
  if (!user) throw new IdentityError(500, 'insert_failed', 'user insert failed')
  return { user, eternalId: user.eternal_id }
}

export async function getUserByEternalId(db: Db, eternalId: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, eternal_id, display_name, email, master_key_hash, crisis_silence_until, preferences
       FROM users WHERE eternal_id = $1`,
    [eternalId],
  )
  return rows[0] ?? null
}

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, eternal_id, display_name, email, master_key_hash, crisis_silence_until, preferences
       FROM users WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

export async function userCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM users')
  return Number(rows[0]?.n ?? 0)
}

/** 请求认证：X-Client-Key 或 Authorization: Bearer。key 只存 sha256，泄露库不等于泄露钥匙。 */
export async function authClient(db: Db, clientKey: string): Promise<ClientRow | null> {
  const keyHash = sha256Hex(clientKey)
  const { rows } = await db.query<ClientRow>(
    `SELECT id, user_id, client_type, key_hash, display_name, webhook_url, scopes, is_active, metadata
       FROM clients WHERE key_hash = $1`,
    [keyHash],
  )
  const client = rows[0]
  if (!client || !client.is_active) return null
  void db.query('UPDATE clients SET last_seen_at = NOW() WHERE id = $1', [client.id]).catch(() => undefined)
  return client
}

export interface RegisterInput {
  userEternalId: string
  clientType: string
  displayName?: string
  webhookUrl?: string
  credential:
    | { type: 'master_key'; masterKey: string }
    | { type: 'client_signature'; clientKey: string; timestamp: number; signature: string }
}

export interface RegisterResult {
  clientKey: string
  eternalSessionId: string
  clientId: string
}

/**
 * POST /v1/identity/register —— 必须出示用户级凭证；任何路径都不接受仅 eternal_id。
 * 两条路径：master_key（根凭证，建议仅本机/受信网络）；client_signature（受信 client 代签发，需 provision scope）。
 */
export async function registerClient(
  db: Db,
  input: RegisterInput,
  guard: WebhookGuardOptions,
  limiter: AttemptLimiter,
  clientIp: string,
): Promise<RegisterResult> {
  if (!['operit', 'rikkahub', 'telegram', 'web', 'mobile', 'api'].includes(input.clientType)) {
    throw new IdentityError(400, 'bad_client_type', 'unknown client_type')
  }
  const user = await getUserByEternalId(db, input.userEternalId)
  const limiterKey = `${clientIp}:${input.userEternalId}`
  // 统一 401 语义：用户不存在与凭证错误不可区分（防 eternal_id 枚举）
  if (!user) {
    limiter.allow(limiterKey, 1, 900_000) // 一样消耗尝试额度
    throw new IdentityError(401, 'invalid_credential', 'invalid credential')
  }
  if (!limiter.allow(limiterKey, 10, 900_000)) {
    throw new IdentityError(429, 'rate_limited', 'too many attempts')
  }

  if (input.credential.type === 'master_key') {
    const ok = await argon2Verify(user.master_key_hash, input.credential.masterKey).catch(() => false)
    if (!ok) throw new IdentityError(401, 'invalid_credential', 'invalid credential')
  } else {
    // client_signature：要求该 client is_active 且 scopes 含 provision；timestamp 偏差 ≤300s
    const issuer = await authClient(db, input.credential.clientKey)
    if (!issuer) throw new IdentityError(401, 'invalid_credential', 'invalid credential')
    if (!issuer.scopes.includes('provision')) throw new IdentityError(403, 'missing_scope', 'provision scope required')
    const drift = Math.abs(Date.now() / 1000 - input.credential.timestamp)
    if (drift > 300) throw new IdentityError(401, 'stale_timestamp', 'timestamp drift > 300s')
    const expected = hmacHex(
      input.credential.clientKey,
      `${user.eternal_id}${input.clientType}${input.credential.timestamp}`,
    )
    if (!timingSafeEq(expected, input.credential.signature)) {
      throw new IdentityError(401, 'invalid_signature', 'invalid signature')
    }
    // 代签发只能为同一用户签发（防跨用户代持）
    if (issuer.user_id !== user.id) throw new IdentityError(403, 'cross_user', 'issuer does not own this user')
  }

  // webhook_url 入库前必须过 §2.5.1 校验链
  if (input.webhookUrl) {
    const verdict = await validateWebhookUrl(input.webhookUrl, guard)
    if (!verdict.ok) throw new IdentityError(400, 'invalid_webhook', `webhook rejected: ${verdict.reason}`)
  }

  const clientKey = generateClientKey()
  const keyHash = sha256Hex(clientKey)
  // bootstrap 后首批 client 由 master_key 签发，默认含 provision，允许用户在 web 端给手机签发
  const scopes = input.credential.type === 'master_key' ? ['chat', 'provision'] : ['chat']

  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO clients (user_id, client_type, key_hash, display_name, webhook_url, scopes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, '{}')
       RETURNING id`,
      [user.id, input.clientType, keyHash, input.displayName ?? null, input.webhookUrl ?? null, scopes],
    )
    const clientId = rows[0]?.id
    if (!clientId) throw new IdentityError(500, 'insert_failed', 'client insert failed')

    // 注册响应附带一个新会话（§2.4 Response 示例）
    const eternalSessionId = newEternalSessionId()
    await db.query(
      `INSERT INTO sessions (user_id, session_type, eternal_session_id, title)
       VALUES ($1, 'personal', $2, $3)`,
      [user.id, eternalSessionId, `${input.displayName ?? input.clientType} session`],
    )
    limiter.reset(limiterKey)
    return { clientKey, eternalSessionId, clientId }
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new IdentityError(409, 'client_exists', 'client_type already registered for user; use rotate')
    }
    throw e
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === '23505'
}

/** 轮换：旧 key 立即失效（key_hash 覆盖）。clients 表无 updated_at 列（§2.2.2 schema 如此）。 */
export async function rotateClientKey(db: Db, client: ClientRow): Promise<string> {
  const clientKey = generateClientKey()
  await db.query('UPDATE clients SET key_hash = $1 WHERE id = $2', [
    sha256Hex(clientKey),
    client.id,
  ])
  return clientKey
}

export interface ResolveSessionResult {
  sessionId: string
  eternalSessionId: string
  userId: string
  sessionType: string
  contextWindow: number
  isNew: boolean
}

/**
 * POST /v1/identity/session —— Session 归属校验（消解 D-02）：
 * 若 session 不属于当前认证 user → 403，而非创建或静默挂靠。
 * "find active by type" 只在本用户的 session 集合内查找。
 */
export async function resolveSession(
  db: Db,
  user: UserRow,
  input: { eternalSessionId?: string; sessionType?: string },
): Promise<ResolveSessionResult> {
  if (input.eternalSessionId) {
    if (!isValidEternalSessionId(input.eternalSessionId)) {
      throw new IdentityError(400, 'bad_session_id', 'eternal_session_id must match ^sess_[a-f0-9]{64}$')
    }
    const { rows } = await db.query<{ id: string; user_id: string; session_type: string; context_window: number }>(
      `SELECT id, user_id, session_type, context_window FROM sessions WHERE eternal_session_id = $1`,
      [input.eternalSessionId],
    )
    const existing = rows[0]
    if (existing) {
      if (existing.user_id !== user.id) throw new IdentityError(403, 'session_forbidden', 'session belongs to another user')
      await db.query('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [existing.id])
      return {
        sessionId: existing.id,
        eternalSessionId: input.eternalSessionId,
        userId: user.id,
        sessionType: existing.session_type,
        contextWindow: existing.context_window,
        isNew: false,
      }
    }
    // 不存在 → 以客户端提供的 ID 建档（绑定当前 user；后续归属校验照常生效）
    const { rows: created } = await db.query<{ id: string; session_type: string; context_window: number }>(
      `INSERT INTO sessions (user_id, session_type, eternal_session_id)
       VALUES ($1, $2, $3) RETURNING id, session_type, context_window`,
      [user.id, input.sessionType ?? 'personal', input.eternalSessionId],
    )
    const s = created[0]
    if (!s) throw new IdentityError(500, 'insert_failed', 'session insert failed')
    return {
      sessionId: s.id,
      eternalSessionId: input.eternalSessionId,
      userId: user.id,
      sessionType: s.session_type,
      contextWindow: s.context_window,
      isNew: true,
    }
  }

  // 未提供 ID：找本用户当前 active 的同类型会话；没有则新建（CSPRNG 32B hex）
  const type = input.sessionType ?? 'personal'
  const { rows } = await db.query<{ id: string; eternal_session_id: string; session_type: string; context_window: number }>(
    `SELECT id, eternal_session_id, session_type, context_window
       FROM sessions
      WHERE user_id = $1 AND session_type = $2 AND is_active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1`,
    [user.id, type],
  )
  const found = rows[0]
  if (found) {
    await db.query('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [found.id])
    return {
      sessionId: found.id,
      eternalSessionId: found.eternal_session_id,
      userId: user.id,
      sessionType: found.session_type,
      contextWindow: found.context_window,
      isNew: false,
    }
  }
  const eternalSessionId = newEternalSessionId()
  const { rows: created } = await db.query<{ id: string; context_window: number }>(
    `INSERT INTO sessions (user_id, session_type, eternal_session_id)
     VALUES ($1, $2, $3) RETURNING id, context_window`,
    [user.id, type, eternalSessionId],
  )
  const s = created[0]
  if (!s) throw new IdentityError(500, 'insert_failed', 'session insert failed')
  return {
    sessionId: s.id,
    eternalSessionId,
    userId: user.id,
    sessionType: type,
    contextWindow: s.context_window,
    isNew: true,
  }
}
