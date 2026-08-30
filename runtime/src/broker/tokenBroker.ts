/**
 * §5.3 Token Broker（VULN-08 修复）：凭证不解散，集中收敛到 Runtime 内部。
 * - gateway 永不接触 DB、ENCRYPTION_KEY、长期 refresh token；
 * - 端点只监听 docker 内网（compose 不发布端口），X-Broker-Token 经 env 注入两侧；
 * - 每次取件写审计（§5.3：供 Dashboard 展示「哪个工具动用了哪个身份」）。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Pool } from 'pg'
import { env } from '../config.js'
import { Box } from '../util/crypto.js'

const BodySchema = z.object({
  user_id: z.string().uuid(),
  provider: z.string().min(1),
  scopes: z.array(z.string()).default([]),
})

interface TokenRow {
  access_token_enc: string
  scopes: string[]
  expires_at: Date | null
}

export function registerBrokerRoute(app: FastifyInstance, deps: { db: Pool; box: Box }): void {
  app.post('/internal/broker/token', async (req, reply) => {
    const headerToken = req.headers['x-broker-token']
    if (typeof headerToken !== 'string' || headerToken !== env.BROKER_INTERNAL_TOKEN) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const parsed = BodySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.message })
    const { user_id, provider, scopes } = parsed.data

    const { rows } = await deps.db.query<TokenRow>(
      `SELECT access_token_enc, scopes, expires_at FROM oauth_tokens WHERE user_id = $1 AND provider = $2`,
      [user_id, provider],
    )
    const row = rows[0]
    if (!row) {
      await deps.db.query(
        'INSERT INTO broker_audit (user_id, provider, scopes, outcome) VALUES ($1, $2, $3, $4)',
        [user_id, provider, scopes, 'not_found'],
      )
      return reply.code(404).send({ error: 'no_token' })
    }
    // scopes ⊆ 用户授权时的 scopes（防越权取件）
    if (!scopes.every(s => row.scopes.includes(s))) {
      await deps.db.query(
        'INSERT INTO broker_audit (user_id, provider, scopes, outcome) VALUES ($1, $2, $3, $4)',
        [user_id, provider, scopes, 'scope_denied'],
      )
      return reply.code(403).send({ error: 'scope_denied' })
    }
    const accessToken = deps.box.decrypt(row.access_token_enc)
    await deps.db.query(
      'INSERT INTO broker_audit (user_id, provider, scopes, outcome) VALUES ($1, $2, $3, $4)',
      [user_id, provider, scopes, 'issued'],
    )
    const expiresIn = row.expires_at ? Math.max(0, Math.floor((row.expires_at.getTime() - Date.now()) / 1000)) : 300
    return { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn }
    // 5 分钟短票模式（access_token 换短期票据）deferred：当前 gateway 容器同处内网且调用方审计在册
  })
}
