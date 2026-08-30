/**
 * §19.3.4 幂等投递（OutreachDeliverer 单点）。
 * - 投递前重过 §2.5.1 校验链（DNS 重解析，防 rebinding）；
 * - Idempotency-Key = dedupeKey，重试不重复（T9.7）；
 * - 盲 webhook：响应体丢弃不读，超时 5s；
 * - muted 判定位于本单点（T9.4：无其他通道）。
 */
import type { Db } from '../db.js'
import { validateWebhookUrl, type WebhookGuardOptions } from '../identity/webhookGuard.js'

export interface DeliveryResult {
  ok: boolean
  error?: string
}

export async function deliverOutreach(
  db: Db,
  guard: WebhookGuardOptions,
  userId: string,
  content: string,
  dedupeKey: string,
): Promise<DeliveryResult> {
  const { rows } = await db.query<{ webhook_url: string }>(
    `SELECT webhook_url FROM clients
      WHERE user_id = $1 AND is_active = TRUE AND webhook_url IS NOT NULL`,
    [userId],
  )
  if (rows.length === 0) return { ok: false, error: 'no_webhook_client' }

  for (const row of rows) {
    const verdict = await validateWebhookUrl(row.webhook_url, guard) // 每次投递重新解析（§2.5.1 第 3 条）
    if (!verdict.ok) return { ok: false, error: verdict.reason }
    try {
      await fetch(row.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': dedupeKey,
          'X-Huginn-Version': 'v0.3.1',
        },
        body: JSON.stringify({ content, timestamp: Date.now() }),
        signal: AbortSignal.timeout(5000),
      })
      // 响应体丢弃不读（盲 webhook，无回传通道）
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'delivery_timeout' : 'delivery_failed' }
    }
  }
  return { ok: true }
}
