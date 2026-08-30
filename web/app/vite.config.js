import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// MPA：7 个页面 + 登录页；开发时 /v1/*、/metrics、/health 反代到本地 runtime。
// 生产由 Caddy 托管 dist/ 并做同样的反代（见根目录 Caddyfile）。
const page = name => resolvePage(`${name}.html`)

function resolvePage(file) {
  return fileURLToPath(new URL(file, import.meta.url))
}

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:8000',
      '/metrics': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
    },
  },
  build: {
    // 产物落在 web/dist（docker-compose caddy 挂载 ./web/dist:/srv/www）
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: page('index'),
        book: page('book'),
        explorer: page('explorer'),
        observatory: page('observatory'),
        forge: page('forge'),
        console: page('console'),
        settings: page('settings'),
        login: page('login'),
      },
    },
  },
})
