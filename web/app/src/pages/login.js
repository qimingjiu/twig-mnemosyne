/**
 * 登录页：两条路径——
 *  1) 粘贴现有 web client_key → /v1/identity/session 验证后直接使用（不轮换）；
 *  2) eternal_id + master_key → /v1/web/login 重新签发（UNIQUE(user_id, client_type)，
 *     服务端语义为「找到即轮换」，故该路径可重复使用）。
 */
import { setToken, getToken } from '../api.js'

const errBox = document.getElementById('loginErr')
function showErr(msg) {
  errBox.textContent = msg
  errBox.classList.add('show')
}

function hideErr() {
  errBox.classList.remove('show')
}

async function verifyExistingKey(key) {
  const res = await fetch('/v1/identity/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Key': key },
    body: '{}',
  })
  if (!res.ok) throw new Error('client_key 无效或已轮换')
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault()
  hideErr()

  const pastedKey = document.getElementById('clientKey').value.trim()
  if (pastedKey) {
    try {
      await verifyExistingKey(pastedKey)
      setToken(pastedKey)
      location.href = '/index.html'
    } catch (err) {
      showErr(err.message)
    }
    return
  }

  const eternalId = document.getElementById('eternalId').value.trim()
  const masterKey = document.getElementById('masterKey').value
  if (!/^[a-f0-9]{64}$/i.test(eternalId)) return showErr('eternal_id 必须是 64 位十六进制（bootstrap 输出）')
  if (masterKey.length < 8) return showErr('master_key 至少 8 位')

  const btn = document.getElementById('submitBtn')
  btn.disabled = true
  btn.textContent = '验证中…'
  try {
    const res = await fetch('/v1/web/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_eternal_id: eternalId.toLowerCase(), master_key: masterKey }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const map = {
        invalid_credential: '凭证错误（eternal_id 或 master_key 不对）',
        rate_limited: '尝试过多，请 15 分钟后再试（T1.5）',
      }
      throw new Error(map[data?.error?.code] ?? data?.error?.message ?? `登录失败（HTTP ${res.status}）`)
    }
    setToken(data.client_key)
    location.href = '/index.html'
  } catch (err) {
    showErr(err.message)
  } finally {
    btn.disabled = false
    btn.textContent = '进入星海航图'
  }
})

// 已登录则直接进（刷新登录页不强制重登）
if (getToken()) {
  location.replace('/index.html')
}
