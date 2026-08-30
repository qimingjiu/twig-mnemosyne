# Mnemosyne — Personal AI Runtime

> 跨客户端、跨会话、跨模型的连续身份运行时。Your memory never dies.

本仓库按 `docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md` +
`docs/Mnemosyne_Technical_Implementation_Document_v0.3.1_patch.md` 施工，上游契约锚定
`qimingjiu/twig-memory` @ `89a7881`。

## 仓库结构

```
├── docker-compose.yml        §13.3（profiles: vector-kg / monitoring / local-lane 默认不启）
├── litellm_config.yaml       §6.2 + §6.4 模型注册表对应的 LiteLLM 管道配置
├── mcp_config.json           §5.2.1 MCP server 配置
├── Caddyfile / init.sql / prometheus.yml
├── config/
│   ├── capabilities.yaml     §4.2 Capability Registry + §10.2 泳道白名单 + contested 域映射
│   ├── huginn.yaml           §19.4 触达引擎配置（v0.3.1 补丁版）
│   └── tts_priority.yaml     §21.3 TTS 云端优先链（E-6 勘误后）
├── docs/                     设计文档 v0.3.0 + v0.3.1 补丁 + 恢复手册
├── scripts/backup.sh         §13.6 每日备份（cron 04:30）
└── runtime/                  TypeScript 运行时（本仓库主体）
    ├── migrations/           001_identity / 002_content / 003_outreach（启动时自动迁移）
    ├── src/
    │   ├── index.ts          入口：迁移 → 装配 → twig 启动断言 → HTTP → Huginn 调度
    │   ├── identity/         §2 身份层（argon2id / client_signature / webhook SSRF 校验链）
    │   ├── context/          §3.2 预算模型 + §3.5 Context Builder + §6.4 模型注册表
    │   ├── memory/           §8.3 TwigAdapter（真实契约）/ §3.6 摄入 / §3.4 批次计账
    │   ├── cache/            §7 缓存键规范 / Exact / Context / Policy
    │   ├── crisis/           §3.9 危机预扫（多语言词表 + 宿主责任模块）
    │   ├── chat/pipeline.ts  §14.2 主管线（危机预扫→泳道→隐私分层→重装配 fallback→缓存→摄入）
    │   ├── privacy/          §20 隐私评分 + PII 检测核（与 §11 脱敏共用）
    │   ├── voice/            §21 语音人格约束 / shouldTTS（PATCH-06）/ 硬截断兜底 / ElevenLabs
    │   ├── outreach/         §19 Huginn 状态机（原子抢槽 / Final Policy Check / Outbox Worker）
    │   ├── router/           §4 Capability Registry / §4.6 确认票据 / §10.2 泳道分类
    │   ├── broker/           §5.3 Token Broker（内部短票端点 + 取件审计）
    │   ├── usage/            §9 用量引擎 + Welford 健康分
    │   └── observability/    §11 prom-client 指标 + PII 日志脱敏
    ├── scripts/              bootstrap / relocate（§23 记忆搬家）/ huginn 手动入口
    └── test/                 72 个纯逻辑单测（无需外部服务）
```

## 快速开始（开发）

```bash
cd runtime
npm install
npm run typecheck && npm test     # 纯逻辑单测，无需任何外部服务
npm run build
```

本地起完整栈需要 Postgres 16 (pgvector)、Redis 7、twig-memory、LiteLLM——推荐直接用 compose：

```bash
cp .env.example .env      # 填入密钥；openssl rand -base64 32 生成 ENCRYPTION_KEY
# twig-memory（上游 qimingjiu/twig-memory）与 mcp-gateway（eznix86 fork）的构建上下文
# 需放置到 ./twig-memory 与 ./mcp-gateway（见下节「外部构建上下文」）
docker compose up -d
docker compose exec mnemosyne node dist/scripts/bootstrap.js \
  --email you@example.com --name 杳晦 --master-key <口令> --token $BOOTSTRAP_TOKEN
```

bootstrap 输出 `eternal_id` 与唯一的 `client_key`（明文只出现这一次）。

### 外部构建上下文

compose 中 `twig-memory` 与 `mcp-gateway` 是 `build:` 条目，需先就位：

- `./twig-memory`：clone `qimingjiu/twig-memory`（锚定 @89a7881）；
- `./mcp-gateway`：clone eznix86/mcp-gateway 并打上 §5.2 的扩展（lazy loading / 动态注册 / skill documents / broker 取件）。

两者均已加入 `.gitignore`，仓库不内嵌上游源码。

## 对 v0.3.1 补丁的两处施工修正（需要你知道）

补丁 §19.3.1 的 `outreach` 表定义与 `reserveOutreachSlot` 代码存在两处会直接打挂 Huginn 的硬伤，已在 `runtime/migrations/003_outreach.sql` 落地为修正版：

