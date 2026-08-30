/** 顶栏时钟 + 月相（index 用）。无 #clock/#moonphase 的页面自动跳过。 */
const SYNODIC = 29.530588853
// 参考新月：2000-01-06 18:14 UTC
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14)
const PHASE_NAMES = ['新月', '娥眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月']
const PHASE_ICONS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘']

export function moonPhase(d = new Date()) {
  const days = (d.getTime() - KNOWN_NEW_MOON) / 86_400_000
  const frac = (((days % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC
  const idx = Math.round(frac * 8) % 8
  return { name: PHASE_NAMES[idx], icon: PHASE_ICONS[idx], frac }
}

export function startClock() {
  const clock = document.getElementById('clock')
  const moonEl = document.getElementById('moonphase')
  const tick = () => {
    const d = new Date()
    if (clock) {
      clock.textContent = [d.getHours(), d.getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
    }
    if (moonEl) {
      const p = moonPhase(d)
      moonEl.innerHTML = `<span style="font-size:12px">${p.icon}</span> ${p.name}`
    }
  }
  tick()
  setInterval(tick, 30_000)
}
