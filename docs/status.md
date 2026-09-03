# 实现状态与模块对照

状态截至 2026-09-03（v0.3.1 基线 + 0903 修订批次：缓存命中面 R0–R4、真流式 #5、DNS 钉扎 #6、
动态工具泳道 #13、本地备份、console 对话面、记忆写操作；测试 137/137）。本文是维护者视角的
诚实清单：哪些已可运行、哪些只留了接口位，以及各模块与设计文档章节的对应关系（§ 编号见
`Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md` / `v0.3.1_patch.md`）。

## 模块 ↔ 设计文档章节对照

```
├── docker-compose.yml              §13.3（profiles: vector-kg / monitoring / local-lane 默认不启）
├── deploy/compose/litellm.yaml     §6.2 + §6.4 模型注册表对应的 LiteLLM 管道配置
├── config/capabilities.yaml        §4.2 Capability Registry + §10.2 泳道白名单 + contested 域映射
├── config/huginn.yaml              §19.4 触达引擎配置（v0.3.1 补丁版）
├── config/tts_priority.yaml        §21.3 TTS 云端优先链（E-6 勘误后）
├── mcp-gateway/                    §5.2–5.3 MCP 工具聚合（本仓库自有实现）
└── runtime/                        TypeScript 运行时（本仓库主体）
    ├── migrations/                 001_identity / 002_content / 003_outreach（启动时自动迁移）
    ├── src/
    │   ├── index.ts                入口：迁移 → 装配 → twig 启动断言 → HTTP → Huginn 调度
    │   ├── identity/               §2 身份层（argon2id / client_signature / webhook SSRF 校验链）
    │   ├── context/                §3.2 预算模型 + §3.5 Context Builder + §6.4 模型注册表
    │   ├── memory/                 §8.3 TwigAdapter（真实契约）/ §3.6 摄入 / §3.4 批次计账
    │   ├── cache/                  §7 缓存键规范 / Exact / Context / Policy
    │   ├── crisis/                 §3.9 危机预扫（多语言词表 + 宿主责任模块）
    │   ├── chat/pipeline.ts        §14.2 主管线（危机预扫→泳道→隐私分层→重装配 fallback→缓存→摄入）
    │   ├── privacy/                §20 隐私评分 + PII 检测核（与 §11 脱敏共用）
    │   ├── voice/                  §21 语音人格约束 / shouldTTS（PATCH-06）/ 硬截断兜底 / ElevenLabs
    │   ├── outreach/               §19 Huginn 状态机（原子抢槽 / Final Policy Check / Outbox Worker）
    │   ├── router/                 §4 Capability Registry / §4.6 确认票据 / §10.2 泳道分类
    │   ├── broker/                 §5.3 Token Broker（内部短票端点 + 取件审计）
    │   ├── usage/                  §9 用量引擎 + Welford 健康分
    │   └── observability/          §11 prom-client 指标 + PII 日志脱敏
    └── test/                       单测 + 集成测试（见 docs/testing.md）
```

## 已实现（可运行）

身份层全流程（注册双凭证路径 / 轮换 / session 归属校验 D-02 / 尝试限流 T1.5）、
webhook 校验链（§2.5.1，含 T8.5）、危机预扫与危机路径（§3.9 / PATCH-02，零缓存、
GREATEST monotonic 静默期、加密独立审计）、Context Builder（预算模型 / 原子 promptText /
装配顺序 / §3.8 重装配 fallback）、缓存层（键规范 / Exact / Context / Policy）、
隐私分层路由（§20 fail-closed 503）、泳道分类（§10.2 轻量版）、TwigAdapter（§8.3 真实契约，
启动断言 auth=true / T8.10）、Token Broker（§5.3）、Huginn 全状态机（§19 v0.3.1：
原子抢槽 / 幂等投递 / Outbox Worker / 三层自强化防线）、语音管线（§21：shouldTTS PATCH-06 /
语义截断 / ElevenLabs / 60s 即焚）、记忆搬家 CLI（§23）、prom-client 指标、
web BFF（`/v1/web/*`）与爱琴海之夜 Dashboard 第一层数据接入、OpenAI 兼容面（`/v1/models` 模型列表 +
chat 流式——2026-09-03 升级真流式（上游 token 级透传），缓存命中整段重放；RikkaHub 等标准 OpenAI 客户端可直连）。
缓存与厂商前缀缓存对齐（2026-09-03 R0–R4）：装配 stable→volatile（叙事包独立成消息置于历史后，
builder.ts）、Anthropic cache_control 断点只标稳定段、exact 键 temperature 用收敛值、
LiteLLM 层明确不配 response cache（litellm.yaml 头注）；厂商侧命中率观测脚本 `scripts/cache-report.sql`。