1. **`UNIQUE(user_id, dedupe_key)` 与抢槽占位冲突**：抢槽时以 `dedupe_key=''` 插入 reserved 行——同一用户抢第二个槽即 23505，且 filtered 行永远保持空键，**第一次空扫描后该用户将永久无法再预留槽位**。修正：改为部分唯一索引 `WHERE dedupe_key <> ''`；T9.8「相同 dedupe_key 二次 INSERT 必失败」语义不变。
2. **`outreach_type NOT NULL` 与抢槽 INSERT 缺列冲突**：抢槽发生在候选扫描之前，此时类型未知，INSERT 即 23502。修正：改为可空，类型在候选确定后回填（终态交付行恒有类型）。

另有一处语义差异记录在案：补丁 §19.3.5 示例向 `/v1/intervene` 传 `outcome:'pre_intervention'`，但 outcome 枚举不含该值（它属于 evidenceLevel）——实现改为初始上报只带 `evidenceLevel:'post_intervention'`。

## 实现状态（诚实清单）

**已实现（可运行）**：身份层全流程（注册双凭证路径/轮换/session 归属校验 D-02/尝试限流 T1.5）、webhook 校验链（§2.5.1，含 T8.5）、危机预扫与危机路径（§3.9/PATCH-02，零缓存、GREATEST monotonic 静默期、加密独立审计）、Context Builder（预算模型/原子 promptText/装配顺序/§3.8 重装配 fallback）、缓存层（键规范/Exact/Context/Policy）、隐私分层路由（§20 fail-closed 503）、泳道分类（§10.2 轻量版）、TwigAdapter（§8.3 真实契约，启动断言 auth=true / T8.10）、Token Broker（§5.3）、Huginn 全状态机（§19 v0.3.1：原子抢槽/幂等投递/Outbox Worker/三层自强化防线）、语音管线（§21：shouldTTS PATCH-06/语义截断/ElevenLabs/60s 即焚）、记忆搬家 CLI（§23）、prom-client 指标。

**未实现（接口位已留，见代码内 TODO 锚点）**：

| 项 | 位置 | 说明 |
|---|---|---|
| 工具执行回路 | chat/pipeline | 依赖 mcp-gateway fork；确认票据（§4.6）与 contested 域检查（§4.7）已实现并测试 |
| LangGraph StateGraph | router/lanes | 当前为单分类器轻量实现；postgresCheckpointer 加密落库待工具回路后接入 |
| 语义缓存 | cache/ | 需 embedding 模型 + RedisVL；exact/context 两层已覆盖 |
| 流式响应 | http/routes | v0.3.1 request-response 边界内，返回 501 |
| DNS rebinding 钉扎 | identity/webhookGuard | 当前为投递前重解析近似；严格版需 undici Dispatcher 钉 IP |
| Y2K Dashboard | — | 独立前端仓库；/metrics 与 /v1/admin/* 已就绪 |
| OTel → Collector | observability | 当前 prom-client 直采（务实 v0） |
| Skill Forge（§22） | — | 依赖工具回路的 AgentTrace；蒸馏约束见 §22.2 |
| vein-nudge 独立证据公式 | outreach/candidates | 上游 packet 无 last_user_evidence_at 字段，以 7 天硬冷却 + evidenceLevel 降级近似（代码内注明） |

## 红队用例覆盖映射（§12.2 → test/）

| 用例 | 测试锚点 |
|---|---|
| T1.5 暴力尝试 | `identity.service.test.ts`（AttemptLimiter 10 次/15min） |
| T8.1 跨租户缓存 | `cache.keys.test.ts`（userId 入键） |
| T8.3 叙事演化 MISS | `cache.keys.test.ts`（nv 入摘要） |
| T8.4 危机零缓存 | `cache.keys.test.ts`（policy crisis_path） |
| T8.5 webhook SSRF | `webhook.guard.test.ts`（私网/元数据全拦截） |
| T8.9 确认票伪造 | `confirmation.test.ts`（篡改/跨会话/跨工具/过期） |
| T8.10 twig 裸奔 | `src/index.ts` 启动断言（需集成测试环境验证） |
| T9.1/T9.5 daily_cap | `migrations/003` 原子抢槽 + `outreach.policy.test.ts` |
| T9.2 危机静默 | `outreach.policy.test.ts`（INV-H04） |
| T9.3 输出侧复扫 | `crisis.lexicon.test.ts` + `outreach/generate.ts` |
| T9.6–T9.12 | `runtime/test/integration/`（需 PG/Redis，见 vitest exclude） |
| T10.1/T10.2 | `privacy.test.ts`（fail-closed / 分类器只读信号） |
| T11.2/T11.3 | `voice.tts.test.ts` |

集成测试目录当前为空壳——起 docker 栈后补 T9.5/T9.6/T9.7/T9.11 的并发与崩溃注入用例，是下一步最高价值的工作。

## 上游配合事项（§0.4 R1–R5 仍有效）

- R1 `/v1/crisis-check` 落地后，宿主词表切换为 API 调用；
- R5 ingest 长度上限提升后，撤除 4000 字符切片过渡；
- intervene 的 `outcome`/`evidenceLevel` 字段、`user_engaged → REDEEMED`、post_intervention 权重降级需 twig 侧同步施工（见补丁附录）。

---

*Mnemosyne — Your memory never dies. (And now the outbox always delivers.)*
