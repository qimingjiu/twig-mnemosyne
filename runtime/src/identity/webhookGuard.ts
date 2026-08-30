/**
 * §2.5.1 Webhook URL 校验链（VULN-13 修复）
 *
 * 入库时与每次投递时各过一次；投递时重新解析 DNS（防 rebinding：入库合法、TTL 过期后改指内网）。
 *
 * TODO(rebinding-hardening): 严格的 rebinding 防御需要在 fetch 时钉住本次解析到的 IP
 * （undici Agent 自定义 connect lookup），当前实现为「投递前重校验」近似，与 §2.5.1 第 3 条
 * 之间存在微小 TOCTOU 窗口；后续以 undici Dispatcher 补齐。
 */
import { promises as dns } from 'node:dns'

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

export function isBlockedIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
    if (mapped && mapped[1]) return isBlockedIp(mapped[1])
    if (lower === '::1' || lower === '::') return true
    // fc00::/7 → 首段 fc00–fdff；fe80::/10 → fe80–febf
    const first = lower.split(':')[0] ?? ''
    const hex = parseInt(first, 16)
    if (!Number.isNaN(hex)) {
      if (hex >= 0xfc00 && hex <= 0xfdff) return true
      if (hex >= 0xfe80 && hex <= 0xfebf) return true
    }
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

/** 投递前必须重新调用（§2.5.1 第 3 条），不能缓存「入库时已通过」的结论。 */
export async function validateWebhookUrl(rawUrl: string, opts: WebhookGuardOptions): Promise<WebhookGuardResult> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  // 1. scheme：仅 https（http 需显式 ALLOW_INSECURE_WEBHOOK=1，LAN 场景）
  if (u.protocol !== 'https:' && !(opts.allowInsecure && u.protocol === 'http:')) {
    return { ok: false, reason: 'scheme_not_allowed' }
  }
  // 4. 可选白名单：配置后仅允许列内主机。白名单本身即信任声明——列内主机豁免
  //    内网段检查（LAN 部署 / 本机联调场景），但仍要求 DNS 可解析（防拼写错误失效）。
  const allowlisted = opts.allowlist.length > 0 && opts.allowlist.includes(u.hostname)
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
