/**
 * bootstrap CLI —— §2.4 首次 bootstrap：第一个用户由部署 CLI 创建，
 * 同时设置 master_key。BOOTSTRAP_TOKEN 仅在无用户时生效一次。
 *
 * 用法：
 *   BOOTSTRAP_TOKEN=... npm run bootstrap -- --email you@example.com --name 杳晦 --master-key <口令>
 */
import { parseArgs } from 'node:util'
import { migrate, pool } from '../src/db.js'
import { env } from '../src/config.js'
import { createUser, userCount, generateClientKey } from '../src/identity/service.js'
import { sha256Hex } from '../src/util/crypto.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'master-key': { type: 'string' },
      token: { type: 'string' },
    },
  })
  if (!values.email || !values['master-key']) {
    console.error('usage: npm run bootstrap -- --email <email> --name <display> --master-key <口令> [--token <BOOTSTRAP_TOKEN>]')
    process.exit(2)
  }
  if (env.BOOTSTRAP_TOKEN.length === 0 || values.token !== env.BOOTSTRAP_TOKEN) {
    console.error('BOOTSTRAP_TOKEN mismatch (env vs --token)；首个用户创建被拒绝')
    process.exit(3)
  }

  await migrate()
  if ((await userCount(pool)) > 0) {
    console.error('用户已存在：bootstrap 仅在无用户时生效一次')
    process.exit(4)
  }

  const { user, eternalId } = await createUser(pool, {
    email: values.email,
    displayName: values.name,
    masterKey: values['master-key'],
  })

  // 同时签发第一个 web client（含 provision scope，供后续 client_signature 代签发）
  const clientKey = generateClientKey()
  await pool.query(
    `INSERT INTO clients (user_id, client_type, key_hash, display_name, scopes)
     VALUES ($1, 'web', $2, 'bootstrap web', '{chat,provision}')`,
    [user.id, sha256Hex(clientKey)],
  )

  console.log('bootstrap 完成：')
  console.log(`  eternal_id     : ${eternalId}（半秘密标识，不进日志；twig userId 即此值）`)
  console.log(`  client_key     : ${clientKey}（仅此一次显示；sha256 已入库）`)
  console.log('  master_key     : 已设置（argon2id）——后续签发新 client 的根凭证')
  await pool.end()
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
