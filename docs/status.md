# 实现状态与模块对照

状态截至 2026-09-03（v0.3.1 基线 + 0903 修订批次：缓存命中面 R0–R4、真流式 #5、DNS 钉扎 #6、
动态工具泳道 #13、本地备份、console 对话面、记忆写操作；测试 137/137）。
**0903 发布前全仓审查批次**（推正式版前 bug 清剿，测试 146/146）：
主管线（缓存 try 圈收窄防失败重跑重复输出；当前用户消息经 excludeMessageId 排除、不再重复进装配；
fallback 后装配与缓存键按 usedModel 配对；ContextTooSmallError 走链内跳过而非 500；危机路径
privacyLane 归位 cloud；工具轮用量合计；防抖单语句条件插入）；装配（预算切进工具组时头部孤儿
tool 行裁掉）；流式（SSE 尾帧/decoder 冲刷、中途超时映射 504 可 fallback）；TTS 版本号规则不再
吞裸数字；Huginn（投递校验 HTTP 状态码、delivery_pending 幂等重试扫描落地、Final Check markFiltered
匹配 generated、UTC 跨日竞态、ritual cron 用用户时区）；webhook 校验链（IPv6 hex/NAT64 形态解析加固、
白名单豁免 scheme 使内部 http 投递可用）；identity/http（恒时比较、限流键 TTL 原子化、webLogin 与
session 建档并发竞态、session_type 入口校验、AttemptLimiter 容量上限、feed limit 收敛正整数）；
mcp-gateway（懒连接单飞、probe 连接入池、音乐信封紧凑+封顶、名称校验补齐）；compose/litellm
（WEBHOOK_HOST_ALLOWLIST 去重、ADMIN_TOKEN 与中转渠道 key 注入、litellm 库/角色初始化、fallbacks
改字典列表）；备份脚本（401 重登、state 分页形状、eternal_id 小写化、容器/卷名经 compose 解析）。
**0904 二批（外部复审采纳）**：delivery_pending 打捞归 Outbox Worker（retry_backoff 退避 + 落库
dedupe_key 幂等复用，超限 failed/delivery_exhausted）；registry.invoke 补确认票（§5.4 承诺兑现，
封网页注入旁路 mail 域确认的门）；compose mnemosyne/Grafana 只绑回环（公网入口走 caddy）、删死
JWT_SECRET；generateOutreach 补 clampTemperature（kimi 温度锁不再断生成链第三棒）；TG 危机消息
全链失败补发静态危机资源兜底、重启跳过积压回放（offset=-1 起步）；inQuietHours 的 ICU「24:00」
午夜怪癖归零；mcp-gateway readBody 加 1MB 上限；限流 Redis 键对 clientKey 哈希（明文凭证不入键名）。
记档未改：resolveSession by-ID 不看 is_active（无写入方，休眠字段）；feed/metrics 的
intervention_pending 死过滤（无害）；TG 轮询串行（60s 工具回路会堵后续消息）；chatStream 120s
是总超时非空闲超时；/metrics 公开（公网暴露面建议在 caddy 侧收敛）。
**0904 三批（发布日功能收口，测试 153/153）**：
① **origin=client 工具透传**——ChatBodySchema 收 OpenAI 标准 tools/tool_choice（消息对象 passthrough，
tool_calls 活过校验层）；mergeClientTools 与注册表工具合流去重（撞名时客户端显式声明压过注册表）；
executeToolLoop 分流执行：origin=gateway 服务端执行（确认票/contested 照走），origin=client 终止回路、
原样回交客户端（响应 finish_reason: tool_calls，流式以 delta.tool_calls 帧下发）。续轮语义：user 之后
跟 assistant(tool_calls)/tool 的请求按续轮处理——trailing 消息按 tool_call_id 分角色去重落库、不追加
当前消息、沿 tool 泳道、缓存与摄入全关；回放层按 id 配对清洗悬空 tool_calls（弃坑/崩溃残迹）。
厂商原生工具（非 function 条目）由 modelRegistry.nativeToolsPassthrough 按型号放行（默认全关，
逐款确认 LiteLLM 透传行为后开启）。② **体感慢**：TG 每 4s typing 心跳 + 25s「还在想」；
latencySeconds 直方图补段（crisis_prescan/twig_packet/assemble/gateway_first_byte/request_total）；
单腿模型超时 120s→90s（MODEL_TIMEOUT_MS 可调）。③ **线索剂量**：DEFAULT_PERSONA 加「线索是背景
不是议程」；builder capThreadSection 对叙事包线索段落封顶 2 条（格式与上游 renderPromptText 耦合、
优雅降级；nv 基于裁剪后文本保持键与内容一致）。④ **动态注册快照**：mcp-gateway write-through 落盘
（MCP_STATE_PATH，compose 挂 gateway_data 卷），启动读回标记 known-unverified、首次调用懒重握手，
失败进 lastError 尸检名单（/health 可见）。
本文是维护者视角的
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
