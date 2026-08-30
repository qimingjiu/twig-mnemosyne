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
  rementionInvitation?: {
    status?: string
    expiresAt?: string
    [k: string]: unknown
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
}
