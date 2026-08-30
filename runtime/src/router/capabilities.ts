/**
 * §4 Capability Router & Registry（VULN-01 配套修复）。
 *
 * §10.2 单一意图决策点：本模块不做意图分类，只按泳道白名单收敛 capability 集合——
 * 「他能看见哪些工具」。意图归属由 LangGraph Router（§10.3，当前由 lanes.ts 轻量实现）判定。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { env } from '../config.js'

export interface ToolDef {
  name: string
  description: string
  confirmation_required?: boolean
}

export interface Capability {
  name: string
  description: string
  provider: string
  confirmation_required: boolean
  required_role?: string
  auth_type?: 'oauth2' | 'api_key' | 'none'
  auth_config?: Record<string, unknown>
  tools: ToolDef[]
}

interface CapFile {
  lanes: Record<string, string[]>
  cap_domains: { contested_keywords: Record<string, string[]> }
  capabilities: Record<string, Omit<Capability, 'name'>>
  /** §5：capability provider → mcp-gateway server 名 */
  mcp_servers?: Record<string, string>
}

let cache: CapFile | null = null

export function loadCapabilities(dir = env.CONFIG_DIR): CapFile {
  if (cache) return cache
  const raw = parse(readFileSync(join(dir, 'capabilities.yaml'), 'utf8')) as CapFile
  cache = raw
  return raw
}

/** 测试隔离用。 */
export function resetCapabilitiesCache(): void {
  cache = null
}

export function getForLane(lane: string, file: CapFile = loadCapabilities()): Capability[] {
  // 未知泳道 fail-closed 到 chat 泳道（与 routerNode default 行为一致，§10.3）
  const names = file.lanes[lane] ?? file.lanes['chat'] ?? []
  const out: Capability[] = []
  for (const name of names) {
    const def = file.capabilities[name]
    if (def) out.push({ name, ...def })
  }
  return out
}

/** §4.7 contested → capability 域映射（注册表配置）。 */
export function contestedKeywordMap(file: CapFile = loadCapabilities()): Record<string, string[]> {
  return file.cap_domains?.contested_keywords ?? {}
}

/**
 * Capability schemas 注入（预算 ≤6K，可截断，§3.2）。
 * 超预算时逐级压缩：完整 schema → 仅工具名 → 丢弃末位 capability。
 */
export function formatCapabilities(caps: Capability[], tokenBudget: number, estimate: (s: string) => number): string {
  if (caps.length === 0) return ''
  const render = (c: Capability, compact: boolean): string => {
    const tools = c.tools
      .map(t => compact ? `  - ${t.name}` : `  - name: ${t.name}\n    description: ${t.description}${t.confirmation_required ? '\n    confirmation_required: true' : ''}`)
      .join('\n')
    return `${c.name}: ${compact ? c.provider : c.description}\n${tools}`
  }
  let text = caps.map(c => render(c, false)).join('\n')
  if (estimate(text) <= tokenBudget) return text
  text = caps.map(c => render(c, true)).join('\n')
  let kept = [...caps]
  while (kept.length > 0 && estimate(text) > tokenBudget) {
    kept = kept.slice(0, -1)
    text = kept.map(c => render(c, true)).join('\n')
  }
  return kept.length === 0 ? '' : text
}
