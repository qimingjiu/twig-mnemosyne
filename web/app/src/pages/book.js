/**
 * 记忆书：日记 / 心迹（twig export 全量，倒序陈列）、便签（分页）、拾贝（recentStamps）与珊瑚（threads）。
 */
import { api } from '../api.js'
import { esc, showPageError, hidePageError, fmtDate } from '../ui.js'
import { moonPhase } from '../clock.js'

function splitEntry(content) {
  const lines = String(content ?? '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const first = lines[0] ?? ''
  // 短且不以句号收束的首行视作标题（reflect 生成稿通常首段即叙事，不会命中）
  if (first && first.length <= 24 && !/[。！？.!?…]$/.test(first)) {
    return { title: first, body: lines.slice(1) }
  }
  return { title: '', body: lines }
}

function journalStele(entry, kind) {
  const { title, body } = splitEntry(entry.content)
  const { icon } = moonPhase(new Date(`${entry.date}T12:00:00`))
  const bodyHtml = esc(body.join('\n\n')).replaceAll('\n\n', '<br><br>')
  return `
    <article class="stele">
      <div class="stele-head">
        <div class="stele-date">${esc(kind)} · ${esc(fmtDate(entry.date))}</div>
        ${title ? `<div class="stele-title">${esc(title)}</div>` : ''}
      </div>
      <div class="stele-body">${bodyHtml || '（空）'}</div>
      <div class="stele-foot"><span class="mono">${esc(kind === 'ΗΜΕΡΑ' ? 'journal' : 'soliloquy')} · 引擎书写</span><span class="mono">${icon}</span></div>
    </article>`
}

function noteStele(n) {
  const badge = n.status === 'unread'
    ? '<span class="badge b-warn">未读</span>'
    : n.status === 'read'
      ? '<span class="badge b-ok">已读</span>'
      : '<span class="badge b-ghost">archived</span>'
  return `
    <article class="stele">
      <div class="stele-head"><div class="stele-date">ΣΗΜΕΙΟΝ · ${esc(fmtDate(n.date))}</div></div>
      <div class="stele-body">${esc(n.content).replaceAll('\n', '<br>')}</div>
      <div class="stele-foot"><span class="mono">note · 用户手记</span>${badge}</div>
    </article>`
}

function shellItem(s) {
  return `
    <div class="shell-item">
      <svg width="42" height="42" viewBox="0 0 42 42"><g fill="none" stroke="#8C6F38" stroke-width="1.5" stroke-linecap="round"><path d="M21 34 L9 16 A13 13 0 0 1 33 16 Z"/><path d="M21 34 L13.5 8.5 M21 34 L21 6.5 M21 34 L28.5 8.5"/><path d="M17.5 36.5 H24.5"/></g></svg>
      <div class="shell-name">${esc(s.beadName)} ·「${esc(String(s.notePreview ?? '').slice(0, 16))}」</div>
      <div class="shell-note">${esc(s.type)} 印 · 玻璃珠入盏</div>
      <div class="shell-date">${esc(fmtDate(s.date))}</div>
    </div>`
}

const CORAL_SVG = (scale, opacity) => `
  <svg width="100" height="96" viewBox="0 0 100 96"><g transform="translate(50 94) scale(${scale}) translate(-50 -94)" opacity="${opacity}"><g fill="none" stroke="#C1663E" stroke-width="2.4" stroke-linecap="round"><path d="M50 94 V58"/><path d="M50 66 Q38 58 34 44"/><path d="M50 62 Q62 56 66 42"/><path d="M34 44 Q28 38 28 28"/><path d="M34 44 Q40 38 41 30"/><path d="M66 42 Q72 36 73 27"/><path d="M50 58 Q56 48 55 38"/><path d="M55 38 Q52 30 54 22"/></g><g fill="#C1663E"><circle cx="28" cy="26" r="2.2"/><circle cx="41" cy="28" r="2.2"/><circle cx="73" cy="25" r="2.2"/><circle cx="54" cy="20" r="2.2"/><circle cx="66" cy="40" r="2"/><circle cx="34" cy="42" r="2"/></g></g></svg>`

function reefItem(t, i) {
  const scales = [1.05, 0.85, 0.62]
  const s = scales[i % scales.length]
  return `
    <div class="reef-item">
      ${CORAL_SVG(s, s >= 1 ? 1 : 0.45)}
      <div class="reef-name">${esc(t.label)}</div>
      <div class="reef-meta">开放 ${t.daysOpen ?? '?'} 天${(t.daysOpen ?? 0) >= 10 ? ' · <span style="color:var(--terra)">久未归航</span>' : ''} · vein ${Number(t.dragonVein ?? 0).toFixed(2)}</div>
    </div>`
}

async function renderJournal() {
  const box = document.getElementById('journal-list')
  try {
    const { entries } = await api('/v1/web/memory/journal/export')
    const sorted = (entries ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 9)
    box.innerHTML = sorted.length
      ? sorted.map(e => journalStele(e, 'ΗΜΕΡΑ')).join('')
      : '<div class="stat-sub">还没有日记 —— reflect 时由引擎写成（§8.2），或在上游 POST /v1/journal/generate 生成。</div>'
  } catch (e) {
    box.innerHTML = `<div class="stat-sub">日记加载失败：${esc(e.message)}</div>`
  }
}

async function renderSoliloquy() {
  const box = document.getElementById('soliloquy-list')
  try {
    const { entries } = await api('/v1/web/memory/soliloquy/export')
    const sorted = (entries ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6)
    box.innerHTML = sorted.length
      ? sorted.map(e => journalStele(e, 'ΜΟΝΟΛΟΓΟΣ')).join('')
      : '<div class="stat-sub">心迹尚空 —— 引擎的独白由上游 soliloquy 服务书写。</div>'
  } catch (e) {
    box.innerHTML = `<div class="stat-sub">心迹加载失败：${esc(e.message)}</div>`
  }
}

async function renderNotes() {
  const box = document.getElementById('notes-list')
  try {
    const { notes } = await api('/v1/web/memory/notes?page=1&limit=12')
    box.innerHTML = (notes ?? []).length
      ? notes.map(noteStele).join('')
      : '<div class="stat-sub">还没有便签 —— 小事值得自己写下来。</div>'
  } catch (e) {
    box.innerHTML = `<div class="stat-sub">便签加载失败：${esc(e.message)}</div>`
  }
}

async function renderShells() {
  const grid = document.getElementById('shells-grid')
  const reef = document.getElementById('reef-row')
  try {
    const [{ recent }, packet] = await Promise.all([
      api('/v1/web/memory/stamps/recent?limit=8'),
      api('/v1/web/memory/context'),
    ])
    grid.innerHTML = (recent ?? []).length
      ? recent.map(shellItem).join('')
      : '<div class="stat-sub">还没有盖印 —— 给便签盖一枚印章，玻璃珠就会入盏。</div>'
    const threads = (packet.threads ?? []).slice().sort((a, b) => Number(b.dragonVein ?? 0) - Number(a.dragonVein ?? 0)).slice(0, 3)
    reef.innerHTML = threads.length ? threads.map((t, i) => reefItem(t, i)).join('') : '<div class="stat-sub">珊瑚礁还空着 —— 线索由反刍生成。</div>'
  } catch (e) {
    grid.innerHTML = `<div class="stat-sub">拾贝加载失败：${esc(e.message)}</div>`
    reef.innerHTML = ''
  }
}

const RENDERERS = {
  journal: () => renderJournal(),
  soliloquy: () => renderSoliloquy(),
  notes: () => renderNotes(),
  shells: () => renderShells(),
}

function setupTabs() {
  const loaded = new Set()
  document.getElementById('bookTabs').addEventListener('click', e => {
    const btn = e.target.closest('button')
    if (!btn) return
    document.querySelectorAll('#bookTabs button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
    const tab = btn.dataset.tab
    if (!loaded.has(tab)) {
      loaded.add(tab)
      RENDERERS[tab]?.()
    }
  })
  return loaded
}

/* ---------- 便签写作（POST /v1/web/memory/notes，BFF 模式） ---------- */
function setupNoteComposer() {
  const toggle = document.getElementById('note-compose-toggle')
  const panel = document.getElementById('note-compose')
  const content = document.getElementById('note-content')
  const msg = document.getElementById('note-msg')
  const submit = document.getElementById('note-submit')
  toggle.addEventListener('click', () => {
    panel.classList.toggle('hidden')
    if (!panel.classList.contains('hidden')) content.focus()
  })
  document.getElementById('note-cancel').addEventListener('click', () => {
    panel.classList.add('hidden')
    msg.textContent = ''
  })
  submit.addEventListener('click', async () => {
    const text = content.value.trim()
    if (!text) { msg.textContent = '写点什么再放进来。'; return }
    submit.disabled = true
    try {
      await api('/v1/web/memory/notes', { method: 'POST', body: { content: text } })
      content.value = ''
      msg.textContent = ''
      panel.classList.add('hidden')
      await renderNotes() // 就地刷新，无需整页
    } catch (e) {
      msg.textContent = `放入失败：${e.message}`
    } finally {
      submit.disabled = false
    }
  })
}

async function main() {
  const loaded = setupTabs()
  setupNoteComposer()
  try {
    await renderJournal()
    loaded.add('journal')
    hidePageError()
  } catch (e) {
    showPageError(e.message)
  }
}

main()
