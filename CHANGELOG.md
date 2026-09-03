# CHANGELOG

Mnemosyne 记忆女神的版本编年史。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [v1.0.0] — 2026-09-04

首个正式发布。单用户、自托管的 Personal AI Runtime：跨客户端、跨会话、跨模型的连续身份运行时。
*Your memory never dies. (And now the outbox always delivers.)*

### 施工账

- 设计文档链 v0.1.0 → v0.3.1（2026-08-29 ~ 08-30），两轮红队审计（18 + 14 项）全部裁决、修复并整合落盘
- 仓库 2026-08-30 开建 → 2026-09-04 封印，共 6 个施工日
- 测试 154/154 全绿（vitest 单测 + 需真实 PostgreSQL 的集成测试）

### Added · 能力总览

- **身份层**（§2）：argon2id + client_signature 双凭证、per-client_key 隔离、凭证轮换、session 归属校验、尝试限流
- **上下文装配**（§3/§6.4）：token 预算模型、原子 promptText、超预算重装配 fallback；Context Builder 是大脑
- **缓存**（§7）：Exact / Context / Policy 多层缓存；装配 stable→volatile 布局对齐厂商前缀缓存（Anthropic cache_control 只标稳定段）
- **危机协议**（§3.9/§18）：多语言词表预扫、零缓存路径、GREATEST monotonic 静默期、加密独立审计、TG 全链失败时静态危机资源兜底
- **隐私分层路由**（§20）：隐私评分 + PII 检测，本地 lane fail-closed（503 绝不 fallback 云端）
- **Huginn 主动触达**（§19）：分布式状态机 + 事务发件箱、原子抢槽、幂等投递（dedupe_key）、Final Policy Check、六道门、防自强化回路
- **工具系统**（§4/§5/§10）：MCP 网关懒连接聚合、动态注册 write-through 快照（重启读回 + 懒重握手 + lastError 尸检）、确认票据、Token Broker 短票、`origin=client` 工具透传（续轮 trailing 分角色去重落库、缓存/摄入全关）
- **模型网关**（§6）：LiteLLM 多厂商路由、fallback 链、temperature 收敛（reasoning 型锁 1）、真流式（上游 token 级 SSE 透传，已发 delta 禁换腿）
- **语音**（§21）：TTS 云端优先链（ElevenLabs）、语义截断、60s 即焚、独立情绪分类器（与隐私评分解耦）
- **记忆**（§8/§23）：上游 twig-memory（衔枝）三层叙事 + 情感层，promptText 原子注入；记忆搬家 CLI
- **Web Dashboard**：爱琴海之夜（index / book / explorer / console 实时接入；记忆写操作 contest / correct / notes 三条 BFF，userId 钉死认证用户）；console 对话面直连真流式——「前端也是客户端」成立
- **OpenAI 兼容面**：`/v1/models` + `/v1/chat/completions`（流式/非流式），RikkaHub 等标准客户端可直连
- **可观测**（§11）：prom-client 指标、PII 日志脱敏、latencySeconds 五段计时（crisis_prescan / twig_packet / assemble / gateway_first_byte / request_total）
- **部署运维**：docker compose 全栈（profiles：vector-kg / monitoring / local-lane 默认不启）、Zeabur 部署手册、本地备份脚本（pg_dump + twig 叙事快照，14 天滚动）、灾难恢复手册

### Fixed · 发布前清剿（0903–0904 三批）

- 主管线：缓存 try 圈收窄（防上游失败整链重跑导致重复流式/双倍计费）；当前用户消息不再重复进装配；fallback 后装配与缓存键按 usedModel 配对；ContextTooSmallError 链内跳过；工具轮用量合计
- 流式：SSE 尾帧与 decoder 冲刷、CRLF 容忍、中途超时重分类 504；回放层按 id 配对清洗悬空 tool_calls
- Huginn：delivery_pending 打捞归 Outbox Worker（retry_backoff + dedupe_key 幂等）；UTC 跨日竞态；ritual cron 用用户时区；inQuietHours「24:00」怪癖归零
- 依赖：undici 降级 ^6（node:20-alpine 与 undici v8 不兼容的 CrashLoop 根因）
- mcp-gateway：懒连接单飞、probe 入池、readBody 1MB 上限、工具列表按 server 名去重（同名 function 永不进系统提示）

### Security

- webhook 校验链：SSRF 全链校验 + DNS rebinding 钉扎（pinnedLookup 把解析→校验→连接收敛进同一次 lookup，TOCTOU 窗口消除）；IPv6 hex/NAT64 形态加固
- 恒时比较、空 token 拒绝、限流键 TTL 原子化 + clientKey 哈希（明文凭证不入键名）、AttemptLimiter 容量上限
- registry.invoke 补确认票（封网页注入旁路确认的门）；compose mnemosyne/Grafana 只绑回环，公网入口收敛到 Caddy

### 已知未实现（接口位已留，见 docs/status.md 诚实清单）

SCOUT 工具 schema 检索（§5.2.2）· 语义缓存（前置条件：narrativeVersion 稳定化）· OTel → Collector · Skill Forge（§22，攒 AgentTrace 中）· Dashboard 的 observatory / forge / settings 页 · Broker 短票动态取件启用

---

设计文档：[`docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md`](docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md) + [`v0.3.1_patch`](docs/Mnemosyne_Technical_Implementation_Document_v0.3.1_patch.md)。
