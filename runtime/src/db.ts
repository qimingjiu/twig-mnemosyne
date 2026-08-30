import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from './config.js'

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL })

export type Db = pg.Pool | pg.PoolClient

/** 按文件名序应用 runtime/migrations/*.sql，schema_migrations 记账，幂等。 */
export async function migrate(): Promise<string[]> {
  const applied: string[] = []
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT NOW()
     )`
  )
  const dir = env.MIGRATIONS_DIR
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  for (const file of files) {
    const known = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
    if (known.rowCount && known.rowCount > 0) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      applied.push(file)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
  return applied
}
