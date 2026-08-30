/**
 * 记忆制图师：/v1/state 三层水位与剖面 + /v1/audit/last 盲推导审计。
 * 上游 audit 记录形状宽松（AuditRecord = {[k:unknown]}），渲染侧做防御式取值，取不到就展示原始 JSON。
 */
import { api } from '../api.js'
import { esc, showPageError, hidePageError, fmtDayTime } from '../ui.js'

const text = v => {
  if (v == null || v === '') return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/* ---------- 水位 ---------- */

function renderCounts(state, claims, auditRecord) {
  document.getElementById('stat-fragments').textContent =
    String(state.totalFragments ?? state.fragments?.length ?? 0)

  const threads = state.threads ?? []
  const highVein = threads.filter(t => Number(t.dragonVein ?? 0) >= 0.8).length
  const longOpen = threads.filter(t => Number(t.daysOpen ?? 0) >= 3).length
  document.getElementById('stat-threads').textContent = String(threads.length)
  document.getElementById('stat-threads-sub').textContent =
    `${highVein} 条 dragonVein 高位 · ${longOpen} 条 daysOpen ≥ 3`

  const active = claims.filter(c => c.status === 'active').length
  const contested = claims.filter(c => c.status === 'contested').length
  const remention = claims.filter(c => c.rementionInvitation && c.rementionInvitation.status !== 'redeemed').length
  document.getElementById('stat-claims').innerHTML = `${active} <small>active</small>`
  document.getElementById('stat-claims-sub').innerHTML =
    `<span style="color:var(--terra)">${contested} contested</span> · ${remention} remention 邀请`

  const record = auditRecord?.record
  if (!record) {
    document.getElementById('stat-drift').textContent = '—'
    document.getElementById('stat-drift-sub').textContent = '尚无审计记录（reflect 内每 7 天自动盲推导）'
    return
  }
  const driftHits = (JSON.stringify(record).match(/drift/gi) ?? []).length
  document.getElementById('stat-drift').textContent = String(driftHits)
  const at = text(record.at) ?? text(record.timestamp) ?? text(record.generatedAt) ?? text(record.date)
  document.getElementById('stat-drift-sub').textContent = `最近盲推导审计：${at ?? '时间未知'}`
}

/* ---------- 层位面板 ---------- */

function claimBadge(c) {
  const map = { active: 'b-ok', contested: 'b-err', window: 'b-info' }
  const labels = { active: 'active', contested: 'contested', window: 'window' }
  const cls = map[c.status] ?? 'b-ghost'
  let html = `<span class="badge ${cls}">${esc(labels[c.status] ?? c.status ?? 'unknown')}</span>`
  if (c.rementionInvitation && c.rementionInvitation.status !== 'redeemed') {
    html += ' <span class="badge b-warn">remention ✉</span>'
  }
  return html
}

function renderClaims(claims) {
  const tbody = document.getElementById('claims-tbody')
  tbody.innerHTML = claims.length
    ? claims.map(c => {
        const conv = Math.max(0, Math.min(1, Number(c.conviction ?? 0)))
        const color = conv >= 0.75 ? 'aegean' : 'gold'
        return `
          <tr>
            <td>${esc(c.text)}</td>
            <td><div class="conv"><div class="bar"><i class="${color}" style="width:${Math.round(conv * 100)}%"></i></div><span class="v">${conv.toFixed(2)}</span></div></td>
            <td class="mono dim">${esc(text(c.boundary) ?? '—')}</td>
            <td>${claimBadge(c)}</td>
          </tr>`
      }).join('')
    : '<tr><td colspan="4" class="stat-sub">认识层还空着 —— 反刍后在此结晶。</td></tr>'
}

function renderThreads(threads) {
  const box = document.getElementById('threads-list')
  box.innerHTML = threads.length
    ? threads.map(t => {
        const vein = Math.max(0, Math.min(1, Number(t.dragonVein ?? 0)))
        const hot = vein >= 0.85 && Number(t.daysOpen ?? 0) >= 3
        const badge = hot
          ? '<span class="badge b-err">vein 高位</span>'
          : `<span class="badge b-ghost">pool: ${esc(text(t.pool) ?? 'general')}</span>`
        return `
          <div class="thread-row">
            <div class="thread-name"><div class="t">${esc(t.label)}</div><div class="s">开放问题：${esc(text(t.openQuestion) ?? '—')}</div></div>
            <div class="vein"><div class="kv" style="border:none;padding:0;"><span class="k mono" style="font-size:9.5px;">vein ${vein.toFixed(2)} · ${t.daysOpen ?? '?'}d</span></div><div class="bar"><i class="${vein >= 0.85 ? 'terra' : 'aegean'}" style="width:${Math.round(vein * 100)}%"></i></div></div>
            ${badge}
          </div>`
      }).join('')
    : '<div class="stat-sub">暂无开放线索。</div>'
}

function renderFragments(state) {
  const tbody = document.getElementById('fragments-tbody')
  const frags = state.fragments ?? []
  document.getElementById('fragments-note').textContent =
    `用户原文 · 第 ${state.page ?? 1} 页，共 ${state.totalFragments ?? frags.length} 条 · ingest ≤4000 字符/chunk`
  tbody.innerHTML = frags.length
    ? frags.map(f => {
        const when = text(f.dateLabel) ?? text(f.date) ?? '—'
        const excerpt = String(f.body ?? f.title ?? '').slice(0, 60)
        const tags = Array.isArray(f.tags) && f.tags.length ? f.tags.map(esc).join(', ') : '—'
        const source = text(f.source) ?? 'chat'
        const badge = source === 'import' ? '<span class="badge b-warn">import</span>' : `<span class="badge b-info">${esc(source)}</span>`
        return `<tr><td class="mono">${esc(when)}</td><td>「${esc(excerpt)}${String(f.body ?? '').length > 60 ? '…' : ''}」</td><td class="mono">${tags}</td><td>${badge}</td></tr>`
      }).join('')
    : '<tr><td colspan="4" class="stat-sub">碎片层暂无内容。</td></tr>'
}

/* ---------- 审计 ---------- */

const ARRAY_KEYS = ['results', 'findings', 'items', 'checks', 'entries', 'comparisons']
const FIELD = (obj, keys) => { for (const k of keys) { const v = text(obj?.[k]); if (v) return v } return null }

function renderAudit(record) {
  const body = document.getElementById('audit-body')
  const feed = document.getElementById('audit-feed')
  const timeEl = document.getElementById('audit-time')
  if (!record) {
    timeEl.textContent = '—'
    body.innerHTML = '<div class="stat-sub">暂无审计记录（reflect 内每 7 天自动盲推导；首次审计完成后在此陈列）。</div>'
    feed.innerHTML = '<div class="stat-sub">—</div>'
    return
  }
  const at = text(record.at) ?? text(record.timestamp) ?? text(record.generatedAt) ?? text(record.date)
  timeEl.textContent = at ? fmtDayTime(at) : '时间未知'
  const rows = ARRAY_KEYS.map(k => (Array.isArray(record[k]) ? record[k] : null)).find(Boolean)

  if (rows?.length && typeof rows[0] === 'object') {
    body.innerHTML = `
      <table class="tbl">
        <thead><tr><th>claim</th><th>盲推结论</th><th>判定</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const claim = FIELD(r, ['claim', 'claimText', 'claim_text', 'text', 'statement']) ?? '—'
            const verdict = FIELD(r, ['blindConclusion', 'conclusion', 'blind', 'reason', 'note', 'detail']) ?? '—'
            const status = (FIELD(r, ['verdict', 'status', 'result', 'type']) ?? '—').toLowerCase()
            const badge = status.includes('drift') ? '<span class="badge b-err">drift</span>'
              : status.includes('watch') ? '<span class="badge b-warn">watch</span>'
              : '<span class="badge b-ok">pass</span>'
            return `<tr><td>${esc(claim)}</td><td class="mono dim">${esc(verdict)}</td><td>${badge}</td></tr>`
          }).join('')}
        </tbody>
      </table>`
  } else {
    body.innerHTML = `
      <div class="stat-sub">上游审计记录为自由结构，以下为原始存档：</div>
      <details class="mt8"><summary class="mono" style="cursor:pointer;font-size:11px;">查看 JSON</summary>
        <pre class="mono" style="font-size:10.5px;color:var(--ink-3);white-space:pre-wrap;">${esc(JSON.stringify(record, null, 2))}</pre>
      </details>`
  }
  feed.innerHTML = `<div class="feed-row"><span class="feed-ts">${esc(at ? fmtDayTime(at) : '—')}</span><span class="feed-tag">audit.last</span><span class="feed-body"><span class="ok">✓</span> 最近一次盲推导审计存档（上游保留最近 20 条）</span></div>`
}

/* ---------- 剖面交互 ---------- */

function setupAnatomy() {
  const layers = ['claims', 'threads', 'fragments']
  const svgIds = { claims: 'lyClaims', threads: 'lyThreads', fragments: 'lyFragments' }
  const show = layer => {
    layers.forEach(l => {
      document.getElementById(`panel-${l}`)?.classList.toggle('hidden', l !== layer)
      document.getElementById(svgIds[l])?.setAttribute('opacity', l === layer ? '1' : '0.55')
    })
  }
  document.querySelectorAll('.anat-layer').forEach(g => g.addEventListener('click', () => show(g.dataset.layer)))
  show('claims')
}

async function main() {
  setupAnatomy()
  try {
    const [state, audit] = await Promise.all([
      api('/v1/web/memory/state?page=1&limit=20'),
      api('/v1/web/memory/audit/last'),
    ])
    const claims = Array.isArray(state.claims) ? state.claims : (await api('/v1/web/memory/claims'))
    hidePageError()
    renderCounts(state, claims, audit)
    renderClaims(claims)
    renderThreads(state.threads ?? [])
    renderFragments(state)
    renderAudit(audit?.record ?? null)
    document.getElementById('reflect-widget').innerHTML =
      `<span class="dot" style="background:var(--olive)"></span>twig 状态读取于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  } catch (e) {
    showPageError(e.message)
  }
}

main()
