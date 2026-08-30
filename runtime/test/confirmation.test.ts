import { describe, it, expect } from 'vitest'
import { issueTicket, verifyTicket, argsHashOf } from '../src/router/confirmation.js'

const SECRET = 'test-confirm-secret'
const tool = 'mail.send_mail'
const args = { to: 'user@example.com', subject: 'hi' }

describe('§4.6 敏感操作确认协议（VULN-07 / T8.9）', () => {
  it('正常签发与验证', () => {
    const ticket = issueTicket({ sid: 'sess-1', tool, args }, SECRET)
    const verdict = verifyTicket(ticket, { sid: 'sess-1', tool, args }, SECRET)
    expect(verdict.ok).toBe(true)
  })

  it('T8.9a：篡改参数后重放 → 验签失败不执行', () => {
    const ticket = issueTicket({ sid: 'sess-1', tool, args }, SECRET)
    const verdict = verifyTicket(ticket, { sid: 'sess-1', tool, args: { ...args, to: 'attacker@evil.com' } }, SECRET)
    expect(verdict).toMatchObject({ ok: false, reason: 'args_changed' })
  })

  it('T8.9b：跨 session 重放 → session_mismatch', () => {
    const ticket = issueTicket({ sid: 'sess-1', tool, args }, SECRET)
    expect(verifyTicket(ticket, { sid: 'sess-2', tool, args }, SECRET)).toMatchObject({ ok: false, reason: 'session_mismatch' })
  })

  it('T8.9c：跨工具重放 → tool_mismatch', () => {
    const ticket = issueTicket({ sid: 'sess-1', tool, args }, SECRET)
    expect(verifyTicket(ticket, { sid: 'sess-1', tool: 'calendar.create_event', args }, SECRET)).toMatchObject({ ok: false, reason: 'tool_mismatch' })
  })

  it('5 分钟过期（§4.6）', () => {
    const ticket = issueTicket({ sid: 'sess-1', tool, args }, SECRET, -1)
    expect(verifyTicket(ticket, { sid: 'sess-1', tool, args }, SECRET)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('伪造票据（错误密钥）→ bad_signature', () => {
    const ticket = issueTicket({ sid: 'sess-1', tool, args }, 'other-secret')
    expect(verifyTicket(ticket, { sid: 'sess-1', tool, args }, SECRET)).toMatchObject({ ok: false, reason: 'bad_signature' })
  })

  it('argsHash 键序稳定（stableStringify）', () => {
    expect(argsHashOf({ a: 1, b: 2 })).toBe(argsHashOf({ b: 2, a: 1 }))
  })
})
