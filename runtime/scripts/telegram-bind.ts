/**
 * Telegram client 绑定 CLI：把一个 chat_id 绑到「杳晦」名下的 telegram client 上。
 *
 * 用法（mnemosyne 容器内）：
 *   node dist/scripts/telegram-bind.js --chat-id <数字id>
 *
 * chat_id 获取：先给 bot 发一条消息，然后在容器里查
 *   https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates
 * 或直接看 mnemosyne 日志里的 `[telegram] unbound chat_id=... ignored`。
 *
 * 说明：client 的 webhook_url 指向本 runtime 的内部出站端点（Huginn → TG 投递出口），
 * 属运维布线，不经 §2.5.1 用户输入校验链（该链守的是用户提供的 URL）。
 */
import { parseArgs } from 'node:util'
import { pool, migrate } from '../src/db.js'
import { env } from '../src/config.js'
import { getUserByEternalId, userCount } from '../src/identity/service.js'
import { sha256Hex } from '../src/util/crypto.js'

const INTERNAL_WEBHOOK = 'http://mnemosyne.zeabur.internal:8000/internal/outbound/telegram'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'chat-id': { type: 'string' }, 'client-key': { type: 'string' } } })
  if (!values['chat-id'] || !/^-?\d+$/.test(values['chat-id'])) {
    console.error('usage: node dist/scripts/telegram-bind.js --chat-id <数字id> [--client-key mn_...]')
    process.exit(2)
  }
  await migrate()

  // 定位 user：有 client_key 用之；否则单用户运行时取唯一用户
  let userId: string | undefined
  if (values['client-key']) {
    const { rows } = await pool.query<{ user_id: string }>('SELECT user_id FROM clients WHERE key_hash = $1', [
      sha256Hex(values['client-key']),
    ])
    userId = rows[0]?.user_id
  } else if ((await userCount(pool)) === 1) {
    const { rows } = await pool.query<{ eternal_id: string }>('SELECT eternal_id FROM users LIMIT 1')
    const u = rows[0] ? await getUserByEternalId(pool, rows[0].eternal_id) : undefined
    userId = u?.id
  }
  if (!userId) {
    console.error('无法定位用户：传 --client-key 或确认库里只有一个用户')
    process.exit(3)
  }

  const chatId = values['chat-id']
  // upsert：同 user 的 telegram client 已存在 → 追加 chat_id；否则建号
  const { rows: existing } = await pool.query<{ id: string; metadata: { chat_ids?: number[] } }>(
    `SELECT id, metadata FROM clients WHERE user_id = $1 AND client_type = 'telegram'`,
    [userId],
  )
  if (existing[0]) {
    const ids = Array.from(new Set([...(existing[0].metadata?.chat_ids ?? []), String(chatId)]))
    await pool.query(
      `UPDATE clients SET metadata = jsonb_set(metadata, '{chat_ids}', $2::jsonb), webhook_url = $3 WHERE id = $1`,
      [existing[0].id, JSON.stringify(ids), INTERNAL_WEBHOOK],
    )
  } else {
    const key = `mn_${Buffer.from(`${Date.now()}`).toString('base64url')}${Math.random().toString(36).slice(2, 14)}`
    await pool.query(
      `INSERT INTO clients (user_id, client_type, key_hash, display_name, webhook_url, scopes, metadata)
       VALUES ($1, 'telegram', $2, 'Telegram bot', $3, '{chat}', $4::jsonb)`,
      [userId, sha256Hex(key), INTERNAL_WEBHOOK, JSON.stringify({ chat_ids: [String(chatId)] })],
    )
    console.log(`client_key（仅此一次）: ${key}`)
  }
  console.log(`telegram 绑定完成：user=${userId.slice(0, 8)}… chat_id=${chatId} webhook=${INTERNAL_WEBHOOK}`)
  await pool.end()
}

void env
main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
