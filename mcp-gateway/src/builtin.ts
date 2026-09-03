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
import { request as httpRequest } from 'node:http'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) mnemosyne-gateway/0.2'

async function http(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init.headers ?? {}) }
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
}

// ─────────────────────────────────────────────────────────────────────────
// core：当前时间
// ─────────────────────────────────────────────────────────────────────────
function coreTime(args: Record<string, unknown>): string {
  // 默认时区：DEFAULT_TIMEZONE 优先，其次容器本地时区（Intl 不传 timeZone 即系统时区）。
  // 固定 UTC 会把个人部署的时间全报错（2026-09-01「凌晨1點」事故）。
  const fallbackTz = process.env.DEFAULT_TIMEZONE
  const tz = typeof args.tz === 'string' && args.tz ? args.tz : fallbackTz
  try {
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, dateStyle: 'full', timeStyle: 'long' }).format(new Date())
    return `${s} (${tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'system-local'})`
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
  if (hits.length === 0) throw new Error('ddg returned empty results (soft block)')
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
  /** 来源平台标识（用于多源搜索区分） */
  source?: string
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
      // 网易 weapi 会检测 X-Real-IP 判断国内 IP；海外机房（Zeabur HK）不加则返回空
      'X-Real-IP': '223.5.5.5',
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
    source: 'netease',
  }))
}

// ── ccMixter：Creative Commons 音乐社区（公开 API，无需 key）──────────────────
interface CcMixterSong {
  upload_id: number
  upload_name: string
  user_name: string
  user_real_name?: string
  file_page_url: string
  files?: { file_nicname: string; download_url: string; file_format_info?: { 'media-type': string } }[]
}

/** ccMixter 用原生 http（node:http request）避免 undici HeadersOverflowError。
 *  ccMixter 返回大量 Set-Cookie，需把 maxHeaderSize 扩到 256KB。 */
function httpGetJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { 'User-Agent': UA }, maxHeaderSize: 256_000 }, (res) => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(raw) as T) } catch (e) { reject(new Error(`ccmixter json parse: ${e}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('ccmixter timeout')) })
    req.setTimeout(timeoutMs)
    req.end()
  })
}

async function ccMixterSearch(query: string, limit: number): Promise<MusicSong[]> {
  const data = await httpGetJson<CcMixterSong[]>(
    `http://ccmixter.org/api/query?search=${encodeURIComponent(query)}&limit=${limit}&format=json`,
  )
  if (!Array.isArray(data)) throw new Error('ccmixter invalid response')
  return data.slice(0, limit).map(s => {
    const mp3File = s.files?.find(f => f.file_nicname === 'mp3' || f.file_format_info?.['media-type'] === 'audio')
    const downloadUrl = mp3File?.download_url ?? s.files?.[0]?.download_url ?? ''
    return {
      id: s.upload_id,
      title: s.upload_name,
      artist: s.user_real_name || s.user_name || 'unknown',
      pageUrl: s.file_page_url,
      playUrl: downloadUrl,
      source: 'ccmixter',
    }
  })
}

// ── Jamendo：Creative Commons 音乐库（需 client_id；用户已提供）────────────────
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID ?? '34fb3690'

interface JamendoTrack {
  id: string
  name: string
  artist_name: string
  shareurl: string
  audio: string
  audiodownload: string
}

async function jamendoSearch(query: string, limit: number): Promise<MusicSong[]> {
  const res = await http(
    `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CLIENT_ID}&format=json&search=${encodeURIComponent(query)}&limit=${limit}`,
    {},
    15_000,
  )
  if (!res.ok) throw new Error(`jamendo ${res.status}`)
  const data = (await res.json()) as { headers?: { status?: string }; results?: JamendoTrack[] }
  if (data.headers?.status !== 'success') throw new Error(`jamendo api error: ${data.headers?.status}`)
  const tracks = data.results ?? []
  return tracks.slice(0, limit).map(t => ({
    id: parseInt(t.id, 10) || 0,
    title: t.name,
    artist: t.artist_name || 'unknown',
    pageUrl: t.shareurl,
    playUrl: t.audio || t.audiodownload,
    source: 'jamendo',
  }))
}

/** 音乐结果统一信封：Runtime 识别 status:'music' 转 TG 附件（play）或纯文本（search）。
 * 紧凑序列化 + 总量封顶：Runtime 侧 tool 结果统一按 4000 字截断（回灌/落库），
 * pretty-print 的 30 首结果 ≈10KB 会被腰斩成非法 JSON，附件信封随之解析失败。 */
export function musicEnvelope(action: 'search' | 'play', songs: MusicSong[]): string {
  return JSON.stringify({ status: 'music', action, songs: songs.slice(0, 10) })
}

// ─────────────────────────────────────────────────────────────────────────
// scholar：Semantic Scholar Graph API
// ─────────────────────────────────────────────────────────────────────────
const S2_FIELDS = 'title,abstract,year,authors,url,externalIds'

function s2Headers(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY
  return key ? { 'x-api-key': key } : {}
}

/** 429 单独说人话：无 key 时走 S2 无鉴权共享池，限流极紧（模型能把原因转述给用户）。 */
function s2Error(status: number): Error {
  return new Error(
    status === 429
      ? 'semantic-scholar 429 rate limited — unauthenticated shared pool is very tight; apply a free key at semanticscholar.org/product/api and set SEMANTIC_SCHOLAR_API_KEY on the mcp-gateway service'
      : `semantic-scholar ${status}`,
  )
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
  if (!res.ok) throw s2Error(res.status)
  const data = (await res.json()) as { data?: S2Paper[] }
  const papers = data.data ?? []
  return papers.length === 0 ? '(no results)' : papers.flatMap(s2PaperLines).join('\n')
}

async function s2Paper(id: string): Promise<string> {
  const res = await http(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`, { headers: s2Headers() })
  if (!res.ok) throw s2Error(res.status)
  return s2PaperLines((await res.json()) as S2Paper).join('\n')
}

async function s2AuthorPapers(authorId: string, limit: number): Promise<string> {
  const url = `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(authorId)}/papers?limit=${Math.min(limit, 20)}&fields=${S2_FIELDS}`
  const res = await http(url, { headers: s2Headers() })
  if (!res.ok) throw s2Error(res.status)
  const data = (await res.json()) as { data?: S2Paper[] }
  const papers = data.data ?? []
  return papers.length === 0 ? '(no results)' : papers.flatMap(s2PaperLines).join('\n')
}

async function s2Related(paperId: string, limit: number): Promise<string> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}/citations?limit=${Math.min(limit, 20)}&fields=${S2_FIELDS}`
  const res = await http(url, { headers: s2Headers() })
  if (!res.ok) throw s2Error(res.status)
  const data = (await res.json()) as { data?: { citingPaper?: S2Paper }[] }
  const papers = (data.data ?? []).map(d => d.citingPaper ?? {})
  return papers.length === 0 ? '(no results)' : papers.flatMap(s2PaperLines).join('\n')
}

// ── OpenAlex 兜底源：免 key 学术库。S2 无 key 的共享池 429 是常态，申请 key 又常被
//    「学术邮箱」拦住——OpenAlex 完全开放（polite pool 留个 mailto 即可），兜底后零配置可用。
const OA_SELECT = 'id,display_name,publication_year,doi,authorships,abstract_inverted_index'

interface OAWork {
  id?: string
  display_name?: string
  publication_year?: number
  doi?: string
  authorships?: { author?: { display_name?: string } }[]
  abstract_inverted_index?: Record<string, number[]> | null
}

/** OpenAlex 摘要是倒排索引（词 → 位置数组），重建为原文。 */
function oaAbstract(inv: OAWork['abstract_inverted_index']): string {
  if (!inv) return ''
  const words: string[] = []
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w
  return words.filter(Boolean).join(' ').slice(0, 400)
}

function oaLines(w: OAWork): string[] {
  const authors = (w.authorships ?? []).map(a => a.author?.display_name ?? '').filter(Boolean).join(', ') || 'unknown'
  return [
    `• ${w.display_name ?? '(untitled)'}${w.publication_year ? ` (${w.publication_year})` : ''}`,
    `  authors: ${authors}`,
    w.id ? `  openalex_id: ${w.id.replace('https://openalex.org/', '')}` : '',
    w.doi ? `  doi: ${w.doi}` : '',
    ...(w.abstract_inverted_index ? [`  abstract: ${oaAbstract(w.abstract_inverted_index)}`] : []),
  ].filter(Boolean)
}

/** polite pool：留邮箱提升限额，可选环境变量。 */
function oaMailto(): string {
  const e = process.env.OPENALEX_EMAIL
  return e ? `&mailto=${encodeURIComponent(e)}` : ''
}

function oaBareId(id: string): string {
  return id.replace(/^https:\/\/openalex\.org\//, '')
}

async function oaList(url: string): Promise<string> {
  const res = await http(url)
  if (!res.ok) throw new Error(`openalex ${res.status}`)
  const data = (await res.json()) as { results?: OAWork[] }
  const papers = data.results ?? []
  return papers.length === 0 ? '(no results)' : papers.flatMap(oaLines).join('\n')
}

async function oaSearch(query: string, limit: number): Promise<string> {
  return oaList(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${Math.min(limit, 20)}&select=${OA_SELECT}${oaMailto()}`)
}

async function oaWork(id: string): Promise<string> {
  const clean = oaBareId(id)
  const key = /^W\d+$/.test(clean) ? clean : /^10\./.test(clean) ? `doi:${clean}` : clean
  const res = await http(`https://api.openalex.org/works/${encodeURIComponent(key)}?select=${OA_SELECT}${oaMailto()}`)
  if (!res.ok) throw new Error(`openalex ${res.status}`)
  return oaLines((await res.json()) as OAWork).join('\n')
}

async function oaAuthorPapers(authorId: string, limit: number): Promise<string> {
  return oaList(`https://api.openalex.org/works?filter=author.id:${encodeURIComponent(oaBareId(authorId))}&per-page=${Math.min(limit, 20)}&select=${OA_SELECT}${oaMailto()}`)
}

async function oaRelated(paperId: string, limit: number): Promise<string> {
  return oaList(`https://api.openalex.org/works?filter=referenced_works:${encodeURIComponent(oaBareId(paperId))}&per-page=${Math.min(limit, 20)}&select=${OA_SELECT}${oaMailto()}`)
}

/** S2 为主、OpenAlex 兜底；未配 S2 key 直接走 OpenAlex（免 key，无 429 之苦）。 */
async function scholar(primary: () => Promise<string>, fallback: () => Promise<string>): Promise<string> {
  if (!process.env.SEMANTIC_SCHOLAR_API_KEY) return fallback()
  try {
    return await primary()
  } catch (e) {
    try {
      return await fallback()
    } catch {
      throw e
    }
  }
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

/**
 * 追加内置 server（比如由 index.ts 在启动时装配需要访问内部状态的 registry）。
 * 内建于 builtin.ts 之外，但只为打破「内置 server 只能纯函数」的闭环。
 */
export function installBuiltin(name: string, server: { tools: Omit<ToolInfo, 'server'>[]; call: BuiltinServer['call'] }): void {
  (BUILTIN_SERVERS as Record<string, BuiltinServer>)[name] = {
    tools: server.tools.map(t => ({ ...t, server: name })),
    call: server.call,
  }
}

export const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
  core: registry('core', {
    tools: [
      {
        name: 'get_current_time',
        description: "Returns the current time and date, optionally in a IANA timezone (e.g. Asia/Shanghai). Omit tz to get the deployment's local time",
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
        description: 'Search multiple music platforms (NetEase + ccMixter + Jamendo), returns candidates with page/play URLs',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Song / artist keywords' },
            limit: { type: 'number', description: 'Max results per platform (default 5, cap 10 total)' },
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
      if (tool === 'search') {
        const limit = Math.min(numArg(args, 'limit', 5), 10)
        // 并行搜索三源：网易云 + ccMixter + Jamendo
        const [netease, ccmixter, jamendo] = await Promise.allSettled([
          neteaseSearch(query, limit),
          ccMixterSearch(query, limit),
          jamendoSearch(query, limit),
        ])
        const songs: MusicSong[] = []
        if (netease.status === 'fulfilled') songs.push(...netease.value)
        if (ccmixter.status === 'fulfilled') songs.push(...ccmixter.value)
        if (jamendo.status === 'fulfilled') songs.push(...jamendo.value)
        if (songs.length === 0) {
          const errs = [netease, ccmixter, jamendo]
            .filter(r => r.status === 'rejected')
            .map(r => (r as PromiseRejectedResult).reason)
          throw new Error(`all sources failed: ${errs.map(e => e instanceof Error ? e.message : String(e)).join('; ')}`)
        }
        return musicEnvelope('search', songs)
      }
      if (tool === 'play') {
        // play 优先网易云 → Jamendo → ccMixter（外链稳定性递减）
        try {
          return musicEnvelope('play', await neteaseSearch(query, 1))
        } catch {
          try {
            return musicEnvelope('play', await jamendoSearch(query, 1))
          } catch {
            return musicEnvelope('play', await ccMixterSearch(query, 1))
          }
        }
      }
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
        const limit = numArg(args, 'limit', 5)
        return await scholar(() => s2Search(query, limit), () => oaSearch(query, limit))
      }
      if (tool === 'get_paper_details') {
        const id = strArg(args, 'paper_id')
        if (!id) throw new Error('paper_id required')
        return await scholar(() => s2Paper(id), () => oaWork(id))
      }
      if (tool === 'get_author_papers') {
        const id = strArg(args, 'author_id')
        if (!id) throw new Error('author_id required')
        const limit = numArg(args, 'limit', 5)
        return await scholar(() => s2AuthorPapers(id, limit), () => oaAuthorPapers(id, limit))
      }
      if (tool === 'find_related_papers') {
        const id = strArg(args, 'paper_id')
        if (!id) throw new Error('paper_id required')
        const limit = numArg(args, 'limit', 5)
        return await scholar(() => s2Related(id, limit), () => oaRelated(id, limit))
      }
      throw new Error(`unknown builtin tool: scholar/${tool}`)
    },
  }),
}
