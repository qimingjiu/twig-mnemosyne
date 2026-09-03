/**
 * 控制台：对话面（真流式 /v1/chat/completions）+ 24h 运行真数据。
 *
 * web 是 identity 体系里 client_type='web' 的一等客户端：浏览器持自己的 client_key，
 * 经 Caddy 同域反代直连 chat 端点（凭证不出浏览器的设计边界内）。不传 x-eternal-session-id，
 * runtime 按 user+session_type 复用 active personal session——与 Telegram 共享同一段关系上下文。
 */
import { api, getToken, logout } from '../api.js'
import { esc, fmtTokens } from '../ui.js'

const scroll = document.getElementById('chat-scroll')
const input = document.getElementById('chat-input')
const sendBtn = document.getElementById('chat-send')
const modelSel = document.getElementById('chat-model')

let history = [] // [{role, content}] 页面内多轮；runtime 侧按共享 session 另有完整装配
let streaming = false

function scrollBottom() {
  scroll.scrollTop = scroll.scrollHeight
}

function addBubble(role, text) {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.textContent = text
  scroll.appendChild(el)
  scrollBottom()
  return el
}

function addMetaChips(bubble, meta, model) {
  const row = document.createElement('div')
  row.className = 'msg-meta'
  const chips = []
  if (model) chips.push(model)
  if (meta?.tool_executed || meta?.tool_pending) chips.push(`tool ${meta.tool_executed ?? 0}✓/${meta.tool_pending ?? 0}⏳`)
  if (meta?.cache_hit_type && meta.cache_hit_type !== 'miss') chips.push(`cache ${meta.cache_hit_type}`)
  if (meta?.fallback_count > 0) chips.push(`fallback ×${meta.fallback_count}`)
  row.innerHTML = chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')
  if (chips.length) bubble.appendChild(row)
}

