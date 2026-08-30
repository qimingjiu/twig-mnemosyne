import { describe, it, expect } from 'vitest'
import { deriveEternalId, generateClientKey, isValidEternalSessionId, AttemptLimiter } from '../src/identity/service.js'

describe('§2.2 身份层（VULN-02 修复）', () => {
  it('eternal_id = sha256(id_salt ‖ email ‖ created_at)：64-hex 且确定性', () => {
    const salt = Buffer.alloc(32, 1)
    const at = new Date('2026-08-30T00:00:00.000Z')
    const a = deriveEternalId(salt, 'user@example.com', at)
    const b = deriveEternalId(salt, 'user@example.com', at)
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    // 撞库防线：不同盐/邮箱/时刻产生不同 id（D-01 消解）
    expect(deriveEternalId(Buffer.alloc(32, 2), 'user@example.com', at)).not.toBe(a)
    expect(deriveEternalId(salt, 'other@example.com', at)).not.toBe(a)
  })

  it('client_key 形态：mn_ + 48 字符 CSPRNG', () => {
    const key = generateClientKey()
    expect(key.startsWith('mn_')).toBe(true)
    expect(key.length).toBe(3 + 48)
    expect(generateClientKey()).not.toBe(key)
  })

  it('eternal_session_id 形态：sess_ + 64-hex（CSPRNG 32B）', () => {
    expect(isValidEternalSessionId(`sess_${'a'.repeat(64)}`)).toBe(true)
    expect(isValidEternalSessionId('sess_short')).toBe(false)
    expect(isValidEternalSessionId('sess_' + 'g'.repeat(64))).toBe(false)
  })

  it('T1.5：凭证尝试限制（10 次/15min）', () => {
    const limiter = new AttemptLimiter()
    let allowed = 0
    for (let i = 0; i < 12; i++) if (limiter.allow('ip:user', 10, 900_000)) allowed++
    expect(allowed).toBe(10)
    limiter.reset('ip:user')
    expect(limiter.allow('ip:user', 10, 900_000)).toBe(true)
  })
})
