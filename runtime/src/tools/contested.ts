/**
 * §4.7 contested 检查：用户否决过的论断所在域的工具，降级为 askUserFirst（强制走确认票）。
 * contested 论断本就不进 promptText（引擎只渲染 active）；此检查防御「宿主侧缓存的旧偏好」
 * 与「工具注册表默认行为」，补引擎管不到的一段。
 */
import type { TwigAdapter } from '../memory/TwigAdapter.js'
import type { TwigClaim as TwigClaimShape } from '../memory/types.js'
import { contestedKeywordMap } from '../router/capabilities.js'

/** 按 eternalId 隔离：缓存不分用户的话，多用户场景下 A 的 contested 论断会给 B 的工具解锁（fail-open）。 */
const cache = new Map<string, { claims: TwigClaimShape[]; at: number }>()
const CACHE_MS = 300_000
const CACHE_MAX_USERS = 100

export function resetContestedCache(): void {
  cache.clear()
}

async function contestedClaims(twig: TwigAdapter, eternalId: string): Promise<TwigClaimShape[]> {
  const hit = cache.get(eternalId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.claims.filter(c => c.status === 'contested')
  try {
    const claims = await twig.listClaims(eternalId)
    if (cache.size >= CACHE_MAX_USERS) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(eternalId, { claims, at: Date.now() })
    return claims.filter(c => c.status === 'contested')
  } catch {
    return [] // twig 不可用时不阻塞工具执行（失败开放），审计侧由 twig 自身兜底
  }
}

/** 论断文本命中该 capability 域的关键词 → 视为 contested 域命中。 */
export function matchesContestedDomain(claims: TwigClaimShape[], capability: string): TwigClaimShape | undefined {
  const map = contestedKeywordMap()
  const keywords = map[capability] ?? []
  if (keywords.length === 0) return undefined
  return claims.find(c => keywords.some(k => (c.text ?? '').toLowerCase().includes(k.toLowerCase())))
}

/** 工具执行前调用：命中 → true（执行方须转确认票流程）。 */
export async function contestedGate(
  twig: TwigAdapter,
  eternalId: string,
  capability: string,
): Promise<boolean> {
  const claims = await contestedClaims(twig, eternalId)
  return matchesContestedDomain(claims, capability) !== undefined
}
