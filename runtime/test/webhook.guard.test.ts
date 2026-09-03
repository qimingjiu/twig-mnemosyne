import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { isBlockedIp, validateWebhookUrl, pinnedLookup } from '../src/identity/webhookGuard.js'
import { deliverOutreach } from '../src/outreach/deliver.js'
import type { Db } from '../src/db.js'

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

describe('§2.5.1 R6 钉扎：pinnedLookup + 钉扎 dispatcher 投递', () => {
  // 字面 IP 的 dns.lookup 本地完成，离线可测
  const call = (opts: { allowInsecure: boolean; allowlist: string[] }, hostname: string): Promise<string> =>
    new Promise((resolve, reject) => {
      pinnedLookup(opts)(hostname, { family: 0, all: false }, (err, address) =>
        err ? reject(err) : resolve(address as string),
      )
    })

  it('私网解析在 connect 层拒绝（校验与连接同一次 lookup，TOCTOU 收口）', async () => {
    await expect(call({ allowInsecure: true, allowlist: [] }, '127.0.0.1')).rejects.toThrow('host_resolves_to_private_range')
    await expect(call({ allowInsecure: true, allowlist: [] }, '10.1.2.3')).rejects.toThrow('host_resolves_to_private_range')
  })

  it('公网地址放行并返回钉住的 IP；白名单主机豁免内网检查', async () => {
    expect(await call({ allowInsecure: true, allowlist: [] }, '8.8.8.8')).toBe('8.8.8.8')
    expect(await call({ allowInsecure: true, allowlist: ['127.0.0.1'] }, '127.0.0.1')).toBe('127.0.0.1')
  })

  it('E2E：钉扎 dispatcher 投递到本地 webhook（allowlist 豁免路径）', async () => {
    const server: Server = createServer((req, res) => { res.statusCode = 200; res.end('ok') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const db = { query: async () => ({ rows: [{ webhook_url: `http://127.0.0.1:${port}/hook` }] }) } as unknown as Db
      const result = await deliverOutreach(db, { allowInsecure: true, allowlist: ['127.0.0.1'] }, 'u1', 'hi', 'k1')
      expect(result.ok).toBe(true)
    } finally {
      server.close()
    }
  })

  it('E2E：非白名单主机解析到内网 → 钉扎层拒绝投递', async () => {
    const server: Server = createServer((req, res) => { res.statusCode = 200; res.end('ok') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      // localhost 解析 127.0.0.1/::1，均落内网段且不在 allowlist
      const db = { query: async () => ({ rows: [{ webhook_url: `http://localhost:${(server.address() as { port: number }).port}/hook` }] }) } as unknown as Db
      const result = await deliverOutreach(db, { allowInsecure: true, allowlist: [] }, 'u1', 'hi', 'k2')
      expect(result).toMatchObject({ ok: false, error: 'host_resolves_to_private_range' })
    } finally {
      server.close()
    }
  })
})
