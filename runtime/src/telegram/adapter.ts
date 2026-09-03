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
import { handleChatCompletion, type Attachment, type ChatDeps } from '../chat/pipeline.js'
import { isCrisis, DEFAULT_CRISIS_RESOURCES } from '../crisis/lexicon.js'

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

/**
 * §5.5 音乐附件落 TG：优先 sendAudio（TG 的可播放音乐卡片，直传 play_url），
 * 失败降级带链接预览的页面URL消息（least-formidable fallback：网易云卡片仍能预览）。
 */
export async function sendMusicAttachment(token: string, chatId: number, att: Attachment): Promise<void> {
  const caption = `🎵 ${att.title}${att.artist ? ` · ${att.artist}` : ''}\n${att.page_url}`
  try {
    await tgCall(token, 'sendAudio', { chat_id: chatId, audio: att.play_url, title: att.title, performer: att.artist, caption })
  } catch (e) {
    console.error('[telegram] sendAudio failed, falling back to link preview:', e instanceof Error ? e.message : e)
    await tgCall(token, 'sendMessage', { chat_id: chatId, text: caption, disable_web_page_preview: false })
  }
}

/**
 * §21 TTS 音频落 TG：即焚键取回（pipeline 已合成、Redis TTL 60s）→ sendAudio 直传字节。
 * 用 sendAudio（mp3 可播）而非 sendVoice：语音气泡硬性要求 ogg/opus，无 ffmpeg 不转码。
 * 即焚语义（T11.1）：取走即删，TTL 是兜底不是依赖。
 */
export async function sendTtsAudio(token: string, chatId: number, buf: Buffer, mime: string): Promise<void> {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('audio', new Blob([buf], { type: mime || 'audio/mpeg' }), 'reply.mp3')
  const res = await fetch(API(token, 'sendAudio'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  })
  const data = (await res.json()) as { ok: boolean; description?: string }
  if (!data.ok) throw new Error(`telegram sendAudio(tts): ${data.description ?? res.status}`)
}

interface TgDeps extends ChatDeps {
  botToken: string
}

async function findTgClient(db: Pool, chatId: number): Promise<ClientRow | null> {
  // 两个坑都已实弹踩过：jsonb `?` 只匹配字符串元素；子查询别名若叫 id 会与 clients.id(uuid)
  // 撞名导致参数被推断成 uuid。用显式别名 e(e) + ::text 比较。
  const { rows } = await db.query<ClientRow>(
    `SELECT id, user_id, client_type, key_hash, display_name, webhook_url, scopes, is_active, metadata
       FROM clients
      WHERE client_type = 'telegram' AND is_active = TRUE
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'chat_ids', '[]'::jsonb)) AS e(e)
           WHERE e.e::text = $1
        )`,
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

  // §1.2 幂等去重：滚动部署双 pod 同时轮询同一 token 时，防止同一条 update 被两个实例各处理一次
  const dedupKey = `tg:processed:${update.update_id}`
  const deduped = await deps.redis.set(dedupKey, '1', 'EX', 120, 'NX')
  if (!deduped) {
    console.log(`[telegram] dedup skip update_id=${update.update_id}`)
    return
  }

  const chatId = msg.chat.id
  const client = await findTgClient(deps.db, chatId)
  if (!client) {
    // 未绑定：不回复陌生私聊（防抢占），由运维脚本显式绑定 chat_id
    console.log(`[telegram] unbound chat_id=${chatId} ignored`)
    return
  }
  const user = await getUserById(deps.db, client.user_id)
  if (!user) return

  // 生命体征（体感慢的特效药）：TG 非流式，生成期间零反馈最像「挂了」——
  // 每 4s 续一次 typing，超过 25s 发一次「还在想」心跳；回复发送前全部撤下
  const typing = setInterval(() => {
    void tgCall(deps.botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 10_000).catch(() => undefined)
  }, 4_000)
  void tgCall(deps.botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 10_000).catch(() => undefined)
  const stillThinking = setTimeout(() => {
    void sendTelegram(deps.botToken, chatId, '还在想……').catch(() => undefined)
  }, 25_000)

  let outcome
  try {
    outcome = await handleChatCompletion(deps, {
      client,
      user,
      messages: [{ role: 'user', content: msg.text }],
      eternalSessionId: undefined, // 无 ID → 沿用该用户当前 active personal 会话（跨客户端连续身份）
    })
  } catch (e) {
    console.error('[telegram] chat pipeline failed:', e instanceof Error ? e.message : e)
    // 全链失败时的沉默对危机消息是最坏响应：静态兜底（零模型依赖，必达）
    if (isCrisis(msg.text)) {
      await sendTelegram(deps.botToken, chatId, DEFAULT_CRISIS_RESOURCES)
    }
    return
  } finally {
    clearInterval(typing)
    clearTimeout(stillThinking)
  }
  const payload = outcome.payload as {
    choices?: { message?: { content?: string } }[]
    mnemosyne?: { route_reason?: string }
    attachments?: Attachment[]
    audio?: { data?: string; mime?: string }
  }
  const reply = payload.choices?.[0]?.message?.content ?? '（我这边的回复出了点问题，稍后再试一次？）'
  await sendTelegram(deps.botToken, chatId, reply)
  // TTS 音频（§21）：即焚键取回直发；失败不吞文本回复
  if (payload.audio?.data) {
    try {
      const raw = await deps.redis.get(payload.audio.data)
      if (raw) {
        const { mime, base64 } = JSON.parse(raw) as { mime: string; base64: string }
        await sendTtsAudio(deps.botToken, chatId, Buffer.from(base64, 'base64'), mime)
        await deps.redis.del(payload.audio.data).catch(() => {})
      }
    } catch (e) {
      console.error('[telegram] tts sendAudio failed:', e instanceof Error ? e.message : e)
    }
  }
  // 附件单独走（§5.5）；音乐卡片 Ty 要单独的 sendAudio 或链卡，混在文本里发没意义
  for (const att of payload.attachments ?? []) {
    if (att.kind === 'music') await sendMusicAttachment(deps.botToken, chatId, att)
  }
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
    // 重启跳过积压：offset=-1 取最后一条，从其后开始消费——不跳的话滚动部署会把
    // 宕机期间的整段对话回放一遍，bot 对迟到消息逐条补发（鸦巢实战坑）
    try {
      const backlog = await tgCall<TgUpdate[]>(token, 'getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] }, 15_000)
      const last = backlog[backlog.length - 1]
      if (last) offset = last.update_id + 1
    } catch (e) {
      console.warn('[telegram] backlog skip failed, consuming from 0:', e instanceof Error ? e.message : e)
    }
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
