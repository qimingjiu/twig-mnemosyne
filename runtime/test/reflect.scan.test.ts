import { describe, it, expect, vi, type Mock } from 'vitest'
import type { Pool } from 'pg'
import type { TwigAdapter } from '../src/memory/TwigAdapter.js'
import { runReflectScan, type ReflectScanDeps } from '../src/memory/reflectScan.js'

interface Harness {
  deps: ReflectScanDeps
  reflect: Mock
  query: Mock
  logs: string[]
  warns: string[]
}

function harness(rows: { eternal_id: string }[], reflectImpl: (userId: string) => Promise<unknown>): Harness {
  const logs: string[] = []
  const warns: string[] = []
  const query = vi.fn(async () => ({ rows }))
  const reflect = vi.fn(reflectImpl)
  return {
    deps: {
      db: { query } as unknown as Pool,
      twig: { reflect } as unknown as TwigAdapter,
      activeHours: 24,
      timeoutMs: 900_000,
      log: (m: string) => logs.push(m),
      warn: (m: string) => warns.push(m),
    },
    reflect,
    query,
    logs,
    warns,
  }
}

describe('反刍排程扫描（每日 cron 的执行体）', () => {
  it('全部成功：逐用户异步点火 reflect 并透传超时', async () => {
    const h = harness([{ eternal_id: 'a'.repeat(64) }, { eternal_id: 'b'.repeat(64) }],
      async () => ({ queued: true }))
    const r = await runReflectScan(h.deps)

    expect(r).toMatchObject({ scanned: 2, ok: 2, failed: 0, failures: [] })
    expect(h.reflect).toHaveBeenCalledTimes(2)
    expect(h.reflect).toHaveBeenCalledWith('a'.repeat(64), 900_000, { async: true })
    expect(h.logs.some(m => m.includes('queued'))).toBe(true)
    expect(h.warns).toHaveLength(0)
  })

  it('首次失败重试成功：计 ok，不进 failures', async () => {
    const h = harness([{ eternal_id: 'c'.repeat(64) }], async () => {
      throw new Error('boom')
    })
    h.reflect.mockRejectedValueOnce(new Error('timeout'))
    h.reflect.mockResolvedValueOnce({ queued: true })
    const r = await runReflectScan(h.deps)

    expect(r).toMatchObject({ scanned: 1, ok: 1, failed: 0 })
    expect(h.reflect).toHaveBeenCalledTimes(2)
    expect(h.warns).toHaveLength(0)
  })

  it('重试仍失败：记录失败并告警，不阻塞后续用户', async () => {
    const h = harness([{ eternal_id: 'd'.repeat(64) }, { eternal_id: 'e'.repeat(64) }],
      async userId => {
        if (userId === 'd'.repeat(64)) throw new Error('twig down')
        return {}
      })
    const r = await runReflectScan(h.deps)

    expect(r).toMatchObject({ scanned: 2, ok: 1, failed: 1 })
    expect(r.failures).toEqual([{ userId: 'd'.repeat(64), error: 'twig down' }])
    expect(h.warns.some(m => m.includes('failed after retry'))).toBe(true)
    // d 重试共 2 次 + e 1 次 = 3 次调用；e 未被 d 阻塞
    expect(h.reflect).toHaveBeenCalledTimes(3)
  })

  it('活跃窗口参数进入 SQL：仅用户消息、近 N 小时', async () => {
    const h = harness([{ eternal_id: 'f'.repeat(64) }], async () => ({}))
    await runReflectScan(h.deps)

    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("m.role = 'user'")
    expect(sql).toContain('make_interval(hours => $1::int)')
    expect(params).toEqual([24])
  })

  it('无活跃用户：不发起任何 reflect 调用', async () => {
    const h = harness([], async () => ({}))
    const r = await runReflectScan(h.deps)

    expect(r).toMatchObject({ scanned: 0, ok: 0, failed: 0 })
    expect(h.reflect).not.toHaveBeenCalled()
  })
})
