/**
 * 页面启动器：所有页面只挂这一个入口。
 * 1) 未登录（除 login 页）→ 跳登录；2) 注入公共 rail + 时钟；3) 按页面名加载对应模块。
 */
import { getToken } from './api.js'

const PAGE_MODULES = {
  index: () => import('./pages/index.js'),
  book: () => import('./pages/book.js'),
  explorer: () => import('./pages/explorer.js'),
  login: () => import('./pages/login.js'),
}

async function boot() {
  const name = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/i, '') || 'index'
  const isLogin = name === 'login'

  if (!isLogin && !getToken()) {
    location.replace('/login.html')
    return
  }

  const [{ mountRail }, { startClock }] = await Promise.all([import('./rail.js'), import('./clock.js')])
  mountRail()
  startClock()

  const load = PAGE_MODULES[name]
  if (load) await load()
}

boot()
