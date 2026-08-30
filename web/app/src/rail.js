/**
 * 公共左栏（rail）：所有页面 <aside class="rail" data-rail></aside>，此处注入。
 * 活动态按 pathname 判定；用户牌从 /v1/web/me 取 display_name（401 由 api 层统一回登录页）。
 */
import { api } from './api.js'
import { esc } from './ui.js'

const NAV = [
  { file: 'index.html', gk: 'ΧΑΡΤΗΣ', cn: '星海航图 · Dashboard' },
  { file: 'book.html', gk: 'ΒΙΒΛΟΣ', cn: '记忆书 · Memory Book' },
  { file: 'explorer.html', gk: 'ΧΑΡΤΟΓΡΑΦΟΣ', cn: '记忆制图师 · Explorer' },
  { file: 'observatory.html', gk: 'ΑΣΤΡΟΝΟΜΕΙΟΝ', cn: '观象台 · Observatory' },
  { file: 'forge.html', gk: 'ΧΑΛΚΕΙΟΝ', cn: '锻炉 · Capability Forge' },
  { file: 'console.html', gk: 'ΠΡΥΤΑΝΕΙΟΝ', cn: '控制台 · Console' },
  { file: 'settings.html', gk: 'ΡΥΘΜΙΣΕΙΣ', cn: '调律 · Settings' },
]

export function mountRail() {
  const rail = document.querySelector('aside[data-rail]')
  if (!rail) return
  const current = (location.pathname.split('/').pop() || 'index.html').toLowerCase()
  rail.innerHTML = `
    <div class="brand">
      <div class="brand-mark">
        <svg width="26" height="26" viewBox="0 0 26 26"><path d="M17.5 3.2 A10.3 10.3 0 1 0 22.8 17.5 A8.2 8.2 0 0 1 17.5 3.2 Z" fill="#A8894A" opacity="0.9"/></svg>
        <div>
          <div class="brand-gk">ΜΝΗΜΟΣΥΝΗ</div>
          <div class="brand-la">MNEMOSYNE</div>
        </div>
      </div>
      <div class="brand-tag">Personal AI Runtime · your memory never dies.</div>
    </div>
    <nav class="nav">
      ${NAV.map(n => `
        <a href="${n.file}"${n.file.toLowerCase() === current ? ' class="active"' : ''}>
          <span class="gk">${n.gk}</span><span class="cn">${n.cn}</span>
        </a>`).join('')}
    </nav>
    <div class="rail-foot">
      <div class="user-chip">
        <svg class="moon" width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5" fill="none" stroke="#A8894A" stroke-width="1.2"/><path d="M14.5 4.5 A7 7 0 1 0 17.5 14.5 A5.6 5.6 0 0 1 14.5 4.5 Z" fill="#A8894A" opacity=".85"/></svg>
        <div>
          <div class="name" id="rail-name">…</div>
          <div class="sub"><a href="#" id="rail-logout" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--aegean-deep);">退出登录</a></div>
        </div>
      </div>
      <div class="rail-ver">v0.3.1 · twig @89a7881</div>
    </div>`
  document.getElementById('rail-logout')?.addEventListener('click', e => {
    e.preventDefault()
    import('./api.js').then(m => m.logout())
  })
  api('/v1/web/me')
    .then(me => {
      const el = document.getElementById('rail-name')
      if (el) el.textContent = me.display_name || 'Mnemosyne'
    })
    .catch(() => {
      const el = document.getElementById('rail-name')
      if (el) el.textContent = 'Mnemosyne'
    })
}
