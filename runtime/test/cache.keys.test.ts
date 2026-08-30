import { describe, it, expect } from 'vitest'
import { buildCacheKey, narrativeVersionOf, normMessages } from '../src/cache/keys.js'
import { shouldCache } from '../src/cache/policy.js'

const msgs = (content: string) => [{ role: 'user', content }]
const params = { temperature: 0.7 }

describe('§7.1 缓存键规范（VULN-03/VULN-10）', () => {
  it('键内嵌 userId 明文段（服务 §8.6 GDPR SCAN+DEL）', () => {
    const key = buildCacheKey('exact', 'userA', 'nv1', msgs('hi'), 'gpt-4o', params)
    expect(key.startsWith('cache:v1:exact:userA:')).toBe(true)
  })

  it('不同用户同输入 → 不同键（T8.1 跨租户污染防线）', () => {
    const a = buildCacheKey('exact', 'userA', 'nv1', msgs('hi'), 'gpt-4o', params)
    const b = buildCacheKey('exact', 'userB', 'nv1', msgs('hi'), 'gpt-4o', params)
    expect(a).not.toBe(b)
  })

  it('narrativeVersion 入摘要（T8.3 叙事演化 → 自然 MISS）', () => {
    const a = buildCacheKey('exact', 'u', 'nv1', msgs('hi'), 'gpt-4o', params)
    const b = buildCacheKey('exact', 'u', 'nv2', msgs('hi'), 'gpt-4o', params)
    expect(a).not.toBe(b)
  })

  it('NFKC + 空白归一：全角/空白差异不产生新键', () => {
    const a = buildCacheKey('exact', 'u', 'nv', msgs('Ｈｅｌｌｏ  世界'), 'm', params)
    const b = buildCacheKey('exact', 'u', 'nv', msgs('Hello 世界'), 'm', params)
    expect(a).toBe(b)
  })

  it('勘误 D-04：大小写携带语义，不做 lowercase', () => {
    expect(normMessages([{ role: 'u', content: 'NO' }])[0]?.c).toBe('NO')
    const a = buildCacheKey('exact', 'u', 'nv', msgs('NO'), 'm', params)
    const b = buildCacheKey('exact', 'u', 'nv', msgs('no'), 'm', params)
    expect(a).not.toBe(b)
  })

  it('勘误 E-3：narrativeVersion 只由 promptText 内容派生', () => {
    expect(narrativeVersionOf('same text')).toBe(narrativeVersionOf('same text'))
    expect(narrativeVersionOf('same text')).toHaveLength(16)
    expect(narrativeVersionOf('changed')).not.toBe(narrativeVersionOf('same text'))
  })
})

describe('§7.6 Cache Policy', () => {
  it('危机路径零缓存（T8.4）', () => {
    expect(shouldCache({ crisis: true, status: 200, hasToolResults: false })).toEqual({
      shouldCache: false, reason: 'crisis_path',
    })
  })

  it('错误响应不缓存；用户 opt-out 不缓存', () => {
    expect(shouldCache({ crisis: false, status: 500, hasToolResults: false }).shouldCache).toBe(false)
    expect(shouldCache({ crisis: false, status: 200, metadata: { cache: false }, hasToolResults: false }).shouldCache).toBe(false)
  })

  it('VULN-11：工具结果按消息元数据判定，短 TTL', () => {
    expect(shouldCache({ crisis: false, status: 200, hasToolResults: true })).toEqual({
      shouldCache: true, ttl: 300, reason: 'tool_result_short_ttl',
    })
  })

  it('默认 3600s', () => {
    expect(shouldCache({ crisis: false, status: 200, hasToolResults: false }).ttl).toBe(3600)
  })
})
