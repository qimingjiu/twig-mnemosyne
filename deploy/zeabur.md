# Zeabur 部署（阿里云 HK 2C4G 专用服务器）

> 上游 muninn 本就是 Zeabur 原生形态（Dockerfile 注释见 twig-memory 仓库）。
> 本手册把 §13.3 的 compose 栈映射为 Zeabur 服务。**本地无需 Docker。**

## 服务清单（创建顺序即依赖顺序）

| # | 服务 | 来源 | 端口 | 公网域名 |
|---|------|------|------|----------|
| 1 | `postgres` | 镜像 `pgvector/pgvector:pg16` | 5432 | ❌ 仅私有网络 |
| 2 | `redis` | 镜像 `redis:7-alpine` | 6379 | ❌ 仅私有网络 |
| 3 | `twig-memory` | GitHub `qimingjiu/twig-memory` @ main（v0.3.1 补丁已推送，Zeabur repo id `1327399926`） | 7300 | ❌ 仅私有网络 |
| 4 | `litellm` | GitHub 本仓库 + `deploy/litellm/Dockerfile`（配置烤入镜像） | 4000 | ❌ 仅私有网络 |
| 5 | `mnemosyne` | GitHub 本仓库 + `deploy/mnemosyne.Dockerfile`（repo 根上下文，config/ 与 migrations 打入镜像） | 8000 | ✅ 唯一暴露公网的服务（AI client 入口） |

> 网络原则（§13.3 的 Zeabur 等价物）：只有 mnemosyne 绑定公网域名；postgres/redis/twig/litellm 一律私有地址。Twig 的全局令牌仍必须设置——私有网络不是免除认证的理由（T8.10 启动断言照常生效）。
> Caddy 不需要：Zeabur 边缘自带 TLS/域名；限流职责在应用层（per client_key + per IP）。
> 2C4G 常驻内存 ≈2.5–3.2GB（§13.1.1），专用服务器包月内，无按容器计费。

## 环境变量分工

**我方生成（随机密钥，部署时由 CLI/MCP 写入）：**
`ENCRYPTION_KEY`（32B base64）、`CONFIRM_SECRET`、`BROKER_INTERNAL_TOKEN`、`BOOTSTRAP_TOKEN`、`MUNINN_AUTH_TOKEN`、`DB_PASSWORD`、`LITELLM_MASTER_KEY`

**需要你提供（第三方 API key）：**

| 变量 | 服务 | 必需性 |
|---|---|---|
| `KIMI_API_KEY` | twig-memory | 必需（叙事引擎 LLM） |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` | litellm | 至少一个；决定 fallback 链可用性 |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | mnemosyne | 可选（TTS；缺省静默降级为文字） |
| `GOOGLE_TTS_API_KEY` | mnemosyne | 可选 |

> keys 可以对话里给我（我只写入 Zeabur 服务环境变量），也可以部署后你自己在控制台填/轮换——**控制台轮换更安全**，推荐后者：我先留空部署，服务起不来时再填。

## 每服务环境变量（除上表外）

- `postgres`：`POSTGRES_USER=mnemosyne`、`POSTGRES_PASSWORD=${DB_PASSWORD}`、`POSTGRES_DB=mnemosyne`
- `twig-memory`：`PORT=7300`、`MUNINN_AUTH_TOKEN`、`MUNINN_DATA_DIR=/data`、`MUNINN_TZ=Asia/Shanghai`、`KIMI_API_KEY`
- `litellm`：`LITELLM_MASTER_KEY`、各 provider key、`OLLAMA_API_BASE` 可不设（本地 lane 形态 A 时指向 tailnet）
- `mnemosyne`：`DATABASE_URL`、`REDIS_URL`、`TWIG_URL`、`MUNINN_AUTH_TOKEN`、`LITELLM_URL`、`LITELLM_API_KEY`、`ENCRYPTION_KEY`、`CONFIRM_SECRET`、`BROKER_INTERNAL_TOKEN`、`BOOTSTRAP_TOKEN`、`ADMIN_TOKEN`、`NODE_ENV=production`
  - 各 URL 用 Zeabur 控制台显示的**私有地址**（形如 `xxx.zeabur.internal`），不要用公网域名回环。
- 数据持久化：postgres / redis / twig 三服务各挂一块持久卷（twig 挂 `/data`——叙事数据在这里，**必须先买卷再启动**，见 §13.6 备份策略；备份 runbook 的 pg_dump/tar 逻辑不变，宿主机换成 Zeabur 卷快照 + 定期 dump）。

## 部署后验收

```bash
# 1. 健康链（mnemosyne 生产模式自检 twig auth=true，断言失败即拒启）
curl https://<mnemosyne-domain>/health
# 2. bootstrap 首个用户（BOOTSTRAP_TOKEN 一次性；Zeabur 控制台 → mnemosyne → Terminal）
node dist/scripts/bootstrap.js --email <email> --name 杳晦 --master-key <口令> --token $BOOTSTRAP_TOKEN
# 3. 集成测试（镜像含 dev 依赖；连私有 postgres）
TEST_DATABASE_URL=postgresql://mnemosyne:$DB_PASSWORD@<postgres私有地址>:5432/mnemosyne \
  npx vitest run test/integration
# 4. 一轮真实对话 + 危机词预扫验证
curl -X POST https://<mnemosyne-domain>/v1/chat/completions \
  -H "Authorization: Bearer mn_..." -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"在吗"}]}'
```

## 已知差异（相对 VPS compose 路线）

- 无 Caddy：TLS/域名由 Zeabur 边缘承担；`deploy/compose/Caddyfile` 仅 VPS/compose 路线使用。
- mcp-gateway：已并入本仓库（自有轻量实现）。Zeabur 上以仓库根为构建上下文、引用
  `mcp-gateway/Dockerfile` 单独建一个服务即可；server 清单在 `mcp-gateway/config.default.json`。
- Ollama 本地 lane：专用服务器无 GPU/大内存，形态 A（自有设备经 Tailscale 接入）是唯一可行形态，`OLLAMA_API_BASE` 指向 tailnet IP。
- 监控（prometheus/grafana profile）：2C4G 不建议常驻；`/metrics` 已暴露，需要时再挂外部 Prometheus 拉取。
