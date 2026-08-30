/**
 * §4.6 敏感操作确认协议（VULN-07 修复）。
 * 确认作为合成 tool 结果返回，确认令牌跨轮携带，协议层面零扩展。
 * 票据绑定 session + tool + 参数哈希，5 分钟过期，一次性（一次性由调用方在执行后删除待决记录保证）。
 * 确认判定在 Runtime 代码层，不信任模型自述「用户已同意」。
 */
import { sha256Hex, hmacHex, timingSafeEq, base64url, stableStringify } from '../util/crypto.js'

export interface TicketPayload {
  sid: string
  tool: string
  argsHash: string
  exp: number
}

const DEFAULT_TTL_MS = 300_000

export function argsHashOf(args: unknown): string {
  return sha256Hex(stableStringify(args))
}

export function issueTicket(input: { sid: string; tool: string; args: unknown }, secret: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload: TicketPayload = {
    sid: input.sid,
    tool: input.tool,
    argsHash: argsHashOf(input.args),
    exp: Date.now() + ttlMs,
  }
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = hmacHex(secret, body)
  return `${body}.${sig}`
}

export type VerifyResult = { ok: true; payload: TicketPayload } | { ok: false; reason: string }

export function verifyTicket(
  ticket: string,
  input: { sid: string; tool: string; args: unknown },
  secret: string,
): VerifyResult {
  const dot = ticket.lastIndexOf('.')
  if (dot <= 0) return { ok: false, reason: 'malformed' }
  const body = ticket.slice(0, dot)
  const sig = ticket.slice(dot + 1)
  if (!timingSafeEq(sig, hmacHex(secret, body))) return { ok: false, reason: 'bad_signature' }
  let payload: TicketPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (payload.sid !== input.sid) return { ok: false, reason: 'session_mismatch' }
  if (payload.tool !== input.tool) return { ok: false, reason: 'tool_mismatch' }
  if (payload.argsHash !== argsHashOf(input.args)) return { ok: false, reason: 'args_changed' } // 参数被改动 → 自动作废重签
  if (Date.now() > payload.exp) return { ok: false, reason: 'expired' }
  return { ok: true, payload }
}
