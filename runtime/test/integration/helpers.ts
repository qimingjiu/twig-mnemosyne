/**
 * 集成测试公共设施。需要真实 Postgres：
 *   TEST_DATABASE_URL=postgresql://... npm run test:integration
 * 未设置 TEST_DATABASE_URL 时全部用例自动跳过（describe.skipIf）。
 */
import { pool, migrate } from '../../src/db.js'

export { pool as db }

export function hasDb(): boolean {
  return (process.env.TEST_DATABASE_URL ?? '').length > 0
}

export async function resetDb(): Promise<void> {
  await migrate()
  await pool.query(`TRUNCATE users, clients, sessions, conversation_messages, usage_logs,
                             oauth_tokens, crisis_audit, broker_audit, outreach CASCADE`)
}
