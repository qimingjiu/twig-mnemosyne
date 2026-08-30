/**
 * §21 语音管线出站侧：传输层适配器，不改变记忆/路由/缓存语义。
 * - §21.6 触发决策（v0.3.1 PATCH-06：独立情绪分类器，阈值 30，与隐私评分解耦）
 * - §21.5 硬截断兜底（语义边界，非字符硬切）
 * - §21.8 安全：产物不持久化，Redis TTL 60s 即焚，不进任何缓存层
 */
import type { Redis } from 'ioredis'
import { emotionScore } from './emotion.js'

export interface TtsDecisionContext {
  crisis: boolean
  alwaysTTS: boolean
  /** 同 session 近 3 条里已 TTS 的条数（was_tts，conversation_messages 落库） */
  recentTtsCount: number
}

export function shouldTTS(assistantContent: string, ctx: TtsDecisionContext): boolean {
  // 危机路径：100% TTS，预算不限制（长度限制同步解除，见 ttsSanitize）
  if (ctx.crisis) return true
  // 用户显式要求语音
  if (ctx.alwaysTTS) return true
  // 情感浓度：独立 emotionClassifier，阈值 30（"明天天气怎样" → 文字就够了）
  if (emotionScore(assistantContent) < 30) return false
  // 频次上限：同 session 连续 3 条 TTS 后，第 4 条强制文字（防疲劳）
  if (ctx.recentTtsCount >= 3) return false
  return true
}

/** 语义截断：在 ≤maxChars 内找最后一个句末标点；找不到才退化为位置截断。 */
export function semanticTruncate(text: string, maxChars = 35): string {
  const chars = [...text]
  let visible = 0
  let limitIdx = chars.length
  for (let i = 0; i < chars.length; i++) {
    if (!/\s/.test(chars[i] ?? '')) {
      visible++
      if (visible > maxChars) {
        limitIdx = i
        break
      }
    }
  }
  if (limitIdx >= chars.length) return text
  const window = chars.slice(0, limitIdx)
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf(';'),
    window.lastIndexOf('；'),
  )
  if (boundary > 0) return window.slice(0, boundary + 1).join('')
  return window.join('')
}

const DIGITS: Record<string, string> = {
  '0': '零', '1': '一', '2': '二', '3': '三', '4': '四',
  '5': '五', '6': '六', '7': '七', '8': '八', '9': '九',
}

export function normalizeVersionStrings(text: string): string {
  // "v0.3.0" → "零点三点零版"；其余独立版本号同样口语化
  return text.replace(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/gi, (_m, a: string, b?: string, c?: string) => {
    const words = [a, b, c].filter(Boolean).map(d => (DIGITS[d ?? ''] ?? d))
    return `${words.join('点')}版`
  })
}

export function arabicToChinese(text: string): string {
  return text.replace(/\d/g, d => DIGITS[d] ?? d)
}

export function ttsSanitize(text: string, opts: { crisis: boolean }): string {
  // 1. 危机路径 bypass：不截断
  if (opts.crisis) return text
  // 2. 长度截断：按语义边界切
  let trimmed = semanticTruncate(text, 35)
  // 3. 符号替换：版本号 → 口语化；剩余阿拉伯数字 → 汉字
  trimmed = normalizeVersionStrings(trimmed)
  trimmed = arabicToChinese(trimmed)
  return trimmed
}

/** §21.3 第一梯队：ElevenLabs（云端优先）；未配置 key/voice 时不合成，静默降级为文字。 */
export async function synthesizeTts(
  text: string,
  opts: { apiKey?: string; voiceId?: string },
): Promise<{ mime: string; base64: string } | null> {
  const apiKey = opts.apiKey
  const voiceId = opts.voiceId
  if (!apiKey || !voiceId) return null
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.75,
        style: 0.45,
        use_speaker_boost: true,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  return { mime: 'audio/mpeg', base64: buf.toString('base64') }
}

/** 不持久化：Redis TTL 60s 即焚（T11.1），键与任何缓存层命名空间隔离。 */
export async function stashAudio(redis: Redis, requestId: string, audio: { mime: string; base64: string }): Promise<string> {
  const key = `tts:onetime:${requestId}`
  await redis.set(key, JSON.stringify(audio), 'EX', 60)
  return key
}
