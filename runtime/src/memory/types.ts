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

/* ---------- Dashboard BFF（/v1/web/*）依赖的只读形状；宽松定义，渲染侧自兜底 ---------- */

export interface TwigFragment {
  id: string
  title?: string
  body: string
  dateLabel?: string
  date?: string
  tags?: string[]
  source?: string
  [k: string]: unknown
}

export interface TwigState {
  userId?: string
  fragments: TwigFragment[]
  threads: TwigThread[]
  claims: TwigClaim[]
  totalFragments?: number
  page?: number
  limit?: number
  [k: string]: unknown
}

export interface TwigJournalEntry {
  date: string
  content: string
  [k: string]: unknown
}

export interface TwigNote {
  id: string
  content: string
  date: string
  status?: string
  [k: string]: unknown
}

export interface TwigStamp {
  type: string
  beadType: string
  beadName: string
  date: string
  notePreview: string
}

export interface TwigCalendar {
  year: number
  month: number
  days: { date: string; hasJournal: boolean; hasSoliloquy: boolean; hasNote: boolean; noteStatus: string | null; hasStamp: boolean }[]
}
