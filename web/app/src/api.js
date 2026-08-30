/**
 * 统一 API 层：client_key 存 localStorage；所有请求带 X-Client-Key。
 * 401 → 清凭证回登录页；错误消息已由 BFF 脱敏（twig 细节不透传）。
 */
const TOKEN_KEY = 'mn_client_key'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(key) {
  localStorage.setItem(TOKEN_KEY, key)
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  location.href = '/login.html'
}

/** 页面模块首行调用：无凭证直接去登录页。 */
export function requireAuth() {
  if (!getToken()) location.replace('/login.html')
}

export async function api(path, opts = {}) {
  const token = getToken()
  if (!token) {
    location.replace('/login.html')
    throw new Error('未登录')
  }
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Client-Key': token },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 401) {
    logout()
    throw new Error('会话失效，请重新登录')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const type = data?.error?.type
    const msg = type === 'twig_error' || type === 'twig_unreachable'
      ? '记忆服务暂不可达'
      : (data?.error?.message ?? `HTTP ${res.status}`)
    throw new Error(msg)
  }
  return data
}
