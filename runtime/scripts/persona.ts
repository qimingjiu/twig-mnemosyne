/**
 * persona CLI —— 查看 / 设置 / 清除 用户级人格提示词。
 * builder 读取 users.preferences.persona_prompt（§3.5 稳定 persona 段，2K pin，不可截断）。
 *
 * 用法（mnemosyne 容器内）：
 *   node dist/scripts/persona.js --show
 *   node dist/scripts/persona.js --set-file /tmp/persona.md
 *   node dist/scripts/persona.js --clear
 */
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { pool, migrate } from '../src/db.js'
import { getUserByEternalId, userCount } from '../src/identity/service.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { show: { type: 'boolean', default: false }, 'set-file': { type: 'string' }, clear: { type: 'boolean', default: false } },
  })
  await migrate()
  if ((await userCount(pool)) !== 1) {
    console.error('仅支持单用户运行时；多用户场景请扩展 --eternal-id 参数')
    process.exit(2)
  }
  const { rows } = await pool.query<{ eternal_id: string }>('SELECT eternal_id FROM users LIMIT 1')
  const user = rows[0] ? await getUserByEternalId(pool, rows[0].eternal_id) : undefined
  if (!user) { console.error('no user'); process.exit(3) }

  if (values['set-file']) {
    const text = readFileSync(values['set-file'], 'utf8').trim()
    if (text.length === 0) { console.error('persona 文件为空'); process.exit(4) }
    // §3.2：稳定 persona 段预算 2K tokens pin；超了会挤占近期对话余额（promptText 永远 pin，先挤的是历史）
    const approxTokens = Math.ceil([...text].length * 0.6)
    if (approxTokens > 2048) console.warn(`⚠ persona 约 ${approxTokens} tokens，超出 2K pin 预算，将挤压近期对话余额（建议精简）`)
    await pool.query(
      `UPDATE users SET preferences = preferences || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [user.id, JSON.stringify({ persona_prompt: text })],
    )
    console.log(`persona 已设置（${text.length} 字符，约 ${approxTokens} tokens）。下一轮对话生效。`)
  } else if (values.clear) {
    await pool.query(
      `UPDATE users SET preferences = preferences - 'persona_prompt', updated_at = NOW() WHERE id = $1`,
      [user.id],
    )
    console.log('persona 已清除，回到内置默认人格。')
  } else {
    // --show（默认）
    const current = (user.preferences as { persona_prompt?: string })?.persona_prompt
    console.log('=== 当前生效 persona ===')
    console.log(current ?? '（未设置，使用内置默认——src/context/builder.ts 的 DEFAULT_PERSONA）')
  }
  await pool.end()
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
