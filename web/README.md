# web/ — Y2K Dashboard

Mnemosyne 的 web 前端。浏览器**只对 runtime 说话**（`/v1/web/*` BFF）：`ADMIN_TOKEN`、
twig-memory 凭证、broker token 都不出服务端，浏览器只持有自己的 web `client_key`。

```
web/
├── mockups/          原始静态设计稿（保留存档，勿接后端）
├── app/              Vite MPA 应用（本目录开发）
│   ├── *.html        8 个页面（index/book/explorer/observatory/forge/console/settings/login）
│   ├── public/assets/aegean.css   设计系统（自 mockups 复制）
│   └── src/
│       ├── boot.js   页面启动器：鉴权 → rail → 按页面名加载模块
│       ├── api.js    统一 fetch（X-Client-Key；401 → 登录页）
│       ├── rail.js   公共左栏注入
│       ├── ui.js     esc / 错误横幅 / 格式化
│       └── pages/    index / book / explorer / login 数据逻辑
└── dist/             构建产物（caddy 挂载为 /srv/www，不入库）
```

## 页面接入状态

| 页面 | 状态 | 数据源 |
|---|---|---|
| index 星海航图 | ✅ 实时 | `/v1/web/memory/context` + `/v1/web/metrics/summary` + `/v1/web/feed`（航海图 SVG 为示意插画） |
| book 记忆书 | ✅ 实时 | `/v1/web/memory/journal\|soliloquy\|notes\|stamps` + context |
| explorer 制图师 | ✅ 实时 | `/v1/web/memory/state` + `/v1/web/memory/claims` + `/v1/web/memory/audit/last`（记忆搬家用 CLI） |
| observatory / forge / console / settings | 静态稿 | 待后续阶段（需 admin 聚合端点 / chat 页 / 配置读写） |

## 开发

```bash
cd web/app
npm install
npm run dev        # http://localhost:5173，/v1 反代 127.0.0.1:8000（需 runtime 已启动）
npm run build      # 产物 → web/dist
```

登录：bootstrap 时拿到的 `eternal_id` + `master_key`（会重新签发 web client_key，旧的
web 会话失效），或直接粘贴已有的 `mn_…` client_key。

## 部署

compose 栈里 caddy 挂载 `./web/dist:/srv/www`：构建一次（`npm run build`），Caddy 主域
直接托管静态站并同域反代 `/v1/*`、`/metrics`、`/health` 到 runtime，无 CORS。
