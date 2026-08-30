/**
 * 星海航图（Dashboard）：context packet → 线索/拾贝；metrics summary → 指标四联；feed → 铭文流。
 */
import { api } from '../api.js'
import { esc, showPageError, hidePageError, fmtTime, fmtTokens } from '../ui.js'

const BAR_COLORS = ['aegean', 'gold', 'olive', 'terra']

function threadRow(t) {
  const vein = Math.max(0, Math.min(1, Number(t.dragonVein ?? 0)))
  const color = (t.daysOpen ?? 0) >= 10 ? 'terra' : 'aegean'
  const sub = `开放 ${t.daysOpen ?? '?'} 天${(t.daysOpen ?? 0) >= 10 ? ' · 久未归航' : ''}`
  return `
    <div class="thread-row">
      <div class="thread-name"><div class="t">${esc(t.label)}</div><div class="s">${esc(sub)}${t.openQuestion ? ` · ${esc(t.openQuestion)}` : ''}</div></div>
      <div class="vein"><div class="bar"><i class="${color}" style="width:${Math.round(vein * 100)}%"></i></div></div>
      <span class="mono" style="font:500 11px var(--f-mono);color:var(--${color})">${vein.toFixed(2)}</span>
    </div>`
}

function renderThreads(packet) {
  const box = document.getElementById('threads-list')
  const threads = (packet.threads ?? []).slice().sort((a, b) => Number(b.dragonVein ?? 0) - Number(a.dragonVein ?? 0))
  box.innerHTML = threads.length
    ? threads.map(threadRow).join('')
    : '<div class="stat-sub">暂无开放线索 —— 静水深流。</div>'
}

function renderShells(packet) {
  const box = document.getElementById('shells-list')
  const rows = []
  for (const f of (packet.recentFragments ?? []).slice(0, 4)) {
    const date = String(f.date ?? '').slice(5).replace('-', '.')
    rows.push(`<div class="kv"><span class="k">🐚 ${esc(f.title ?? f.id)}</span><span class="v">${esc(date)}</span></div>`)
  }
  for (const s of (packet.recentStamps ?? []).slice(0, 2)) {
    rows.push(`<div class="kv"><span class="k">🪸 ${esc(s.beadName)} · ${esc(s.notePreview ?? '')}</span><span class="v" style="color:var(--olive)">盖印</span></div>`)
  }
  box.innerHTML = rows.length ? rows.join('') : '<div class="stat-sub">潮退未久，滩上还空着。</div>'
}

function renderCache(summary) {
  const hits = Object.entries(summary.cache_breakdown ?? {}).filter(([k]) => k !== 'miss' && k !== 'none')
  document.getElementById('stat-cache').innerHTML = `${Math.round((summary.cache_hit_rate ?? 0) * 100)}<small>%</small>`
  const total = hits.reduce((s, [, n]) => s + n, 0)
  const bar = document.getElementById('stat-cache-bar')
  const legend = document.getElementById('stat-cache-legend')
  if (!total) {
    bar.innerHTML = ''
    legend.innerHTML = '<span>24h 内暂无缓存命中</span>'
    return
  }
  bar.innerHTML = hits
    .map(([k, n], i) => `<i class="${BAR_COLORS[i % BAR_COLORS.length]}" style="width:${(n / total) * 100}%"></i>`)
    .join('')
  legend.innerHTML = hits
    .map(([k, n], i) => `<span><i style="background:var(--${BAR_COLORS[i % BAR_COLORS.length]})"></i>${esc(k)} ${n}</span>`)
    .join('')
}

function renderProviders(summary) {
  const box = document.getElementById('stat-providers')
  const rows = (summary.providers ?? []).map(p => {
    const cls = p.error_rate < 0.02 ? 'ok' : p.error_rate < 0.05 ? 'warn' : 'err'
    const lat = p.avg_latency_ms != null ? `${(p.avg_latency_ms / 1000).toFixed(1)}s` : '—'
    return `<div class="kv"><span class="k"><span class="dot ${cls}"></span> ${esc(p.provider)}</span><span class="v">${lat} · ${(p.error_rate * 100).toFixed(1)}%</span></div>`
  })
  box.innerHTML = rows.length ? rows.join('') : '<div class="stat-sub">24h 内无模型调用</div>'
  if (summary.default_chain?.length) {
    document.getElementById('providers-sub').textContent = `fallback：${summary.default_chain.join(' → ')}`
  }
}

function renderMetrics(summary) {
  document.getElementById('metrics-note').textContent =
    `/v1/web/metrics/summary · ${summary.requests_total ?? 0} req · avg ${summary.avg_latency_ms != null ? `${summary.avg_latency_ms}ms` : '—'}`
  renderCache(summary)
  renderProviders(summary)
  const tok = summary.tokens ?? {}
  document.getElementById('stat-tokens').innerHTML = `${fmtTokens(tok.in)}<small> in</small>`
  document.getElementById('tok-out').textContent = fmtTokens(tok.out)
  document.getElementById('tok-saved').textContent = fmtTokens(tok.saved)
  document.getElementById('tok-write').textContent = fmtTokens(tok.cache_write)
  document.getElementById('stat-cost').textContent = `$${(summary.cost_usd ?? 0).toFixed(2)}`
  document.getElementById('cost-saved').textContent = `$${(summary.savings_usd ?? 0).toFixed(2)}`
  const chars = summary.tts_chars_month ?? 0
  const pct = Math.min(100, (chars / (summary.tts_budget_chars ?? 10_000)) * 100)
  const barEl = document.getElementById('tts-bar')
  barEl.style.width = `${pct}%`
  barEl.className = chars > (summary.tts_alert_chars ?? 8_000) ? 'terra' : 'gold'
  document.getElementById('tts-sub').textContent =
    `${chars.toLocaleString()} / ${(summary.tts_budget_chars ?? 10_000).toLocaleString()} · 超过 ${(summary.tts_alert_chars ?? 8_000).toLocaleString()} 告警`
  const o = summary.outreach ?? {}
  document.getElementById('outreach-today').textContent = (o.daily_cap ?? 0) > 0 ? `${o.delivered_today ?? 0} / ${o.daily_cap}` : '关'
}

function feedRow(ev) {
  const mark = !ev.ok ? '<span class="warn">✕</span> ' : ev.tag.startsWith('huginn.') ? '<span class="ok">✓</span> ' : ''
  return `<div class="feed-row"><span class="feed-ts">${esc(fmtTime(ev.ts))}</span><span class="feed-tag">${esc(ev.tag)}</span><span class="feed-body">${mark}${esc(ev.body)}</span></div>`
}

function renderFeed(feed) {
  document.getElementById('feed-list').innerHTML = (feed.events ?? []).length
    ? feed.events.map(feedRow).join('')
    : '<div class="stat-sub">最近尚无事件 —— 说句话，让引擎开始航行。</div>'
  const o = feed.outreach ?? {}
  if ((o.daily_cap ?? 0) > 0) {
    document.getElementById('outreach-today').textContent = `${o.delivered_today ?? 0} / ${o.daily_cap}`
  }
}

async function main() {
  try {
    const [packet, summary, feed] = await Promise.all([
      api('/v1/web/memory/context'),
      api('/v1/web/metrics/summary'),
      api('/v1/web/feed?limit=40'),
    ])
    hidePageError()
    renderThreads(packet)
    renderShells(packet)
    renderMetrics(summary)
    renderFeed(feed)
  } catch (e) {
    showPageError(e.message)
  }
}

main()
