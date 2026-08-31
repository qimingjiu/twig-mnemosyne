/**
 * 内置 MCP server（无外部依赖，容器内最稳；§5.3 铁律不受触动——只碰公网 API）。
 *
 * - core：get_current_time（E2E 验证锚点）
 * - web：DuckDuckGo HTML 搜索 + 网页抓取/正文提取（原先 @OEvortex/ddg_search 在 npm 上 404，整条链路死在路上）
 * - music：网易云公开搜索 API → {页面URL, 可播放URL}，供 TG sendAudio / 链接预览
 * - scholar：Semantic Scholar Graph API（可选 x-api-key 提升限额）
 */
export interface ToolInfo {
  server: string
  name: string
  description: string
  input_schema: unknown
}

export interface BuiltinServer {
  tools: ToolInfo[]
  call(tool: string, args: Record<string, unknown>): Promise<string>
}

import { createCipheriv, randomBytes } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) mnemosyne-gateway/0.2'

async function http(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init.headers ?? {}) }
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
}

// ─────────────────────────────────────────────────────────────────────────
// core：当前时间
// ─────────────────────────────────────────────────────────────────────────
function coreTime(args: Record<string, unknown>): string {
  const tz = typeof args.tz === 'string' && args.tz ? args.tz : 'UTC'
  try {
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(new Date())
    return `${s} (${tz})`
  } catch {
    return `invalid timezone: ${tz}`
  }
}

// ─────────────────────────────────────────────────────────────────────────
// web：DuckDuckGo HTML（无需 API key）
// ─────────────────────────────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

interface WebHit { title: string; url: string; snippet: string }

async function ddgSearch(query: string, maxResults: number): Promise<WebHit[]> {
  // 8s 短超时：国内环境 DDG 被墙时快速失败落到 Bing，而不是让模型干等 20s
  const res = await http('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
  }, 8_000)
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`)
  const html = await res.text()
  const hits: WebHit[] = []
  // DDG 结果链接为跳转形式 /l/?uddg=<urlencoded>；锚文本与摘要成对解析
  const blocks = html.split(/result__a/).slice(1)
  for (const block of blocks) {
    const head = 'result__a' + block
    const href = /href="([^"]+)"/.exec(head)?.[1]
    const titleMatch = /<a[^>]*>([\s\S]*?)<\/a>/.exec(head.slice(0, 2000))
    const rawHref = href ?? ''
    const title = titleMatch ? stripHtml(titleMatch[1]) : ''
    let url = rawHref
    if (rawHref.includes('uddg=')) url = decodeURIComponent(/[?&]uddg=([^&"]+)/.exec(rawHref)?.[1] ?? '')
    if (!url || !title) continue
    const snip = /result__snippet[^>]*>([\s\S]*?)<\/a>/.exec(block.slice(0, 4000))?.[1]
    hits.push({ title, url, snippet: snip ? stripHtml(snip) : '' })
    if (hits.length >= maxResults) break
  }
  return hits
}

/** Bing cn 兜底（DDG 在国内不可达）：b_algo 块解析（块内有数 KB 的 link 样式前置，扫描窗口要够大）。 */
async function bingSearch(query: string, maxResults: number): Promise<WebHit[]> {
  const res = await http(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`bing ${res.status}`)
  const html = await res.text()
  const hits: WebHit[] = []
  const blocks = html.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const m = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block.slice(0, 8000))
    if (!m) continue
    const url = m[1]
    const title = stripHtml(m[2])
    if (!url.startsWith('http') || !title) continue
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block.slice(0, 10000))?.[1]
    hits.push({ title, url, snippet: snip ? stripHtml(snip) : '' })
    if (hits.length >= maxResults) break
  }
  return hits
}

async function webSearch(query: string, maxResults: number): Promise<WebHit[]> {
  try {
    return await ddgSearch(query, maxResults)
  } catch {
    return await bingSearch(query, maxResults) // DDG 不可达（GFW）时兜底
  }
}

async function fetchPage(url: string): Promise<string> {
  const res = await http(url)
  if (!res.ok) throw new Error(`fetch ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  const text = type.includes('html') || !type.includes('json') ? stripHtml(raw) : raw
  return text.slice(0, 5000)
}

// ─────────────────────────────────────────────────────────────────────────
// music：网易云公开搜索（§新增；Envelope 由 Runtime 消费为 TG 附件）
// ─────────────────────────────────────────────────────────────────────────
export interface MusicSong {
  id: number
  title: string
  artist: string
  pageUrl: string
  playUrl: string
}

interface NeteaseSong {
  id: number
  name: string
  artists?: { name: string }[]
}

// weapi 加密（公开搜索需要；cloudsearch 端点已加风控返回 50000005，旧 search/get/web 仍可用）
const NE_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const NE_NONCE = '0CoJUm6Qyw8W8jud'

