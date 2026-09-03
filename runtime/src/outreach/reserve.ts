/**
 * §19.3.1 原子抢槽（Atomic Reservation）。
 * daily_cap 不再采用「先查询计数再判断」的竞态模式：抢到 slot 才获得生成与投递配额。
 * 幂等键唯一性由部分唯一索引 uq_outreach_dedupe（dedupe_key <> ''）保证——
 * 见 migration 003 文件头对补丁 UNIQUE(user_id, dedupe_key) 硬伤的修正说明。
 */
import type { Db } from '../db.js'
import { sha256Hex } from '../util/crypto.js'

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === '23505'
}

/** UTC 日戳（reservation_date 口径）；管线与抢槽必须用同一份，跨 UTC 午夜各自计算会错位。 */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export async function reserveOutreachSlot(db: Db, userId: string, dailyCap: number, today: string = utcToday()): Promise<number | null> {
  // 崩溃残留清理：非终态且 2h 未动的占位标 failed。含历史日期（<=）：日期滚动后残留行
  // 永不再被当日扫描触及，只清当日会永远留在表里
  await db.query(
    `UPDATE outreach
        SET status = 'failed', filter_reason = 'stale_reservation', updated_at = NOW()
      WHERE user_id = $1 AND reservation_date <= $2
        AND status IN ('reserved','generated','delivery_pending')
        AND updated_at < NOW() - INTERVAL '2 hours'`,
    [userId, today],
  )
  for (let slot = 1; slot <= dailyCap; slot++) {
    try {
      await db.query(
        `INSERT INTO outreach (user_id, reservation_date, slot_number, status, content)
         VALUES ($1, $2, $3, 'reserved', '')`,
        [userId, today, slot],
      )
      return slot
    } catch (e) {
      if (isUniqueViolation(e)) continue // 唯一冲突，试下一个 slot
      throw e
    }
  }
  return null // 已满（INV-H01）
}

/** §19.3.4：minuteBucket = 5 分钟粒度（300_000ms）。 */
export function minuteBucket(now: number = Date.now()): number {
  return Math.floor(now / 300_000)
}

export function outreachDedupeKey(
  userId: string,
  outreachType: string,
  targetId: string,
  bucket: number = minuteBucket(),
): string {
  // sha256 hex = 64 字符，恰为 VARCHAR(64) 上限
  return sha256Hex(`${userId}:${outreachType}:${targetId}:${bucket}`)
}
