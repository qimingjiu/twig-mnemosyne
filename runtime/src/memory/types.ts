/** §3.3 TwigContextPacket —— 契约锚定 twig-memory @89a7881。 */
export interface TwigThread {
  id: string
  label: string
  openQuestion: string
  pool: string
  daysOpen: number
  dragonVein: number
}

export interface TwigClaim {
  id: string
  text: string
  conviction: number
  boundary: string
  status: string
  /** v0.3.1 上游语义：再提邀请挂在 contested 论断上（独立新证据 ≥3 + 否决冷却 14 天后生成） */
  rementionInvitation?: {
    at: string
    text: string
    newEvidenceIds?: string[]
    /** 'redeemed' = 宿主上报 user_engaged 已消费；缺省按 pending 处理；上游 30 天后不再注入 */
    status?: 'redeemed' | string
  }
  [k: string]: unknown
}

export interface TwigContextPacket {
  userId: string
  generatedAt: string
  threads: TwigThread[]
  claims: TwigClaim[]
  recentFragments: { id: string; date: string; title: string }[]
  promptText: string
  recentStamps?: { type: string; beadType: string; beadName: string; date: string; notePreview: string }[]
}

export interface AuditRecord {
  [k: string]: unknown
}

export interface TwigHealth {
  ok: boolean
  auth: boolean
  llm: string
  embed?: string
}
