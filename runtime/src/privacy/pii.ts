/**
 * PII 检测（§20.2 隐私评分信号源 / §11 观测侧脱敏共用检测核）。
 *
 * 词表/模式为 vendor 管理配置，当前为内置启发式：证件号 > 手机号 > 地址簇 > 邮箱。
 * 真名簇检测依赖 NER，deferred（漏检由 §11.5 深度防御兜底：日志侧脱敏义务不因路由而免除）。
 */

export type PiiCategory = 'cn_id' | 'cn_mobile' | 'email' | 'address'

interface Pattern {
  category: PiiCategory
  re: RegExp
  weight: number
}

// 全局 flag 供 matchAll 使用；调用方不得复用 lastIndex
const PATTERNS: Pattern[] = [
  { category: 'cn_id', re: /(?<!\d)\d{17}[\dXx](?!\d)/g, weight: 30 },
  { category: 'cn_mobile', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, weight: 20 },
  { category: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, weight: 15 },
  {
    category: 'address',
    re: /[^\s，。,、；;]{0,10}(?:省|市|自治区)[^\s，。,、；;]{2,25}(?:路|街|巷|道|大厦|小区|号楼|栋|幢|单元|室)/g,
    weight: 25,
  },
]

export interface PiiScan {
  hits: { category: PiiCategory; count: number }[]
  /** §20.2：按命中类别加权，0–60 */
  score: number
}

export function detectPii(text: string): PiiScan {
  const hits: PiiScan['hits'] = []
  let score = 0
  for (const { category, re, weight } of PATTERNS) {
    const count = [...text.matchAll(re)].length
    if (count === 0) continue
    hits.push({ category, count })
    // 每类别最多按 2 次命中累计，防长文刷分
    score += weight * Math.min(count, 2)
  }
  return { hits, score: Math.min(60, score) }
}

/** 观测侧脱敏（§11.5）：任何携带用户内容的日志字段，落盘前必须过此函数。 */
export function redactPii(text: string): string {
  let out = text
  for (const { category, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${category}]`)
  }
  return out
}
