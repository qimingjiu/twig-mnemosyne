/**
 * §2.5.1 Webhook URL 校验链（VULN-13 修复）
 *
 * 入库时与每次投递时各过一次；投递时重新解析 DNS（防 rebinding：入库合法、TTL 过期后改指内网）。
 *
 * 2026-09-03 债务 #6 收口（原 TODO rebinding-hardening）：pinnedLookup 把「解析 → 校验 → 连接」
 * 收敛进同一次 lookup，投递经 undici Agent 使用它连接——validateWebhookUrl 与实际 fetch 之间
 * 的 TOCTOU 窗口消除。TLS 证书仍按原 hostname 校验（连接钉到已校验 IP，SNI 不变）。
 */
import { promises as dns } from 'node:dns'
import type { LookupFunction } from 'node:net'

interface V4Range {
  lo: number
  hi: number
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

function range(cidr: string): V4Range {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const baseInt = base !== undefined ? v4ToInt(base) : null
  if (baseInt === null || Number.isNaN(bits)) throw new Error(`bad cidr base: ${cidr}`)
  const size = 2 ** (32 - bits)
  // 用 >>> + 乘法：<< 是 int32 运算，172.16/12 这类高位段会溢出为负
  const lo = (baseInt >>> (32 - bits)) * size
  return { lo, hi: lo + size - 1 }
}

// §2.5.1 第 2 条封锁清单（云元数据 169.254.0.0/16 含内）+ 0.0.0.0/8 兜底
const BLOCKED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'].map(range)
const BLOCKED_V4_TUPLE: V4Range[] = BLOCKED_V4

function intToV4(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

/** 展开任意 IPv6 文本形式（含 :: 压缩与尾部点分 IPv4）为 8 组 16bit；解析失败返回 null。 */
function expandV6(ip: string): number[] | null {
  let rest = ip.toLowerCase()
  // 尾部点分 IPv4（::ffff:1.2.3.4 / 64:ff9b::1.2.3.4）折算成两组 hex
  const parts = rest.split(':')
  const last = parts[parts.length - 1] ?? ''
  if (last.includes('.')) {
    const n = v4ToInt(last)
    if (n === null) return null
    rest = rest.slice(0, rest.length - last.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = rest.split('::')
  if (halves.length > 2) return null
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const groups = s.split(':')
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    }
    return groups.map(g => parseInt(g, 16))
  }
  const head = parseGroups(halves[0] ?? '')
  if (!head) return null
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : []
  if (!tail) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  return [...head, ...Array<number>(fill).fill(0), ...tail]
}

export function isBlockedIp(ip: string): boolean {
  if (ip.includes(':')) {
    const groups = expandV6(ip)
    if (!groups) return false // 无法解析的形态维持旧行为（不拦），白名单/复核兜底
    // ::1 / ::
    if (groups.every(g => g === 0)) return true
    if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return true
    // IPv4-mapped ::ffff:0:0/96（含 0:0:0:0:0:ffff:… 与 ::ffff:a00:1 等 hex 变体）
    if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
      return isBlockedIp(intToV4(((groups[6] ?? 0) << 16) | (groups[7] ?? 0)))
    }
    // NAT64 64:ff9b::/96（DNS64 合成地址，嵌入 IPv4 同样可能是内网）
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
      return isBlockedIp(intToV4(((groups[6] ?? 0) << 16) | (groups[7] ?? 0)))
    }
    // fc00::/7 → 首段 fc00–fdff；fe80::/10 → fe80–febf
    const first = groups[0] ?? 0
    if (first >= 0xfc00 && first <= 0xfdff) return true
    if (first >= 0xfe80 && first <= 0xfebf) return true
    return false
  }
  const n = v4ToInt(ip)
  if (n === null) return false
  return BLOCKED_V4_TUPLE.some(r => n >= r.lo && n <= r.hi)
}

export interface WebhookGuardOptions {
  allowInsecure: boolean
  allowlist: string[]
}

export type WebhookGuardResult = { ok: true; host: string } | { ok: false; reason: string }

/**
 * 钉扎 lookup（债务 #6）：供 undici Agent 的 connect.lookup 使用。
 * 解析 → 内网校验（白名单豁免，与 validateWebhookUrl 同规则）→ 返回已校验地址，
 * 连接层只会连到这个地址——校验与连接之间没有二次解析。
 */
export function pinnedLookup(opts: WebhookGuardOptions): LookupFunction {
  return (hostname, options, callback) => {
    const allowlisted = opts.allowlist.includes(hostname)
    dns.lookup(hostname, { all: true })
      .then(addrs => {
        if (addrs.length === 0) {
          callback(new Error('dns_no_address'), '', 0)
          return
        }
        if (!allowlisted && addrs.some(a => isBlockedIp(a.address))) {
          callback(new Error('host_resolves_to_private_range'), '', 0)
          return
        }
        const family = typeof options.family === 'number' ? options.family : 0
        const pick = (family === 4 || family === 6 ? addrs.find(a => a.family === family) : undefined) ?? addrs[0]
        if (!pick) {
          callback(new Error('dns_no_address'), '', 0)
          return
        }
        callback(null, pick.address, pick.family)
      })
      .catch(() => callback(new Error('dns_failure'), '', 0))
  }
}

/** 投递前必须重新调用（§2.5.1 第 3 条），不能缓存「入库时已通过」的结论。 */
export async function validateWebhookUrl(rawUrl: string, opts: WebhookGuardOptions): Promise<WebhookGuardResult> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  // 1. scheme：仅 https。http 两条例外：显式 ALLOW_INSECURE_WEBHOOK=1（LAN 场景），或主机在
  //    白名单内——白名单本身即运维信任声明（如 mnemosyne.zeabur.internal 内部出站端点），
  //    只豁免它却仍要求公网 TLS 会让内部投递永远过不了校验。
  const allowlisted = opts.allowlist.length > 0 && opts.allowlist.includes(u.hostname)
  if (u.protocol !== 'https:' && !(opts.allowInsecure && u.protocol === 'http:') && !allowlisted) {
    return { ok: false, reason: 'scheme_not_allowed' }
  }
  // 4. 可选白名单：配置后仅允许列内主机。白名单本身即信任声明——列内主机豁免
  //    内网段检查（LAN 部署 / 本机联调场景），但仍要求 DNS 可解析（防拼写错误失效）。
  if (opts.allowlist.length > 0 && !allowlisted) {
    return { ok: false, reason: 'host_not_in_allowlist' }
  }
  // 2/3. DNS 解析，任一地址落内网即拒绝（白名单主机豁免此检查）
  try {
    const addrs = await dns.lookup(u.hostname, { all: true })
    if (addrs.length === 0) return { ok: false, reason: 'dns_no_address' }
    if (!allowlisted) {
      for (const a of addrs) {
        if (isBlockedIp(a.address)) return { ok: false, reason: 'host_resolves_to_private_range' }
      }
    }
  } catch {
    return { ok: false, reason: 'dns_failure' }
  }
  return { ok: true, host: u.hostname }
}