function addMusicCard(bubble, songs) {
  for (const s of songs) {
    const card = document.createElement('div')
    card.className = 'music-card'
    card.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20"><path d="M7 16.5V5.2l9-2v11.3" fill="none" stroke="#8C6F38" stroke-width="1.4" stroke-linejoin="round"/><circle cx="5.4" cy="16.4" r="2.1" fill="none" stroke="#8C6F38" stroke-width="1.4"/><circle cx="14.4" cy="14.4" r="2.1" fill="none" stroke="#8C6F38" stroke-width="1.4"/></svg>
      <div style="flex:1"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist ?? '')}</div></div>
      ${s.page_url ? `<a href="${esc(s.page_url)}" target="_blank" rel="noopener">来源</a>` : ''}
      ${s.play_url ? `<a href="${esc(s.play_url)}" target="_blank" rel="noopener">播放</a>` : ''}`
    bubble.appendChild(card)
  }
}

function addAudioNote(bubble) {
  const note = document.createElement('div')
  note.className = 'msg-meta'
  note.innerHTML = '<span class="chip">🎙 语音版已生成 · 请在 Telegram 收听</span>'
  bubble.appendChild(note)
}

async function send() {
  const text = input.value.trim()
  if (!text || streaming) return
  document.getElementById('chat-empty')?.remove()
  input.value = ''
  input.style.height = 'auto'
  history.push({ role: 'user', content: text })
  addBubble('user', text)

  streaming = true
  sendBtn.disabled = true
  const bubble = addBubble('assistant', '')
  bubble.classList.add('streaming')

  let acc = ''
  const model = modelSel.value || undefined
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Key': getToken() },
      body: JSON.stringify({ messages: history, stream: true, ...(model ? { model } : {}) }),
    })
    if (res.status === 401) { logout(); return } // 清掉失效 key：裸跳转会被 login 的已登录守卫弹回，形成三连跳
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
    }

    // SSE 解析（chunk 协议：content delta / attachments / audio / mnemosyne / usage 扩展帧 + [DONE]）
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let done = false
    let upstreamModel = ''
    let audioNote = false
    const attachments = []
    let meta = null
    for (;;) {
      const { done: eof, value } = await reader.read()
      if (eof) break
      buf += dec.decode(value, { stream: true })
      let sep
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { done = true; break }
          let chunk
          try { chunk = JSON.parse(data) } catch { continue }
          if (chunk.error) throw new Error(chunk.error.message ?? '上游错误')
          upstreamModel = upstreamModel || chunk.model || ''
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) {
            acc += delta
            bubble.textContent = acc
            bubble.classList.add('streaming')
            scrollBottom()
          }
          if (chunk.attachments) attachments.push(...chunk.attachments)
          if (chunk.audio) audioNote = true
          if (chunk.mnemosyne) meta = chunk.mnemosyne
        }
        if (done) break
      }
      if (done) break
    }

    bubble.classList.remove('streaming')
    if (!acc && attachments.length === 0 && !audioNote) bubble.textContent = '（本次没有文本回复）'
    if (attachments.length) addMusicCard(bubble, attachments.filter(a => a.kind === 'music'))
    if (audioNote) addAudioNote(bubble)
    addMetaChips(bubble, meta, upstreamModel)
    history.push({ role: 'assistant', content: acc })
  } catch (e) {
    bubble.classList.remove('streaming')
    if (!bubble.textContent) bubble.textContent = '（本次没有回复）'
    const row = document.createElement('div')
    row.className = 'msg-meta'
    row.innerHTML = `<span class="chip" style="color:var(--terra);border-color:var(--terra)">出错 · ${esc(e.message)}</span>`
    bubble.appendChild(row)
    history.push({ role: 'assistant', content: acc || '（出错轮次）' })
  } finally {
    streaming = false
    sendBtn.disabled = false
    input.focus()
  }
}

/* ── 右栏：24h 真数据（/v1/web/metrics/summary） ── */
async function renderOps() {
  try {
    const s = await api('/v1/web/metrics/summary')

    document.getElementById('ops-chain').innerHTML = (s.default_chain ?? [])
      .map((m, i) => i === 0 ? esc(m) : `<span style="color:var(--gold)"> → </span>${esc(m)}`)
      .join('') || '—'

    const provBox = document.getElementById('ops-providers')
    provBox.innerHTML = (s.providers ?? []).map(p => {
      const errPct = Math.round((p.error_rate ?? 0) * 1000) / 10
      const badge = errPct >= 2
        ? '<span class="badge b-warn">watch</span>'
        : '<span class="badge b-ok">healthy</span>'
      return `<div style="display:flex;justify-content:space-between;align-items:center;font:400 12px var(--f-body);">
        <span style="font:500 12px var(--f-mono);color:var(--ink)">${esc(p.provider)}</span>
        <span style="display:flex;gap:10px;align-items:center;">
          <span class="mono" style="color:var(--ink-3)">${p.calls} 次 · ${p.avg_latency_ms ?? '—'}ms</span>
          ${badge}
        </span>
      </div>`
    }).join('') || '<div class="stat-sub">24h 内没有模型调用</div>'

    document.getElementById('ops-cache-rate').innerHTML =
      `${Math.round((s.cache_hit_rate ?? 0) * 100)}<small>% 自建命中率</small>`
    document.getElementById('ops-cache-read').textContent = fmtTokens(s.tokens?.cache_read)
    document.getElementById('ops-cache-saved').textContent = fmtTokens(s.tokens?.saved)

    const delivered = s.outreach?.delivered_today ?? 0
    const cap = s.outreach?.daily_cap ?? 0
    document.getElementById('ops-outreach-quota').innerHTML = `${delivered}<small> / ${cap} slots</small>`
    document.getElementById('ops-outreach-bar').style.width = `${cap > 0 ? Math.min(100, (delivered / cap) * 100) : 0}%`
  } catch {
    // api 层 401 已跳登录；其余错误面板留白即可（对话不受影响）
  }
}

/* ── 模型选择器（§6.4 注册表） ── */
async function renderModelOptions() {
  try {
    const list = await api('/v1/models')
    const ids = (list.data ?? []).map(m => m.id).sort()
    for (const id of ids) {
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = id
      modelSel.appendChild(opt)
    }
  } catch { /* 选择器留默认档 */ }
}

/* ── 交互 ── */
sendBtn.addEventListener('click', send)
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`
})
document.getElementById('chat-clear').addEventListener('click', () => {
  history = []
  scroll.innerHTML = '<div class="chat-empty" id="chat-empty"><div class="gk">ΛΟΓΟΣ ΠΡΩΤΟΣ</div><div class="sub">清屏只影响这个页面——他记得的，一点都没少。</div></div>'
})

renderOps()
renderModelOptions()
input.focus()
