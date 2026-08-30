/**
 * §1 传输层适配：Telegram 长轮询收信 → chat 管线；出站发送（Huginn 触达出口）。
 *
 * 借鉴鸦巢网关实战坑表（crow-nest-gateway-ops）：
 * - 启动先 deleteWebhook（409 冲突：webhook 与轮询互斥）；
 * - 防自食回声：from.is_bot 一律忽略；
 * - 私聊门禁：chat_id 必须在该 TG client 的 metadata.chat_ids 白名单内（未绑定即忽略）；
 * - 网络异常退避 5s，不放弃轮询（409 侦察兵语义：自我上报到日志）。
 *
 * 身份模型：TG bot = 一个 client_type='telegram' 的 client；私聊用户经 Identity Layer
 * 解析到同一个 user —— 跨客户端连续身份是设计目标（§1.1），TG 与 web/API 共享会话与叙事。
 */
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { env } from '../config.js'
import { getUserById, type ClientRow, type UserRow } from '../identity/service.js'
import { handleChatCompletion, type ChatDeps } from '../chat/pipeline.js'

const API = (token: string, method: string): string => `https://api.telegram.org/bot${token}/${method}`
const TG_CHUNK = 3800

interface TgUpdate {
  update_id: number
  message?: {
    text?: string
    chat: { id: number; type: string }
    from?: { id: number; is_bot: boolean; first_name?: string }
  }
}

async function tgCall<T>(token: string, method: string, body?: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
  const res = await fetch(API(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = (await res.json()) as { ok: boolean; result: T; description?: string }
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`)
  return data.result
}

export async function sendTelegram(token: string, chatId: number, text: string): Promise<void> {
  // TG 上限 4096；按段落优先切块
  const chunks: string[] = []
  let rest = text
  while (rest.length > TG_CHUNK) {
    let cut = rest.lastIndexOf('\n', TG_CHUNK)
    if (cut < TG_CHUNK / 2) cut = TG_CHUNK
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  chunks.push(rest)
  for (const c of chunks) {
    await tgCall(token, 'sendMessage', { chat_id: chatId, text: c, disable_web_page_preview: true })
  }
}

interface TgDeps extends ChatDeps {
  botToken: string
}

async function findTgClient(db: Pool, chatId: number): Promise<ClientRow | null> {
  const { rows } = await db.query<ClientRow>(
    `SELECT id, user_id, client_type, key_hash, display_name, webhook_url, scopes, is_active, metadata
       FROM clients
      WHERE client_type = 'telegram' AND is_active = TRUE
        AND metadata->'chat_ids' ? $1`,
    [String(chatId)],
  )
  return rows[0] ?? null
}

async function handleUpdate(deps: TgDeps, update: TgUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.text) return
  // 防自食回声（鸦巢教训）：bot 自己的消息永不当作用户输入
  if (msg.from?.is_bot) return
  if (msg.chat.type !== 'private') return

  const chatId = msg.chat.id
  const client = await findTgClient(deps.db, chatId)
  if (!client) {
    // 未绑定：不回复陌生私聊（防抢占），由运维脚本显式绑定 chat_id
    console.log(`[telegram] unbound chat_id=${chatId} ignored`)
    return
  }
  const user = await getUserById(deps.db, client.user_id)
  if (!user) return

  const outcome = await handleChatCompletion(deps, {
    client,
    user,
    messages: [{ role: 'user', content: msg.text }],
    eternalSessionId: undefined, // 无 ID → 沿用该用户当前 active personal 会话（跨客户端连续身份）
  })
  const payload = outcome.payload as {
    choices?: { message?: { content?: string } }[]
    mnemosyne?: { route_reason?: string }
  }
  const reply = payload.choices?.[0]?.message?.content ?? '（我这边的回复出了点问题，稍后再试一次？）'
  await sendTelegram(deps.botToken, chatId, reply)
  console.log(`[telegram] replied chat_id=${chatId} route=${payload.mnemosyne?.route_reason ?? '?'}`)
}

export function startTelegramPolling(deps: TgDeps): void {
  const token = deps.botToken || env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN empty — polling disabled')
    return
  }
  console.log('[telegram] polling starting (deleteWebhook first, 防 409)')
  void (async () => {
    try {
      await tgCall(token, 'deleteWebhook', { drop_pending_updates: false }, 15_000)
      const me = await tgCall<{ username?: string }>(token, 'getMe', {}, 15_000)
      console.log(`[telegram] polling as @${me.username ?? 'bot'}`)
    } catch (e) {
      console.error('[telegram] init failed, retry in 15s:', e instanceof Error ? e.message : e)
      await new Promise(r => setTimeout(r, 15_000))
      startTelegramPolling(deps)
      return
    }
    let offset = 0
    for (;;) {
      try {
        const updates = await tgCall<TgUpdate[]>(token, 'getUpdates', {
          offset, timeout: 25, allowed_updates: ['message'],
        })
        for (const u of updates) {
          offset = u.update_id + 1
          try {
            await handleUpdate(deps, u)
          } catch (e) {
            console.error('[telegram] update failed:', e instanceof Error ? e.message : e)
          }
        }
      } catch (e) {
        console.error('[telegram] poll error, backoff 5s:', e instanceof Error ? e.message : e)
        await new Promise(r => setTimeout(r, 5_000))
      }
    }
  })()
}

/** Huginn 出站（OutreachDeliverer 的 webhook 落点）：向绑定的 TG chat 投递触达文案。 */
export async function outboundToTelegram(deps: { db: Pool; botToken: string }, content: string, chatId?: number): Promise<{ sent: number }> {
  const token = deps.botToken || env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN empty')
  let targets: number[] = []
  if (chatId) {
    targets = [chatId]
  } else {
    const { rows } = await deps.db.query<{ metadata: { chat_ids?: number[] } }>(
      `SELECT metadata FROM clients WHERE client_type = 'telegram' AND is_active = TRUE`,
    )
    targets = rows.flatMap(r => r.metadata?.chat_ids ?? [])
  }
  if (targets.length === 0) throw new Error('no bound telegram chats')
  for (const id of targets) {
    await sendTelegram(token, id, content)
  }
  return { sent: targets.length }
}