function neAes(text: string, key: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from('0102030405060708'))
  return cipher.update(text, 'utf8', 'base64') + cipher.final('base64')
}

function neRsa(text: string): string {
  const reversed = Buffer.from(text.split('').reverse().join(''), 'utf8')
  const bi = BigInt(`0x${reversed.toString('hex')}`)
  return (bi ** 0x10001n % BigInt(`0x${NE_MODULUS}`)).toString(16).padStart(256, '0')
}

function neWeapi(payload: Record<string, string>): string {
  const secKey = randomBytes(8).toString('hex') // 16 个十六进制字符
  return new URLSearchParams({
    params: neAes(neAes(JSON.stringify(payload), NE_NONCE), secKey),
    encSecKey: neRsa(secKey),
  }).toString()
}

async function neteaseSearch(query: string, limit: number): Promise<MusicSong[]> {
  const res = await http('https://music.163.com/weapi/search/get/web', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      Cookie: 'os=pc',
    },
    body: neWeapi({ s: query, type: '1', offset: '0', limit: String(limit), csrf_token: '' }),
  })
  if (!res.ok) throw new Error(`netease ${res.status}`)
  const data = (await res.json()) as { code?: number; result?: { songs?: NeteaseSong[] } }
  if (data.code !== undefined && data.code !== 200) throw new Error(`netease code ${data.code}`)
  const songs = data.result?.songs ?? []
  return songs.slice(0, limit).map(s => ({
    id: s.id,
    title: s.name,
    artist: (s.artists ?? []).map(a => a.name).join('/') || 'unknown',
    pageUrl: `https://music.163.com/song?id=${s.id}`,
    playUrl: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`,
  }))
}

/** 音乐结果统一信封：Runtime 识别 status:'music' 转 TG 附件（play）或纯文本（search）。 */
export function musicEnvelope(action: 'search' | 'play', songs: MusicSong[]): string {
  return JSON.stringify({ status: 'music', action, songs }, null, 2)
}

// ─────────────────────────────────────────────────────────────────────────
// scholar：Semantic Scholar Graph API
// ─────────────────────────────────────────────────────────────────────────
const S2_FIELDS = 'title,abstract,year,authors,url,externalIds'

function s2Headers(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY
  return key ? { 'x-api-key': key } : {}
}

interface S2Paper { paperId?: string; title?: string; year?: number; abstract?: string; url?: string; authors?: { name?: string }[] }

function s2PaperLines(p: S2Paper): string[] {
  const authors = (p.authors ?? []).map(a => a.name ?? '').filter(Boolean).join(', ') || 'unknown'
  return [
    `• ${p.title ?? '(untitled)'}${p.year ? ` (${p.year})` : ''}`,
    `  authors: ${authors}`,
    p.abstract ? `  abstract: ${p.abstract.slice(0, 400)}` : '',
    p.url ? `  url: ${p.url}` : '',
  ].filter(Boolean)
}

async function s2Search(query: string, limit: number): Promise<string> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(limit, 20)}&fields=${S2_FIELDS}`
  const res = await http(url, { headers: s2Headers() })
  if (!res.ok) throw new Error(`semantic-scholar ${res.status}`)
  const data = (await res.json()) as { data?: S2Paper[] }
  const papers = data.data ?? []
  return papers.length === 0 ? '(no results)' : papers.flatMap(s2PaperLines).join('\n')
}

async function s2Paper(id: string): Promise<string> {
  const res = await http(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`, { headers: s2Headers() })
  if (!res.ok) throw new Error(`semantic-scholar ${res.status}`)
  return s2PaperLines((await res.json()) as S2Paper).join('\n')
}

async function s2AuthorPapers(authorId: string, limit: number): Promise<string> {
  const url = `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(authorId)}/papers?limit=${Math.min(limit, 20)}&fields=${S2_FIELDS}`
  const res = await http(url, { headers: s2Headers() })
  if (!res.ok) throw new Error(`semantic-scholar ${res.status}`)
  const data = (await res.json()) as { data?: S2Paper[] }
  const papers = data.data ?? []
  return papers.length === 0 ? '(no results)' : papers.flatMap(s2PaperLines).join('\n')
}

async function s2Related(paperId: string, limit: number): Promise<string> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}/citations?limit=${Math.min(limit, 20)}&fields=${S2_FIELDS}`
  const res = await http(url, { headers: s2Headers() })
  if (!res.ok) throw new Error(`semantic-scholar ${res.status}`)
  const data = (await res.json()) as { data?: { citingPaper?: S2Paper }[] }
  const papers = (data.data ?? []).map(d => d.citingPaper ?? {})
  return papers.length === 0 ? '(no results)' : papers.flatMap(s2PaperLines).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
// 内置注册表：server 名 → 工具定义 + 执行体
// ─────────────────────────────────────────────────────────────────────────
function strArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' && v ? v : fallback
}

function numArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const registry = (server: string, def: { tools: Omit<ToolInfo, 'server'>[]; call: BuiltinServer['call'] }): BuiltinServer => ({
  tools: def.tools.map(t => ({ ...t, server })),
  call: def.call,
})

export const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
  core: registry('core', {
    tools: [
      {
        name: 'get_current_time',
        description: "Returns the current time and date, optionally in a IANA timezone (e.g. Asia/Shanghai)",
        input_schema: {
          type: 'object',
          properties: { tz: { type: 'string', description: 'IANA timezone, defaults to UTC' } },
        },
      },
    ],
    call: async (tool, args) => {
      if (tool === 'get_current_time') return coreTime(args)
      throw new Error(`unknown builtin tool: core/${tool}`)
    },
  }),

  web: registry('web', {
    tools: [
      {
        name: 'search',
        description: 'Web search (DuckDuckGo primary, Bing fallback), returns titles/URLs/snippets',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            max_results: { type: 'number', description: 'Max results (default 5, cap 10)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch',
        description: 'Fetch a webpage and return cleaned text',
        input_schema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Page URL' } },
          required: ['url'],
        },
      },
      {
        name: 'extract',
        description: 'Fetch a webpage and return cleaned text (alias of fetch)',
        input_schema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Page URL' } },
          required: ['url'],
        },
      },
    ],
    call: async (tool, args) => {
      if (tool === 'search') {
        const query = strArg(args, 'query')
        if (!query) throw new Error('query required')
        const hits = await webSearch(query, Math.min(numArg(args, 'max_results', 5), 10))
        if (hits.length === 0) return '(no results)'
        return hits.map(h => `• ${h.title}\n  ${h.url}${h.snippet ? `\n  ${h.snippet}` : ''}`).join('\n')
      }
      if (tool === 'fetch' || tool === 'extract') {
        const url = strArg(args, 'url')
        if (!/^https?:\/\//.test(url)) throw new Error('valid url required')
        return await fetchPage(url)
      }
      throw new Error(`unknown builtin tool: web/${tool}`)
    },
  }),

  music: registry('music', {
    tools: [
      {
        name: 'search',
        description: 'Search NetEase Cloud Music, returns candidates with page/play URLs',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Song / artist keywords' },
            limit: { type: 'number', description: 'Max results (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'play',
        description: 'Pick the top search hit as a playable track (Runtime turns this into a TG audio attachment)',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Song / artist keywords' } },
          required: ['query'],
        },
      },
    ],
    call: async (tool, args) => {
      const query = strArg(args, 'query')
      if (!query) throw new Error('query required')
      if (tool === 'search') return musicEnvelope('search', await neteaseSearch(query, Math.min(numArg(args, 'limit', 5), 10)))
      if (tool === 'play') return musicEnvelope('play', await neteaseSearch(query, 1))
      throw new Error(`unknown builtin tool: music/${tool}`)
    },
  }),

  scholar: registry('scholar', {
    tools: [
      {
        name: 'search_papers',
        description: 'Search academic papers by keyword, author, or topic',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default 5, cap 20)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_paper_details',
        description: 'Get detailed metadata for a specific paper',
        input_schema: {
          type: 'object',
          properties: { paper_id: { type: 'string', description: 'S2 paperId, DOI, or other external id' } },
          required: ['paper_id'],
        },
      },
      {
        name: 'get_author_papers',
        description: 'List papers by a specific author',
        input_schema: {
          type: 'object',
          properties: {
            author_id: { type: 'string', description: 'Semantic Scholar author id' },
            limit: { type: 'number' },
          },
          required: ['author_id'],
        },
      },
      {
        name: 'find_related_papers',
        description: 'Find papers related to a given paper via citation graph',
        input_schema: {
          type: 'object',
          properties: {
            paper_id: { type: 'string', description: 'S2 paperId' },
            limit: { type: 'number' },
          },
          required: ['paper_id'],
        },
      },
    ],
    call: async (tool, args) => {
      if (tool === 'search_papers') {
        const query = strArg(args, 'query')
        if (!query) throw new Error('query required')
        return await s2Search(query, numArg(args, 'limit', 5))
      }
      if (tool === 'get_paper_details') {
        const id = strArg(args, 'paper_id')
        if (!id) throw new Error('paper_id required')
        return await s2Paper(id)
      }
      if (tool === 'get_author_papers') {
        const id = strArg(args, 'author_id')
        if (!id) throw new Error('author_id required')
        return await s2AuthorPapers(id, numArg(args, 'limit', 5))
      }
      if (tool === 'find_related_papers') {
        const id = strArg(args, 'paper_id')
        if (!id) throw new Error('paper_id required')
        return await s2Related(id, numArg(args, 'limit', 5))
      }
      throw new Error(`unknown builtin tool: scholar/${tool}`)
    },
  }),
}
