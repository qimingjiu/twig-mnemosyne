import { describe, it, expect } from 'vitest'
import { isBlockedIp, validateWebhookUrl } from '../src/identity/webhookGuard.js'

describe('§2.5.1 Webhook 校验链（VULN-13 / T8.5 SSRF）', () => {
  it('IPv4 私网/环回/云元数据全拦截', () => {
    expect(isBlockedIp('10.1.2.3')).toBe(true)
    expect(isBlockedIp('172.16.0.1')).toBe(true)
    expect(isBlockedIp('172.31.255.255')).toBe(true)
    expect(isBlockedIp('192.168.1.1')).toBe(true)
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('169.254.169.254')).toBe(true) // 云元数据
    expect(isBlockedIp('0.0.0.0')).toBe(true)
  })

  it('公网 IPv4 放行', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('172.32.0.1')).toBe(false) // 172.16/12 之外
    expect(isBlockedIp('169.255.0.1')).toBe(false)
  })

  it('IPv6：环回/链路本地/ULA/映射地址拦截', () => {
    expect(isBlockedIp('::1')).toBe(true)
    expect(isBlockedIp('::')).toBe(true)
    expect(isBlockedIp('fe80::1')).toBe(true)
    expect(isBlockedIp('fc00::1')).toBe(true)
    expect(isBlockedIp('fd12:3456::1')).toBe(true)
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false)
    expect(isBlockedIp('2001:db8::1')).toBe(false)
  })

  it('scheme 白名单：仅 https（http 需显式 ALLOW_INSECURE_WEBHOOK）', async () => {
    const opts = { allowInsecure: false, allowlist: [] }
    expect((await validateWebhookUrl('ftp://example.com/x', opts)).ok).toBe(false)
    const httpVerdict = await validateWebhookUrl('http://example.com/x', opts)
    expect(httpVerdict).toMatchObject({ ok: false, reason: 'scheme_not_allowed' })
  })

  it('T8.5：http 内网探测被拒绝（scheme 或私网解析，双层防御）', async () => {
    const opts = { allowInsecure: false, allowlist: [] }
    const v = await validateWebhookUrl('http://127.0.0.1:5432', opts)
    expect(v.ok).toBe(false)
  })

  it('allowInsecure 放行 http，但私网解析仍拦截', async () => {
    const opts = { allowInsecure: true, allowlist: [] }
    const v = await validateWebhookUrl('http://127.0.0.1:5432', opts)
    expect(v).toMatchObject({ ok: false, reason: 'host_resolves_to_private_range' })
  })

  it('可选白名单：配置后仅允许列内主机', async () => {
    const opts = { allowInsecure: false, allowlist: ['api.telegram.org'] }
    expect(await validateWebhookUrl('https://evil.example.com/x', opts)).toMatchObject({ ok: false, reason: 'host_not_in_allowlist' })
  })

  it('白名单即信任声明：列内主机豁免内网段检查（LAN/本机联调）', async () => {
    const opts = { allowInsecure: true, allowlist: ['127.0.0.1'] }
    expect(await validateWebhookUrl('http://127.0.0.1:8085/hook', opts)).toMatchObject({ ok: true, host: '127.0.0.1' })
    // 非白名单下的内网地址仍然拦截
    expect(await validateWebhookUrl('http://127.0.0.1:8085/hook', { allowInsecure: true, allowlist: [] }))
      .toMatchObject({ ok: false, reason: 'host_resolves_to_private_range' })
  })

  it('非法 URL 直接拒绝', async () => {
    expect((await validateWebhookUrl('not a url', { allowInsecure: false, allowlist: [] })).ok).toBe(false)
  })
})
