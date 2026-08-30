/**
 * §8.3 TwigAdapter —— 全部真实调用，无虚构端点（VULN-01 修复，契约锚定 @89a7881）。
 * 认证：单一全局 MUNINN_AUTH_TOKEN（Bearer）。用户隔离完全由 Mnemosyne Identity Layer 保证；
 * twig 实例在 compose 中仅绑定 127.0.0.1/内网（§13.3）。
 */
import type { TwigClaim, TwigContextPacket, TwigHealth, AuditRecord, TwigState, TwigJournalEntry, TwigNote, TwigStamp, TwigCalendar } from './types.js'

export class TwigError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`twig ${method} ${path} -> ${status}: ${body.slice(0, 200)}`)
    this.name = 'TwigError'
  }
}

export class TwigAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new TwigError(method, path, res.status, await res.text())
    return (await res.json()) as T
  }

  /** 读无副作用（上游 P1-2：不执行 tick），可每轮同步调用。 */
  getContextPacket(userId: string): Promise<TwigContextPacket> {
    return this.call<TwigContextPacket>('GET', `/v1/context?userId=${encodeURIComponent(userId)}`)
  }

  /** 只灌用户消息原文（E-4）；text ≤4000 字符（R5 未落地前的过渡上限）。 */
  ingest(userId: string, text: string, opts?: { title?: string; tags?: string[] }): Promise<unknown> {
    return this.call('POST', '/v1/ingest', { userId, text, ...(opts ?? {}) })
  }

  /** 干预内生标记：凡「因为认识层说了，我才做的」动作，做完就上报（§3.6 铁律）。 */
  intervene(userId: string, claimId: string | undefined, text: string, extra?: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', '/v1/intervene', { userId, claimId, text, ...(extra ?? {}) })
  }

  listClaims(userId: string): Promise<TwigClaim[]> {
    return this.call<TwigClaim[]>('GET', `/v1/claims?userId=${encodeURIComponent(userId)}`)
  }

  lastAudit(userId: string): Promise<{ record: AuditRecord | null }> {
    return this.call<{ record: AuditRecord | null }>('GET', `/v1/audit/last?userId=${encodeURIComponent(userId)}`)
  }

  /** /v1/state 全量三层状态（调试 / 可视化用）；分页仅作用于 fragments。 */
  getState(userId: string, page?: number, limit?: number): Promise<TwigState> {
    const q = new URLSearchParams({ userId })
    if (page != null) q.set('page', String(page))
    if (limit != null) q.set('limit', String(limit))
    return this.call<TwigState>('GET', `/v1/state?${q}`)
  }

  exportJournals(userId: string): Promise<{ userId: string; entries: TwigJournalEntry[] }> {
    return this.call('GET', `/v1/journal/export?userId=${encodeURIComponent(userId)}&format=json`)
  }

  exportSoliloquies(userId: string): Promise<{ userId: string; entries: TwigJournalEntry[] }> {
    return this.call('GET', `/v1/soliloquy/export?userId=${encodeURIComponent(userId)}&format=json`)
  }

  listNotes(userId: string, page = 1, limit = 20): Promise<{ notes: TwigNote[]; total: number }> {
    return this.call('GET', `/v1/notes?userId=${encodeURIComponent(userId)}&page=${page}&limit=${limit}`)
  }

  recentStamps(userId: string, limit = 7): Promise<{ recent: TwigStamp[] }> {
    return this.call('GET', `/v1/stamps/recent?userId=${encodeURIComponent(userId)}&limit=${limit}`)
  }

  calendar(userId: string, month?: string): Promise<TwigCalendar> {
    const q = new URLSearchParams({ userId })
    if (month) q.set('month', month)
    return this.call('GET', `/v1/calendar?${q}`)
  }

  reflect(userId: string): Promise<unknown> {
    return this.call('POST', '/v1/reflect', { userId })
  }

  contest(userId: string, claimId: string, note: string): Promise<unknown> {
    return this.call('POST', '/v1/contest', { userId, claimId, note })
  }

  correct(userId: string, fragmentId: string, note: string): Promise<unknown> {
    return this.call('POST', '/v1/correct', { userId, fragmentId, note })
  }

  health(): Promise<TwigHealth> {
    return this.call<TwigHealth>('GET', '/health')
  }
}
