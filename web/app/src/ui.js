/**
 * 公共渲染小件：HTML 转义、错误横幅、日期格式。所有后端数据入 DOM 前必须过 esc()。
 */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 页面顶部一次性错误横幅（后端不可达 / 数据缺失时给出可读状态）。 */
export function showPageError(msg) {
  let el = document.getElementById('page-error')
  if (!el) {
    el = document.createElement('div')
    el.id = 'page-error'
    el.style.cssText =
      'margin:10px 0;padding:10px 14px;border:1px solid var(--terra,#C1663E);border-radius:8px;' +
      'background:rgba(193,102,62,.08);color:var(--ink,#16324A);font:500 12.5px/1.6 var(--f-sans,system-ui);'
    const main = document.querySelector('.main')
    const meander = main?.querySelector('.meander')
    if (meander) meander.after(el)
    else main?.prepend(el)
  }
  el.textContent = `⚠ ${msg}（面板将以留白呈现，稍后可刷新重试）`
}

export function hidePageError() {
  document.getElementById('page-error')?.remove()
}

/** 2026-08-29 → 2026.08.29；非法输入原样返回。 */
export function fmtDate(iso) {
  const s = String(iso ?? '')
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).replaceAll('-', '.') : s
}

/** ISO → 08:02:47（铭文流时间戳）。 */
export function fmtTime(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** ISO → 08-30 04:12（审计时间线）。 */
export function fmtDayTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 1210000 → 1.21M；312000 → 312K。 */
export function fmtTokens(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`
  return String(v)
}