## 未实现（接口位已留，见代码内 TODO 锚点）

| 项 | 位置 | 说明 |
|---|---|---|
| 工具 schema 检索（§5.2.2 SCOUT） | tools/resolver | 当前按泳道全量注入（个人规模 ~10 工具足够）；BM25+向量混合检索待工具数量增长后接 |
| Broker 短票动态取件 | mcp-gateway | OAuth 型远程 MCP server 接入时启用（§5.3 端点已就绪并测试） |
| LangGraph StateGraph | router/lanes | 单分类器轻量实现已满足泳道收敛；图编排待复杂泳道需求 |
| 语义缓存 | cache/ | 需 embedding 模型 + RedisVL；**前置条件：narrativeVersion 稳定化**——promptText 按 §18.1 含 recentStamps 等每轮漂移信号，nv=sha256(promptText) 逐轮变化，§7.3「nv 相等才命中」的语义缓存在此之前无生存空间（exact 键同源受累，R3 已修 temperature 收敛值问题） |
| DNS rebinding 钉扎 | identity/webhookGuard | ✅ 已收口（2026-09-03）：pinnedLookup 把解析→校验→连接收敛进同一次 lookup，deliver.ts 经 undici Agent + undici fetch 连接已校验 IP，TOCTOU 窗口消除；T8.5 用例扩到钉扎层与 E2E 投递 |
| 真流式（上游 token 级透传） | http/routes / chat/pipeline / gateways | ✅ 已收口（2026-09-03）：gateway.chatStream（SSE 解析 + tool_calls 片段合并 + stream_options 取 usage），管线 onDelta 透传，路由 sink 惰性开流（首帧前失败保持 JSON 状态码；已发帧禁链内 fallback 防重复文本）；缓存命中仍整段重放 |
| 爱琴海之夜 Dashboard 完整接入 | http/webRoutes | index/book/explorer/**console（对话面，真流式 chat）**已实时；**写操作已接**（2026-09-03）：claims/contest、correct、notes 三条 BFF 路由（userId 钉死认证用户，404 透传/其余脱敏 502）+ explorer 否决/修正内联表单 + book 便签写作；relocate 留 CLI（§23）。剩 observatory/forge/settings。「web 也是客户端」完整成立：client_type='web' 直连 /v1/chat/completions 真流式，共享同一 personal session 上下文 |
| OTel → Collector | observability | prom-client 直采（务实 v0） |
| Skill Forge（§22） | — | 依赖工具回路的 AgentTrace 积累（回路已上线，开始攒轨迹） |
| vein-nudge 独立证据公式 | outreach/candidates | 上游 packet 无证据时间戳字段，以 7 天硬冷却 + evidenceLevel 降级近似（详见 docs/upstream.md） |
| Telegram 激活 | telegram/adapter | ✅ 已激活（2026-08 下旬起 TG 为日常通道，运行中） |
| 自动备份 | — | ✅ 已收口（2026-09-03，本地拉取路线）：`scripts/backup-local.mjs`（postgres pg_dump + twig 叙事全量 JSON 快照，14 天滚动保留），一次性准备与 schtasks 注册见 `deploy/zeabur.md` 本地备份节；零云端成本 |
| 泳道白名单对动态工具不生效 | tools/resolver | ✅ 已收口（2026-09-03）：capabilities.yaml 新增 `dynamic_tools.lanes`（现值 [tool]），enrichSchemas 按 lane 参数收敛动态工具；chat 等泳道经 registry.invoke 逃生舱仍可达（确认票兜底）。lane 缺省=不收敛（兼容 3d66d07 行为）。注：SCOUT 上马后可进一步按检索 top-k 收数量 |
