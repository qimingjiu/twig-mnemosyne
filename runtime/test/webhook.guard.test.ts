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

  it('IPv6 hex 变体：映射/NAT64 的非点分写法同样拦截（expandV6 解析加固）', () => {
    // ::ffff:10.0.0.1 的 hex 形式——getaddrinfo 在部分平台输出这种形态
    expect(isBlockedIp('::ffff:a00:1')).toBe(true)
    expect(isBlockedIp('0:0:0:0:0:ffff:10.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:0a00:0001')).toBe(true)
    // hex 映射的公网地址照常放行
    expect(isBlockedIp('::ffff:808:808')).toBe(false) // 8.8.8.8
    // NAT64/DNS64 合成地址（64:ff9b::/96）内嵌 IPv4 也要过封锁清单
    expect(isBlockedIp('64:ff9b::a00:1')).toBe(true)
    expect(isBlockedIp('64:ff9b::8.8.8.8')).toBe(false)
    // 解析不了的输入维持不拦（不因加固把合法端点全拒了）
    expect(isBlockedIp('not-an-ip')).toBe(false)
  })

  it('scheme 白名单：仅 https（http 需显式 ALLOW_INSECURE_WEBHOOK 或白名单信任）', async () => {
    const opts = { allowInsecure: false, allowlist: [] }
    expect((await validateWebhookUrl('ftp://example.com/x', opts)).ok).toBe(false)
    const httpVerdict = await validateWebhookUrl('http://example.com/x', opts)
    expect(httpVerdict).toMatchObject({ ok: false, reason: 'scheme_not_allowed' })
  })

  it('白名单豁免 scheme：内部 http 端点（mnemosyne.zeabur.internal 出站）可不带 ALLOW_INSECURE', async () => {
    // localhost 本机可解析（内部域名在 CI 上解析不了）；allowlist 同时豁免 scheme 与内网段检查
    const opts = { allowInsecure: false, allowlist: ['localhost'] }
    expect(await validateWebhookUrl('http://localhost:8000/internal/outbound/telegram', opts))
      .toMatchObject({ ok: true, host: 'localhost' })
    // 白名单外的 http 仍拒绝（scheme 先拦；放开 insecure 后也过不了 allowlist 这关）
    const outside = { allowInsecure: false, allowlist: ['localhost'] }
    expect(await validateWebhookUrl('http://evil.example.com/x', outside)).toMatchObject({ ok: false, reason: 'scheme_not_allowed' })
    expect(await validateWebhookUrl('http://evil.example.com/x', { allowInsecure: true, allowlist: ['localhost'] }))
      .toMatchObject({ ok: false, reason: 'host_not_in_allowlist' })
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
      // error 文案带主机前缀（多 client 投递时区分是谁败的）
      expect(result.ok).toBe(false)
      expect(result.error).toContain('host_resolves_to_private_range')
    } finally {
      server.close()
    }
  })

  it('E2E：webhook 返回 5xx → 不得静默当成功（投递状态必须如实）', async () => {
    const server: Server = createServer((req, res) => { res.statusCode = 500; res.end('boom') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const db = { query: async () => ({ rows: [{ webhook_url: `http://127.0.0.1:${port}/hook` }] }) } as unknown as Db
      const result = await deliverOutreach(db, { allowInsecure: true, allowlist: ['127.0.0.1'] }, 'u1', 'hi', 'k3')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('delivery_http_500')
    } finally {
      server.close()
    }
  })

  it('多 client 投递：首个失败不阻断后续 client', async () => {
    const bad: Server = createServer((req, res) => { res.destroy() })
    const flaky: Server = createServer((req, res) => { res.statusCode = 503; res.end('no') })
    await new Promise<void>(resolve => bad.listen(0, '127.0.0.1', resolve))
    await new Promise<void>(resolve => flaky.listen(0, '127.0.0.1', resolve))
    const badPort = (bad.address() as { port: number }).port
    const flakyPort = (flaky.address() as { port: number }).port
    try {
      const db = {
        query: async () => ({ rows: [
          { webhook_url: `http://127.0.0.1:${badPort}/hook` },     // 连接被掐断
          { webhook_url: `http://127.0.0.1:${flakyPort}/hook` },  // HTTP 503（也要如实计失败）
        ] }),
      } as unknown as Db
      const result = await deliverOutreach(db, { allowInsecure: true, allowlist: ['127.0.0.1'] }, 'u1', 'hi', 'k4')
      expect(result.ok).toBe(false) // 有失败 → 整体不算送达（留待重试）
      expect(result.error).toContain(`http://127.0.0.1:${badPort}/hook`)
      expect(result.error).toContain(`http://127.0.0.1:${flakyPort}/hook`) // 首个失败后第二个仍被尝试
      expect(result.error).toContain('delivery_http_503')
    } finally {
      bad.close(); flaky.close()
    }
  })
})
