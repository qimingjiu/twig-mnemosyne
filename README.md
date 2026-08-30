# Mnemosyne — Personal AI Runtime

> 跨客户端、跨会话、跨模型的连续身份运行时。Your memory never dies.

Mnemosyne 是一个单用户、自托管的 AI 陪伴运行时：Telegram bot、Web Dashboard、任意支持
MCP 的 AI 客户端都通过同一套身份凭证接入，由它统一完成身份认证、上下文装配、隐私分层、
危机干预与主动触达（Huginn）；长期记忆与叙事由上游
[twig-memory](https://github.com/qimingjiu/twig-memory)（muninn）持久化，模型调用经
LiteLLM 网关路由到任意厂商。所有数据落在自己的 Postgres 与数据卷里。

| 能力 | 说明 | 代码 |
|---|---|---|
| 身份层 | argon2id + client_signature 双凭证、per-client_key 隔离、webhook SSRF 校验链 | `runtime/src/identity` |
| 上下文装配 | token 预算模型、装配顺序、超预算重装配 fallback、多层缓存 | `runtime/src/context` `cache` |
| 隐私与安全 | 隐私评分分层路由（fail-closed）、PII 检测与日志脱敏、危机词表预扫 | `runtime/src/privacy` `crisis` |
| 主动触达 | Huginn 状态机：原子抢槽、幂等投递、outbox 恢复、防纠缠冷却 | `runtime/src/outreach` |
| 工具 | MCP 网关懒连接聚合 + Token Broker 短票取件 | `mcp-gateway/` `runtime/src/broker` |
| 语音 | TTS 云端优先链、语义截断、60s 即焚 | `runtime/src/voice` |
| 可观测 | prom-client 指标 + Y2K Dashboard | `runtime/src/observability` `web/` |

## 架构

```
 Telegram bot ──┐                    ┌──→ twig-memory   长期记忆/叙事引擎（上游仓库）
 Web Dashboard ─┼─→ mnemosyne ──────┼──→ litellm       模型网关 → 各厂商 API
 MCP/AI 客户端 ─┘     runtime        ├──→ mcp-gateway   MCP 工具懒连接聚合
                 （本仓库主体：      └──→ postgres(pgvector) / redis
                   身份·隐私·危机·触达·装配）
```

浏览器只对 runtime 说话（`/v1/web/*` BFF），凭证不出服务端；运行时配置在 `config/`。

## 快速开始

**纯单测**（vitest，无需任何外部服务）：

```bash
cd runtime
npm install
npm run typecheck && npm test
```

**完整栈**（Postgres 16 + pgvector、Redis 7、twig-memory、LiteLLM，推荐直接用 compose）：

```bash
cp .env.example .env       # 填入密钥；openssl rand -base64 32 生成 ENCRYPTION_KEY
docker compose up -d
docker compose exec mnemosyne node dist/scripts/bootstrap.js \
  --email you@example.com --name 杳晦 --master-key <口令> --token $BOOTSTRAP_TOKEN
```

bootstrap 输出 `eternal_id` 与唯一的 `client_key`（明文只出现这一次）。

**Zeabur 部署**（本地无需 Docker）：见 [deploy/zeabur.md](deploy/zeabur.md)。

## 仓库结构

```
├── runtime/                TypeScript 运行时（本仓库主体）
│   ├── migrations/         Postgres 迁移（启动时自动执行）
│   ├── scripts/            bootstrap / relocate（记忆搬家）/ huginn 手动入口 / persona
│   └── test/               单测 + 集成测试（需真实 PG，未配置自动跳过）
├── web/                    Y2K Dashboard（app/ = Vite MPA；mockups/ = 设计稿存档）
├── mcp-gateway/            MCP 工具网关（懒连接 / 工具聚合 / skill_document 透传）
├── config/                 运行时 YAML 配置（capability 注册表 / 触达引擎 / TTS 优先链）
├── deploy/                 部署：Dockerfile（compose 与 Zeabur 两版）、compose 挂载件、Zeabur 手册
├── docs/                   设计文档、契约对齐、实现状态、测试说明、恢复手册
├── scripts/backup.sh       每日备份（VPS cron 04:30）
├── docker-compose.yml      完整自托管栈（可选 profiles: vector-kg / monitoring / local-lane）
└── .env.example            环境变量模板
```

compose 用到的挂载件（Caddyfile / litellm.yaml / init.sql / prometheus.yml）在
[deploy/compose/](deploy/compose/)；MCP server 清单在
[mcp-gateway/config.default.json](mcp-gateway/config.default.json)。

## 外部构建上下文

compose 构建 twig-memory 服务时，需要上游
[twig-memory](https://github.com/qimingjiu/twig-memory)（muninn）的最小副本放在仓库根
`./twig-memory`（server / shared / visualizer / engine + package 文件，剔除 eval-data 与
node_modules；目录在 `.gitignore` 中，不入库）。上游更新后重新复制即可。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md](docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md) | 总设计文档（各处 § 引用的出处） |
| [docs/Mnemosyne_Technical_Implementation_Document_v0.3.1_patch.md](docs/Mnemosyne_Technical_Implementation_Document_v0.3.1_patch.md) | v0.3.1 增量补丁 |
| [docs/upstream.md](docs/upstream.md) | 上游契约对齐记录、施工偏差、R1–R5 配合状态 |
| [docs/status.md](docs/status.md) | 实现状态诚实清单、模块 ↔ 设计文档章节对照 |
| [docs/testing.md](docs/testing.md) | 测试说明与红队用例覆盖映射 |
| [docs/restore.md](docs/restore.md) | 灾难恢复手册 |
| [deploy/zeabur.md](deploy/zeabur.md) | Zeabur 部署手册 |
| [web/README.md](web/README.md) | Dashboard 开发说明 |

## License

MIT，见 [LICENSE](LICENSE)。第三方组件致谢见 [NOTICE.md](NOTICE.md)。

---

*Mnemosyne — Your memory never dies. (And now the outbox always delivers.)*
