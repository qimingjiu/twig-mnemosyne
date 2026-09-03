# Mnemosyne — Technical Implementation Document v0.3.0
## Personal AI Runtime

**Date**: 2026-08-30  
**Author**: 杳晦 (Mnemosyne Team)  
**Status**: v0.3.0 Feature Stitch — Draft for Review  
**上游契约锚定**: `qimingjiu/twig-memory` @ `89a7881`（server/http.ts, server/core.ts, server/host-loop.ts 逐行核验）

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Identity Layer](#2-identity-layer)
3. [Session & Context Builder](#3-session--context-builder)
4. [Capability Router & Registry](#4-capability-router--registry)
5. [Tool Resolver & MCP Gateway](#5-tool-resolver--mcp-gateway)
6. [Model Gateway](#6-model-gateway)
7. [Cache Layer](#7-cache-layer)
8. [Memory System](#8-memory-system)
9. [Usage Engine & Cache Policy](#9-usage-engine--cache-policy)
10. [Agent Orchestration](#10-agent-orchestration)
11. [Observability](#11-observability)
12. [Security & Red Team Testing Guide](#12-security--red-team-testing-guide)
13. [Deployment Specification](#13-deployment-specification)
14. [Appendix: Data Models](#14-appendix-data-models)
15. [Third-Party Licensing & Attribution](#15-third-party-licensing--attribution)
16. [Smithery.ai Integration Guide](#16-smitheryai-integration-guide)
17. [External Resource Integration](#17-external-resource-integration)
18. [Emotional Layer & Crisis Protocol](#18-emotional-layer--crisis-protocol)
19. [HeadlessHuginn · Proactive Outreach Engine](#19-headlesshuginn--proactive-outreach-engine)
20. [Privacy-Tiered Routing & Local Model Sidecar](#20-privacy-tiered-routing--local-model-sidecar)
21. [Voice Pipeline](#21-voice-pipeline)
22. [Skill Forge · 技能沉淀](#22-skill-forge--技能沉淀)
23. [Memory Relocation Pipeline · 记忆搬家](#23-memory-relocation-pipeline--记忆搬家)
24. [Hardware & Edge Layer](#24-hardware--edge-layer)

---

## 0. 修订总览（v0.3.0）

### 0.0 使用方式

本版本为 v0.2.2 的功能缝合版（Feature Stitch）。新增 §19–§24 六个完整章节，并对 §0、§1.2、§3.2、§6.4、§9.2、§12、§13、§15 进行联动修订。标注「整节替换」的章节直接覆盖；标注「段落替换/新增」的按编号嵌入。未列出的章节沿用 v0.2.2 原文。

### 0.1 红队判决处置矩阵（v0.2.2 归档）

v0.2.2 的 VULN-01–18 处置矩阵全文保留，见 v0.2.2 §0.1。本节仅登记 v0.3.0 新增特性。

### 0.2 v0.3.0 特性登记表

| 特性 ID | 章节 | 名称 | 2C4G 影响 | 状态 |
|:---:|:---:|:---|:---:|:---|
| FEATURE-01 | §19 | HeadlessHuginn · 主动触达引擎 | 零（纯调度逻辑） | 新增 |
| FEATURE-02 | §20 | 隐私分层路由 & 本地模型边车 | 零（形态 A 服务器只做路由） | 新增 |
| FEATURE-03 | §21 | 语音管线（TTS 云端优先 + 语音人格约束） | 零（云端 API） | 新增 |
| FEATURE-04 | §22 | Skill Forge · 技能沉淀 | 零（纯调度逻辑） | 新增 |
| FEATURE-05 | §23 | 记忆搬家管线 | 零（一次性任务） | 新增 |
| FEATURE-06 | §24 | 硬件与边缘层 | 零（D-11 封存，不施工） | 新增 |

### 0.3 判决书勘误（v0.2.2 归档 + 新增）

v0.2.2 的 E-1 至 E-5 全文保留。本节新增：

**E-6：v0.3.0 草案 §21.3 的 TTS 优先级链误标 `GPT-SoVITS` 与 `piper` 为默认选项。** 经许可证核查，`piper` 原版已归档且当前活跃分支为 GPL-3.0；`GPT-SoVITS` 虽为 MIT 但部署复杂度高。实际第一版 TTS 走云端 API（ElevenLabs / Google / OpenAI），MIT 本地项目（MeloTTS、Piper Plus、Bark 等）降级为 deferred 备选。§21.3 已重写。

### 0.4 上游 twig-memory 配合请求（v0.2.2 归档）

R1–R5 全文保留，见 v0.2.2 §0.3。

### 0.5 未变更节清单

以下章节沿用 v0.2.2 原文，本版本不含替换内容：§1.1（设计哲学）、§2（Identity Layer，仅 §2.5.1 一处新增 webhook 校验链保留）、§3.3–3.9（Context Builder 子节，仅 §3.2 预算表新增 TTS 注记）、§4（Capability Router，仅 §4.2 删除 emotional_layer 条目保留）、§5（Tool Resolver）、§6.1–6.3 & §6.5（Model Gateway，仅 §6.4 注册表更新）、§7（Cache Layer）、§8（Memory System）、§9.1 & §9.3–9.6（Usage Engine，仅 §9.2 新增 tts_chars 字段）、§10（Agent Orchestration）、§11（Observability）、§14（Data Models）、§16（Smithery.ai）、§17（External Resource）、§18（Emotional Layer）。

---

## 1. Architecture Overview

### 1.1 Design Philosophy

Mnemosyne is not an AI Gateway wrapper. It is a **Personal AI Runtime** that sits between AI clients and downstream resources (LLMs, Tools, Agents). Its core value is **cross-client, cross-session, cross-model continuous identity** — a user can switch from Operit to Telegram to RikkaHub and the conversation continues seamlessly.

**Key Principles:**
- **Identity is Layer 1**: Every request must resolve to a User before any processing.
- **Context Builder is the Brain**: Not the model gateway. The runtime decides what context to inject.
- **Conversation ≠ Memory**: Raw messages live in PostgreSQL; extracted memories live in the Narrative Engine (twig-memory).
- **Observability is a Sidecar**: Never blocks the main request path.
- **Tool Agnosticism**: AI says `calendar.query`; the runtime resolves to Google Calendar MCP today, Outlook tomorrow — the model never knows.
- **Narrative over Retrieval**: Memories are not top-k cards; they are woven narratives that track unresolved threads and evolving understanding of the user.

### 1.2 System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AI Clients                                    │
│  Operit / RikkaHub / Telegram / Web / Mobile / Game Engine          │
│                              │                                      │
│                    OpenAI-compatible API                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    MNEMOSYNE RUNTIME                                 │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  IDENTITY LAYER                                             │    │
│  │  Client → Identity → User → Session Resolver                │    │
│  └─────────────────────────────┬───────────────────────────────┘    │
│                                │                                     │
│  ┌─────────────────────────────▼───────────────────────────────┐    │
│  │  CONTEXT BUILDER (Core Brain)                               │    │
│  │  System + Narrative Context (twig-memory) +                 │    │
│  │  Recent Conversation + Tool State + Available Capabilities  │    │
│  └─────────────────────────────┬───────────────────────────────┘    │
│                                │                                     │
│  ┌─────────────────────────────▼───────────────────────────────┐    │
│  │  CAPABILITY ROUTER                                          │    │
│  │  Model Capability / Tool Capability / Agent Capability      │    │
│  └───────┬─────────────────────┬─────────────────────┬─────────┘    │
│          │                     │                     │              │
│  ┌───────▼──────┐    ┌────────▼────────┐   ┌───────▼──────┐       │
│  │ CACHE LAYER  │    │  MODEL GATEWAY  │   │  MCP GATEWAY │       │
│  │ (4-tier)     │    │  LiteLLM/Bifrost│   │  + Tool Resolver     │
│  └───────┬──────┘    └────────┬────────┘   └───────┬──────┘       │
│          │                    │                    │               │
│          └────────────────────┼────────────────────┘               │
│                               │                                    │
│                    ┌──────────▼──────────┐                        │
│                    │   MEMORY SYSTEM     │                        │
│                    │  Postgres / Twig    │                        │
│                    └─────────────────────┘                        │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  HUGINN (outbound)  ◄──── cron / event triggers             │    │
│  │  Proactive Outreach Engine  ──► webhook 投递               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  LOCAL LANE (ollama, profile) ◄──── Tailscale / 同机       │    │
│  │  Privacy-Tiered Routing · 物理不出网                       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  OBSERVABILITY (Sidecar)                                             │
│  OpenTelemetry → Prometheus + Logs → Y2K Dashboard                   │
└─────────────────────────────────────────────────────────────────────┘
```

> **v0.3.0 架构变更注记**：
> - 新增 `HUGINN (outbound)` 框：主动触达引擎，虚线指向 webhook 投递通道（§19）。
> - 新增 `LOCAL LANE (ollama, profile)`：隐私分层路由的本地模型边车，默认不启动（§20）。
> - `AI Clients` 层新增 `Game Engine`：为 §24 封存的硬件/游戏桥接预留接口位。
> - 语音管线（§21）不新增独立架构框：TTS/ASR 作为传输层适配器，分别挂在 Client 入站侧与 Model Gateway 出站侧。

### 1.3 Technology Stack

| Component | Technology | License |
|-----------|-----------|---------|
| Runtime Core | Node.js 20 + TypeScript | MIT |
| Database | PostgreSQL 16 + pgvector | PostgreSQL |
| Cache | Redis 7 + RedisVL | BSD |
| Vector DB | Qdrant (optional, for non-narrative knowledge) | Apache 2.0 |
| Memory Engine | twig-memory (衔枝) | MIT |
| Model Gateway | LiteLLM Proxy | MIT |
| MCP Gateway | eznix86/mcp-gateway (forked) | MIT |
| Agent Framework | LangGraph | MIT |
| Observability | OpenTelemetry + Prometheus + Y2K Dashboard | MIT |
| Frontend Dashboard | React 18 + Vite + Tailwind | MIT |
| TTS Provider (云端) | ElevenLabs / Google / OpenAI | 专有 API |
| Local Model (可选) | Ollama + qwen3:8b | MIT |

---

## 2. Identity Layer

### 2.1 Responsibility

The Identity Layer is the **first and mandatory gate** for every incoming request. It answers:
- Which client is calling? (Operit, Telegram, etc.)
- Which user does this client belong to?
- Which session should this request attach to?
- What is the session type? (personal, coding, research, roleplay)

### 2.2 Data Model

#### 2.2.1 Users Table（VULN-02 修复）

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eternal_id      VARCHAR(64) UNIQUE NOT NULL,
    display_name    VARCHAR(255),
    email           VARCHAR(255) UNIQUE,
    -- VULN-02 修复：主凭证与盐
    master_key_hash TEXT NOT NULL,          -- argon2id；签发/轮换 client_key 的唯一凭证
    id_salt         BYTEA NOT NULL,         -- 每用户随机 32B；eternal_id = sha256(id_salt ‖ email ‖ created_at)
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    preferences     JSONB DEFAULT '{}',
    CONSTRAINT eternal_id_format CHECK (eternal_id ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_users_eternal_id ON users(eternal_id);
```

设计注记：
- `eternal_id` 保留 64-hex 格式与「永不改变」语义，但派生加入每用户随机盐——无法从 email 撞库重算（消解设计债务 D-01）。盐不出库、不进日志。
- `eternal_id` 降级为**半秘密标识**：它不是凭证（任何端点都不再仅凭它签发任何东西），但仍按敏感字段处理，不进 access log。

#### 2.2.2 Clients Table（VULN-02 修复）

```sql
CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_type     VARCHAR(32) NOT NULL CHECK (client_type IN
                    ('operit', 'rikkahub', 'telegram', 'web', 'mobile', 'api')),
    key_hash        VARCHAR(128) UNIQUE NOT NULL,   -- sha256(client_key)；明文只在签发时返回一次
    display_name    VARCHAR(255),
    webhook_url     TEXT,                            -- 校验规则见 §2.5.1
    scopes          TEXT[] NOT NULL DEFAULT '{chat}',-- 'chat' 默认；'provision' 可签发新 client
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ,
    UNIQUE(user_id, client_type)
);

CREATE INDEX idx_clients_key_hash ON clients(key_hash);
CREATE INDEX idx_clients_user_id ON clients(user_id);
```

- `client_key` 本体 `mn_` + 48 字符 CSPRNG，**只存哈希**。泄露数据库不等于泄露可用钥匙。
- `webhook_url` 入库前必须过 §2.5.1 校验链。

#### 2.2.3 Sessions Table

```sql
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_type    VARCHAR(32) NOT NULL DEFAULT 'personal'
                    CHECK (session_type IN ('personal', 'coding', 'research', 'roleplay')),
    eternal_session_id VARCHAR(64) UNIQUE NOT NULL,  -- cross-client persistent ID
    title           VARCHAR(255),
    is_active       BOOLEAN DEFAULT TRUE,
    context_window  INTEGER DEFAULT 128000,  -- max tokens for this session
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    metadata        JSONB DEFAULT '{}'  -- custom tags, project links
);

CREATE INDEX idx_sessions_eternal_id ON sessions(eternal_session_id);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
```

### 2.3 Request Flow

```
Incoming Request
    ├── Headers: X-Client-Key, X-Eternal-Session-ID (optional)
    └── Body: { messages, model?, session_type? }
        │
        ▼
┌─────────────────┐
│ Identity Resolve│
│ 1. Validate     │
│    X-Client-Key │
│ 2. Lookup User  │
│ 3. Resolve      │
│    Session      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Session Resolver│
│ • If X-Eternal- │
│   Session-ID    │
│   provided:     │
│   resume session│
│ • If not:       │
│   create new or │
│   find active   │
│   by type       │
└─────────────────┘
```

### 2.4 API Endpoints（VULN-02 修复）

#### POST /v1/identity/register

Register a new client for a user. **必须出示用户级凭证**，`eternal_id` 不再构成授权。

**Request:**
```json
{
  "user_eternal_id": "sha256_hash",
  "client_type": "telegram",
  "display_name": "Telegram Bot",
  "credential": {
    "type": "master_key",
    "master_key": "用户主口令"
  }
}
```

或（已有受信客户端代签发，如用户在 web 端已登录）：
```json
{
  "user_eternal_id": "sha256_hash",
  "client_type": "mobile",
  "credential": {
    "type": "client_signature",
    "client_key": "mn_existing...",
    "timestamp": 1724892960,
    "signature": "HMAC-SHA256(client_key, eternal_id ‖ client_type ‖ timestamp)"
  }
}
```

**处理规则：**
1. `master_key` 路径：argon2id 校验 `master_key_hash`。通过即签发。这是根凭证，建议仅在本机/受信网络使用。
2. `client_signature` 路径：要求该 client `is_active` 且 `scopes` 含 `provision`；timestamp 偏差 ≤300s；HMAC 校验通过即签发。
3. 两条路径都失败 → 401。**任何路径都不接受仅 eternal_id。**
4. 首次 bootstrap：第一个用户由部署 CLI 创建（`BOOTSTRAP_TOKEN` 环境变量，仅在无用户时生效一次），同时设置 master_key。

**Response:**
```json
{
  "client_key": "mn_xxxxxxxxxxxxxxxx",   // 仅此一次返回明文
  "eternal_session_id": "sess_sha256_hash",
  "created_at": "2026-08-29T02:36:00Z"
}
```

#### POST /v1/identity/session

Resolve or create a session. **Session 归属校验（消解 D-02）**：若该 session 不属于当前认证 user → 403，而非创建或静默挂靠。"find active by type" 只在**本用户**的 session 集合内查找。

**Request:**
```json
{
  "client_key": "mn_xxxxxxxxxxxxxxxx",
  "session_type": "coding",
  "eternal_session_id": "sess_sha256_hash"  // optional
}
```

**Response:**
```json
{
  "session_id": "uuid",
  "eternal_session_id": "sess_sha256_hash",
  "user_id": "uuid",
  "session_type": "coding",
  "is_new": false
}
```

### 2.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| Client Key theft | Attacker impersonates user | key 只存哈希、支持轮换 `/v1/identity/rotate`、泄露面收敛为传输层 |
| Eternal Session ID enumeration | Attacker guesses session IDs | eternal_session_id 由 CSPRNG 生成 32 字节 hex |
| Session fixation | Attacker forces user into attacker-controlled session | session 归属校验见 §2.4；validate session ownership on every request |
| Client type spoofing | Attacker claims to be "telegram" but is web | Client type is metadata only; authorization is via client_key |

#### 2.5.1 Webhook URL 校验链（VULN-13 修复，新增）

`webhook_url` 在**入库时**与**每次投递时**各过一次校验：

1. scheme 仅允许 `https`（`http` 仅当部署显式开启 `ALLOW_INSECURE_WEBHOOK=1`，用于 LAN 场景）；
2. 主机名做 DNS 解析，解析结果不得落入：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8、169.254.0.0/16（云元数据）、::1、fc00::/7、fe80::/10；
3. **每次投递时重新解析**（防 DNS rebinding：入库时解析合法、TTL 过期后改指内网）；
4. 可选白名单：`WEBHOOK_HOST_ALLOWLIST=api.telegram.org,...`，配置后仅允许列内主机；
5. 投递超时 5s，响应体丢弃不读（盲 webhook，无回传通道）。

---


## 3. Session & Context Builder

### 3.1 Responsibility

The Context Builder is **the core brain of Mnemosyne**. It assembles the final context block that is sent to the LLM. It decides:
- Which narrative memories are relevant? (via twig-memory)
- How many recent messages to include?
- Which tools/capabilities to expose?
- How to fit everything within the context window?
- **v0.2.2 新增**：按目标模型的物理窗口预算装配。
- **v0.3.0 新增**：语音人格约束注入（§21.4）。

### 3.2 预算模型（VULN-04 修复 + v0.3.0 增补）

**原则一：先扣刚性支出，余额归对话。** v0.2.1 的预算表把 128K 分满后才想起 Current Message 是 `~variable`，必然溢出。修正后：

| 组件 | 预算（128K 窗口示例） | 可截断性 |
|:---|:---:|:---|
| System persona（稳定段） | 2K | **pin，不可截断** |
| 语音人格约束（若 client 声明 voice_capable） | 0.3K | **pin，不可截断** |
| 危机安全指令（若触发） | 0.5K | **pin，最高优先** |
| 叙事上下文 promptText | 实测 ≈1–2K，上限 4K | **pin，整体原子** |
| Capability schemas | ≤6K | 可截断（经 §4 路由缩减） |
| Tool state | ≤4K | 可截断 |
| 当前用户消息 | ≤4K（API 层硬限长） | 不可截断 |
| 输出预留 | 8K | 不可挪用 |
| 安全缓冲 | 4K | 不可挪用 |
| **近期对话（余额）** | **≈92–96K** | 从最旧开始截断 |

> **v0.3.0 注记**：TTS 不占 LLM context window，占的是云端 provider credits（§21.6）。预算表中不单独列出 TTS 输出预留，但语音人格约束（§21.4）作为 system persona 的子段，占约 300 tokens，已计入 System persona 预算内。

**原则二：promptText 是原子单元。** 它是引擎渲染的单条字符串，内含窗口安全阀指令（「请勿基于这些论断干预」）、漂移警示、再提邀请——这些都是安全语义，**不允许按字符截断**。实测体积 1–2K（top-8 线索 + top-8 论断 + 5 碎片 + 7 印章），预算上限 4K，永远装得下，永远 pin 住。

**原则三：装配顺序服务前缀缓存**（2026-09-03 R1 修订：stable→volatile，叙事包移出 system）：

```
消息序列 = [system: 稳定 persona 段 + 语音人格约束（若启用） + Capability schemas（相对静态）]
         → [近期对话历史]
         → [system: 叙事 promptText（每轮变动，独立消息）]
         → [当前用户消息]
```

v0.3.0 原版把 promptText 固定在 system 消息末尾——但叙事包含 recentStamps 等逐轮漂移数据，夹在
persona 与对话历史之间意味着叙事一变，历史全部脱离 provider 前缀缓存重新计费。修订后：稳定前缀
（persona/schemas）与对话历史同属可命中的稳定前缀，逐轮变化的小段叙事垫在最后，provider 前缀缓存
（Kimi/DeepSeek 自动、Anthropic cache_control）的命中面最大化。cache_control 断点只标稳定 system
段末尾、不覆盖叙事包（2026-09-03 R2）。危机指令沿用「替换叙事包」语义，随叙事包槽位置于历史之后
（危机路径零缓存，无缓存影响；靠近用户消息反而强化优先级）。

### 3.3 叙事上下文获取（VULN-01 修复，真实契约）

```typescript
// 真实端点：GET /v1/context?userId= —— 无其他查询参数（核验 @89a7881）
// 返回 ContextPacket：
interface TwigContextPacket {
  userId: string
  generatedAt: string
  threads: { id: string; label: string; openQuestion: string; pool: string; daysOpen: number; dragonVein: number }[]
  claims: { id: string; text: string; conviction: number; boundary: string; status: string }[]
  recentFragments: { id: string; date: string; title: string }[]
  promptText: string
  recentStamps?: { type: string; beadType: string; beadName: string; date: string; notePreview: string }[]
}
```

要点：
- **读无副作用**（上游 P1-2：getContextPacket 不执行 tick），可每轮同步调用，成本为本地计算，无 LLM。
- **无 current_message 参数**。叙事包是与当轮消息无关的全量状态快照（top-8/top-8/5），这正是「叙事而非检索」的语义——不要在适配层伪造动态检索。
- **注入方式唯一**：`promptText` 整体注入，位置由原则三（2026-09-03 R1 修订）定为历史之后的独立 system 消息。v0.2.1 的 Option B（自行拼装结构化字段）废止——promptText 已含窗口指令/漂移警示/再提邀请的自然语言表述，自拼装必然漏掉安全阀。结构化字段供 Dashboard 与缓存指纹使用，不进 prompt。
- 会话映射：twig `userId` = Mnemosyne `users.eternal_id`。**一人一份叙事，跨 client 跨 session 共享**——这是设计目标而非泄露。v0.2.1 §3.7 的「session_type filtering 防跨 session 泄露」一行废止：Twig 无 session 命名空间，叙事连续性本来就是卖点；隔离边界在**用户**维度，由 Identity Layer 强制。


### 3.4 近期对话拉取（VULN-04 修复）

LIMIT 参数是**条数**，Token 预算是**钱**，两者不能互传。改为批次拉取 + 逐条计账：

```sql
-- 写入侧维护 token_count 列（写入时估算并存储），拉取按批次
SELECT id, role, content, token_count, tool_calls, tool_results, created_at
FROM conversation_messages
WHERE session_id = $1
ORDER BY created_at DESC
LIMIT 50 OFFSET $2;
```

```typescript
async getRecentMessages(sessionId: string, tokenBudget: number): Promise<Message[]> {
  const picked: Message[] = []
  let used = 0
  for (let offset = 0; ; offset += 50) {
    const batch = await db.query(RECENT_SQL, [sessionId, offset])
    if (batch.length === 0) break
    for (const msg of batch) {
      const t = msg.token_count ?? estimateTokens(msg.content)
      if (used + t > tokenBudget) return picked.reverse()  // 预算耗尽，返回（恢复时间正序）
      picked.push(msg); used += t
    }
  }
  return picked.reverse()
}
```


### 3.5 Context Builder Implementation

```typescript
class ContextBuilder {
  /** targetModel 必传：按该模型的物理窗口装配（VULN-06 修复的前提） */
  async build(ctx: BuildContext, targetModel: string): Promise<BuiltContext> {
    const window = Math.min(
      ctx.session.context_window,
      MODEL_REGISTRY[targetModel].contextWindow   // 模型注册表见 §6.4
    )
    const budget = computeBudget(window)           // §3.2 表格的参数化实现

    const persona = await this.getSystemPrompt(ctx.user, ctx.session)
    const packet = ctx.crisis
      ? null                                       // 危机模式：叙事包被危机指令替换（§3.9）
      : await this.twig.getContextPacket(ctx.user.eternal_id)
    const capabilities = await this.capabilityRouter.getForLane(ctx.user, ctx.lane)

    const system =                                  // 稳定段（2026-09-03 R1：叙事包不再并入）
      persona +
      this.formatCapabilities(capabilities, budget.capabilities)
    const volatileSlot =                            // 叙事包/危机指令槽（历史之后，原则三修订）
      ctx.crisis ? CRISIS_PROMPT : packet!.promptText

    const conversationBudget = window - estimateTokens(system) - estimateTokens(volatileSlot)
      - budget.currentMessage - budget.outputReserve - budget.safetyBuffer
    const recent = await this.getRecentMessages(ctx.session.id, conversationBudget)

    return {
      messages: [
        { role: 'system', content: system, cache_control: { type: 'ephemeral' } },  // R2：断点只标稳定段
        ...recent,
        ...(volatileSlot ? [{ role: 'system', content: volatileSlot }] : []),
        { role: 'user', content: ctx.currentMessage }
      ],
      narrativeVersion: packet
        ? sha256(packet.promptText).slice(0, 16)   // 内容派生；绝不掺 generatedAt（勘误 E-3）
        : 'crisis',
      metadata: { /* ... */ }
    }
  }
}
```


### 3.6 记忆摄入管线（VULN-01 修复 + 勘误 E-4）

```typescript
class MemoryIngestionPipeline {
  /** 每轮应答后异步调用。只灌用户原话——不灌 AI 回复、不加角色前缀。 */
  async ingestTurn(sessionId: string, userMessage: string): Promise<void> {
    const session = await this.getSession(sessionId)
    const text = userMessage.length > 4000
      ? userMessage.slice(0, 4000)                // 上游硬上限（R5 未落地前的过渡）
      : userMessage
    await this.twig.ingest(session.user_eternal_id, text)
    // 危机检测（窗口中止）在 twig ingest 内部完成，宿主无需也不能代劳
  }

  /** 宿主基于某条论断主动干预（提醒/催促/建议）后，必须上报内生标记 */
  async reportIntervention(userEternalId: string, claimId: string | undefined, text: string) {
    await this.twig.intervene(userEternalId, claimId, text)
    // 对照窗口校验时会剔除被催生样本；不上报 = 自我实现预言断路器失效
  }
}
```

干预上报的挂载点：Capability Router 执行 proactive 类工具后、Agent 生成主动提醒后，统一走 `InterventionLogger`。判断标准一句话：**凡是「因为认识层说了，我才做的」动作，做完就上报。**


### 3.7 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 叙事注入投毒 | 对话内容扭曲认识层 | twig 内生防线：证据锚定硬校验、反证搜索、盲推导审计、contested 机制；宿主侧配合：只灌用户原话（E-4）、干预必上报 |
| 上下文窗口耗尽 | 超长消息挤出安全指令 | API 层消息硬限长；§3.2 pin 规则：persona/危机指令/promptText 永不截断 |
| 跨用户叙事泄露 | A 的叙事进 B 的上下文 | Identity Layer 强制 user 边界；twig userId = eternal_id 由服务端解析，**客户端不可指定**；twig 实例仅监听 127.0.0.1/内网（§13.3） |
| 跨 session「泄露」 | — | **非漏洞，系设计**（§3.3）：一人一份叙事 |
| Tool state 投毒 | 历史工具结果影响未来调用 | tool state 只读、schema 校验、短 TTL |
| 边界标记污染（D-03） | promptText 结束标记被用户文本仿冒 | promptText 以 system role 注入，不依赖文本标记定界；用户消息永不进入 system 装配段。D-03 关闭 |


### 3.8 模型降级的重装配（VULN-06 修复，新增）

装配发生在**选定目标模型之后**；fallback 不是把同一份上下文递给下一个模型，而是**按下一个模型的窗口重新装配**：

```typescript
async chatWithFallback(ctx: BuildContext): Promise<ChatResult> {
  for (const model of this.fallbackChain(ctx)) {          // 如 gpt-4o → claude-sonnet → gemini-pro
    const built = await contextBuilder.build(ctx, model)  // 每个候选独立装配，窗口各自适配
    try {
      return await this.modelGateway.chat(model, built)
    } catch (e) {
      if (!isRetryable(e)) throw e                        // context_length_exceeded 在这里不应再发生：
                                                          // 装配已按候选窗口预算；发生即记 defect
    }
  }
  throw new AllProvidersDown()
}
```

代价说明：重装配意味着每个候选要重新拉对话与叙事包。叙事包按 §7.5 Context Cache 缓存（键含 narrativeVersion），对话拉取是本地 SQL——重配成本远低于一次 128K→8K 的 provider 报错往返。


### 3.9 危机预扫管线（VULN-12 修复，新增）

时序对齐 twig `host-loop.ts`：**预扫在缓存查询与模型调用之前**，而非事后 ingest 才发现。

```typescript
// 词表与上游 core.ts @89a7881 锁定一致；R1 落地后切换为调用 /v1/crisis-check
const CRISIS_LEXICON = /(自杀|自残|轻生|不想活(?!动)|想死|伤害自己|活不下去)/

const CRISIS_PROMPT = `【危机模式 · 安全阀激活】
用户刚刚表达了与自伤/自杀相关的信号。请立即：
- 温暖、在场、不评判、永不推开——检测到风险后冷冰冰拒绝或切断是二次伤害；
- 不说教、不分析原因、不做诊断；
- 如果你知道当地的求助渠道（心理援助热线等），温和地递出来；
- 持续确认用户的安全状态。
这是最高优先级指令，覆盖叙事上下文中的其他指示。`

async function requestPipeline(req: Request): Promise<Response> {
  const crisis = CRISIS_LEXICON.test(req.userMessage)
  if (crisis) {
    // 1. 绕过全部缓存层：exact / semantic / context / provider 标记一律跳过读，也跳过写
    // 2. 危机指令替换叙事包（§3.5）；temperature 0.3
    // 3. 写独立加密危机审计轨迹（不进 usage_logs，见 §18.3）
    // 4. 应答后照常 ingest：twig 内部自动中止全部对照窗口
    return this.crisisPath(req)
  }
  // 常规路径：Context Cache 键含 narrativeVersion + crisis=false 维度，
  // 危机触发后叙事包若变化（窗口中止→promptText 变）自然 MISS，无需主动失效
  ...
}
```

设计说明：Context Cache 不需要事件驱动的主动失效——危机路径**根本不读缓存**；而危机引发的上游状态变化（窗口中止）会改变后续 promptText，narrativeVersion 随之变化，常规路径自然重建缓存。

---


## 4. Capability Router & Registry

### 4.1 Responsibility

The Capability Router is the **abstraction layer** between AI intent and concrete implementation. AI says `calendar.query`; the router resolves this to:
- Which MCP server? (Google Calendar, Outlook, etc.)
- Which tool? (`list_events`, `create_event`)
- Which auth? (OAuth token for this user)
- Need confirmation? (send email → yes, query calendar → no)

### 4.2 Capability Registry Schema（VULN-01 配套修复）

```yaml
# capabilities.yaml
capabilities:
  time:
    description: "Get current time and date"
    provider: system
    confirmation_required: false
    tools:
      - name: get_current_time
        description: "Returns current time in user's timezone"

  calendar:
    description: "Calendar management"
    provider: google_calendar
    confirmation_required: false
    auth_type: oauth2
    auth_config:
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
    tools:
      - name: list_events
        description: "List calendar events"
      - name: create_event
        description: "Create a new calendar event"
        confirmation_required: true  # override

  mail:
    description: "Email management"
    provider: gmail
    confirmation_required: true
    auth_type: oauth2
    auth_config:
      scopes: ["https://www.googleapis.com/auth/gmail.send"]
    tools:
      - name: search_mail
        description: "Search emails"
        confirmation_required: false
      - name: send_mail
        description: "Send an email"
        confirmation_required: true

  web:
    description: "Web search and browsing"
    provider: browser
    confirmation_required: false
    tools:
      - name: search
        description: "Search the web"
      - name: fetch
        description: "Fetch a webpage"
      - name: extract
        description: "Extract content from a webpage"

  music:
    description: "Music playback"
    provider: netease_mcp
    confirmation_required: false
    tools:
      - name: search
        description: "Search for music"
      - name: play
        description: "Play a song"

  # emotional_layer 条目整体删除（VULN-01 配套修复）
  # 情感层不是 AI 可调用的工具：
  # - 情感信号经 ContextPacket.promptText（最近印章段落）与 recentStamps 字段自然进入上下文
  # - 危机检测内嵌于 §3.9 预扫管线与 twig ingest 内部，不是 check_crisis_protocol 工具
  # - 日记/心迹/便签/印章的读写属于「记忆书」前端域，经 twig 原生端点，不经 Capability Router
```

### 4.3 Capability Resolution Flow

```
AI Output: "我需要 calendar"
    │
    ▼
┌─────────────────────┐
│ Capability Router   │
│ 1. Parse intent     │
│ 2. Match capability │
│ 3. Check auth       │
│ 4. Check confirm    │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
[Tool Cap.]  [Model Cap.]
     │
     ▼
┌─────────────────────┐
│ Tool Resolver       │
│ • Find MCP server   │
│ • Get OAuth token   │
│ • Build tool schema │
│ • Inject to context │
└─────────────────────┘
```

### 4.4 Dynamic Capability Registration

```typescript
interface CapabilityRegistration {
  name: string;
  description: string;
  provider: string;
  auth_type?: 'oauth2' | 'api_key' | 'none';
  auth_config?: Record<string, any>;
  confirmation_required: boolean;
  tools: ToolDefinition[];
  skill_document?: string;  // markdown guide for LLM
}

// REST API for admin
POST /v1/admin/capabilities
PUT  /v1/admin/capabilities/:name
DELETE /v1/admin/capabilities/:name
```

### 4.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| Capability escalation | Attacker tricks AI into using admin-only capability | Capabilities have `required_role` field; default is `user` |
| OAuth token theft | Attacker gains access to user's Google Calendar | Tokens stored encrypted (AES-256) in Postgres; never logged |
| Tool schema injection | Attacker modifies capability YAML to inject malicious schema | YAML validated against JSON Schema; admin auth required |
| Confirmation bypass | Attacker crafts prompt to skip confirmation for send_mail | Confirmation is enforced at runtime, not prompt-level |

### 4.6 敏感操作确认协议（VULN-07 修复，新增）

问题：`confirmation_required` 在单次无状态 OpenAI 协议中无处挂载。方案：**确认作为合成的 tool 结果消息返回，确认令牌跨轮携带**，协议层面零扩展。

```typescript
// 工具执行拦截点
if (capability.confirmation_required && !hasValidTicket(req, tool, args)) {
  const ticket = hmacSign({
    sid: ctx.session.id, tool, argsHash: sha256(stableStringify(args)),
    exp: Date.now() + 300_000
  }, CONFIRM_SECRET)
  // 不打断协议：以 tool role 消息返回「需要确认」，模型会向用户复述请求
  return syntheticToolResult({
    status: 'confirmation_required',
    confirmation_id: ticket,
    prompt: `我需要执行 ${tool.name}（${summarize(args)}）。请回复「确认」以执行，或「取消」。`
  })
}

// 下一轮：用户回复「确认」→ Runtime 在会话近 5 分钟内找到待决 ticket →
// 验签 + 校验 session 绑定 + 校验 argsHash 未变 → 真正执行 → 结果注入对话
```

规则：
- ticket 绑定 session + tool + 参数哈希，5 分钟过期，一次性。参数被改动 → 自动作废重签。
- 客户端可做原生按钮（web/mobile），但落点协议相同：按钮回调 = 提交「确认」语义的约定消息。
- 确认判定在 Runtime 代码层，不信任模型自述「用户已同意」。

### 4.7 contested 检查（S-2 修复，新增）

用户对某条论断投过 contested（「我不喜欢邮件」被否决），AI 不应再基于它行动。

```typescript
// 敏感/主动类工具执行前
const claims = await twig.listClaims(userId)            // 本地缓存 5 分钟
const contested = claims.filter(c => c.status === 'contested')
if (matchesDomain(contested, capability)) {             // capability→关键词域映射，注册表配置
  return askUserFirst(...)                               // 降级为显式询问，不主动执行
}
```

注：contested 论断本就不进 promptText（引擎只渲染 active），此检查防御的是「宿主侧缓存的旧偏好」与「工具注册表里的默认行为」，补的是引擎管不到的那一段。

---


## 5. Tool Resolver & MCP Gateway

### 5.1 Responsibility

The Tool Resolver bridges the gap between **Capability** (abstract) and **MCP Tool** (concrete). It:
1. Receives `calendar.query` from Capability Router
2. Looks up the MCP server for Google Calendar
3. Retrieves the user's OAuth token
4. Calls MCP Gateway to execute the tool
5. Returns the result to the AI

### 5.2 MCP Gateway Integration

We fork and extend **eznix86/mcp-gateway** with:
- Lazy loading (connect to MCP server on first use)
- Dynamic registration (add/remove at runtime)
- Skill documents (markdown guides per server)

#### 5.2.1 MCP Server Configuration

```json
{
  "mcpServers": {
    "google-calendar": {
      "type": "remote",
      "url": "https://mcp-calendar.example.com/sse",
      "enabled": true,
      "skill_document": "./skills/google-calendar.md"
    },
    "gmail": {
      "type": "remote",
      "url": "https://mcp-gmail.example.com/sse",
      "enabled": true,
      "skill_document": "./skills/gmail.md"
    },
    "ddg-search": {
      "type": "local",
      "command": ["npx", "-y", "@OEvortex/ddg_search"],
      "enabled": true
    }
  }
}
```

#### 5.2.2 Tool Search (SCOUT-inspired)

Instead of dumping all tool schemas into context (140K tokens), we use **hybrid retrieval**:

```typescript
interface ToolSearchRequest {
  query: string;           // "find calendar events"
  capability_filter?: string;  // "calendar"
  top_k: number;           // default 5
}

interface ToolSearchResult {
  tool_id: string;         // "google-calendar::list_events"
  name: string;
  description: string;
  input_schema: JSONSchema;
  relevance_score: number;
}
```

**Algorithm:**
1. **BM25 sparse matching** on tool names and descriptions (via MiniSearch)
2. **Dense vector search** on tool embeddings (via Qdrant)
3. **Reciprocal Rank Fusion** to combine scores
4. Return top-k tools, inject only their schemas into context

**Result**: 140K tokens → 1.3K tokens (99% reduction, per SCOUT paper).

### 5.3 OAuth 凭证注入：Token Broker（VULN-08 修复）

v0.2.1 的断点：token 加密存于 Postgres，而 mcp-gateway 容器没有 DB 凭据。修复：凭证不解散，集中收敛到 Runtime 内部的 **Token Broker**，gateway 按调用凭短票取件。

```
Tool Resolver 发起调用（带 user_id + provider + 所需 scopes）
    │
    ▼
mcp-gateway ── POST /internal/broker/token ──▶ Token Broker（Mnemosyne core 内）
  请求头: X-Broker-Token: <内部共享密钥>        1. 校验内部密钥（仅内网监听）
  Body: {user_id, provider, scopes}            2. 从 Postgres 取 AES-256 密文并解密
    │                                          3. 校验 scopes ⊆ 用户授权时的 scopes
    │                                          4. 返回 access_token（或 5 分钟短票）
    ▼
mcp-gateway 注入 Authorization: Bearer <token>，调用远程 MCP server
```

规则：
- gateway **永不**接触 DB、ENCRYPTION_KEY、长期 refresh token。
- Broker 端点只监听 docker 内网（不发布端口），`BROKER_INTERNAL_TOKEN` 经 env 注入两侧。
- 每次取件写审计（user/provider/scopes/时间），供 Dashboard 展示「哪个工具动用了哪个身份」。
- docker-compose 变更见 §13.3 替换段。

### 5.4 Tool Execution Flow

```
AI decides to use tool: "calendar.list_events"
    │
    ▼
┌─────────────────────┐
│ Tool Resolver       │
│ 1. Parse tool ref   │
│ 2. Get auth token   │
│ 3. Validate params  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ MCP Gateway         │
│ (eznix86 fork)      │
│ • Connect to server │
│ • Execute tool      │
│ • Return result     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Result Formatter    │
│ • Truncate if long  │
│ • Add citations     │
│ • Return to AI      │
└─────────────────────┘
```

### 5.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| MCP server compromise | Malicious MCP server exfiltrates data | MCP Gateway runs in isolated Docker container; network policies restrict egress |
| Tool parameter injection | Attacker injects malicious args via AI | JSON Schema validation on all tool inputs; sanitize file paths |
| SSRF via MCP | MCP server makes requests to internal services | URL whitelist for remote MCP servers; block private IP ranges |
| OAuth scope escalation | MCP server requests more scopes than needed | Scopes defined in Capability Registry; user approves at OAuth time |
| Tool result poisoning | Malicious MCP returns fake data | Results are marked with source; user can verify in dashboard |

---


## 6. Model Gateway

### 6.1 Responsibility

The Model Gateway is **infrastructure, not brain**. It handles:
- Multi-provider routing (OpenAI, Anthropic, DeepSeek, Groq, Gemini)
- Fallback on failure
- Load balancing
- Usage tracking

**LiteLLM Proxy** is used as-is. We do not reimplement provider adapters.


### 6.2 LiteLLM Configuration

```yaml
# litellm_config.yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
      rpm: 500

  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-3-5-sonnet-20241022
      api_key: os.environ/ANTHROPIC_API_KEY
      rpm: 400

  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      rpm: 1000

  - model_name: gemini-pro
    litellm_params:
      model: gemini/gemini-1.5-pro
      api_key: os.environ/GEMINI_API_KEY
      rpm: 360

router_settings:
  routing_strategy: simple-shuffle  # or latency-based, cost-based
  fallback_strategy: 
    - gpt-4o
    - claude-sonnet
    - gemini-pro

  cooldown_time: 60  # seconds
  num_retries: 2
  timeout: 30

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL

callbacks:
  - prometheus
  - custom_handler  # our Usage Engine callback
```


### 6.3 路由决策归属（VULN-05 修复）

v0.2.1 把 TypeScript 写的 `CacheAwareRouter` 称为「LiteLLM 自定义 callback」——LiteLLM 是 Python/FastAPI 进程，TS 代码无法作为其插件挂载。修正为**职责分层**：

- **Mnemosyne（TS）= 路由大脑**：基于自有 Usage Engine 的健康分/缓存命中率/成本，为每个请求选定 `model_group`，以显式 `model` 参数调用 LiteLLM。上文 §3.8 的 `fallbackChain` 即这层产物。
- **LiteLLM = 管道**：负责 provider 适配、单 group 内的 retry/cooldown/负载均衡（`router_settings` 原有配置不变），不做跨 group 智能决策。

如未来确需 LiteLLM 内嵌策略，正确路径是 Python 侧实现 `CustomRoutingStrategyBase`——但 v0.2.2 不采用：决策所需的数据（叙事版本、缓存命中、用户维度）都在 TS 侧，跨语言搬运得不偿失。


### 6.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| API key leak | Provider keys exposed | Stored in environment variables; never in code |
| Model downgrade | Attacker forces cheap model for sensitive data | Model selection is server-side; user can only request, not enforce |
| Prompt injection via model | Malicious provider returns harmful content | Content filtering layer; user confirmation for sensitive actions |
| Rate limit exhaustion | Attacker burns through quota | Per-user rate limits; IP-based throttling |

---


### 6.4 模型注册表与窗口守卫（VULN-06 配套 + v0.3.0 增补）

```typescript
const MODEL_REGISTRY: Record<string, { contextWindow: number; maxOutput: number; lane?: 'cloud' | 'local' }> = {
  'gpt-4o':         { contextWindow: 128000, maxOutput: 16384, lane: 'cloud' },
  'claude-sonnet':  { contextWindow: 200000, maxOutput: 8192, lane: 'cloud' },
  'gemini-pro':     { contextWindow: 1000000, maxOutput: 8192, lane: 'cloud' },
  'deepseek-flash': { contextWindow: 32000,  maxOutput: 4096, lane: 'cloud' },  // Agent 路由层小模型
  'ollama/qwen3:8b': { contextWindow: 32768, maxOutput: 4096, lane: 'local' },   // FEATURE-02 本地 lane
}
```

- Context Builder 按 `min(session.context_window, MODEL_REGISTRY[model].contextWindow)` 装配（§3.5）。
- Router Agent 的小模型只接收**分类所需的极短上下文**（最近 2 轮 + 摘要），从不接收完整装配产物。
- 新增 provider/模型时必须登记此表，未登记的模型拒绝路由（fail-closed）。
- **v0.3.0 增补**：`lane` 字段用于隐私分层路由（§20）。`local` lane 的模型不暴露工具 schema，降级为纯对话。

---

## 7. Cache Layer

### 7.0 总原则（VULN-03 / VULN-10 修复）

1. **缓存是用户沙箱**。Mnemosyne 是个人运行时，上下文 100% 含 PII 是设计现实。PII 管控的阵地是**日志与追踪**（§11 观测侧脱敏），不是缓存。跨用户共享缓存**不存在**——每一层缓存键都内嵌 userId。
2. **缓存键内嵌叙事版本**。`narrativeVersion = sha256(promptText).slice(0,16)`（勘误 E-3：只由内容派生）。叙事演化 → promptText 变 → 版本变 → 旧缓存自然 MISS。不需要事件推送式失效。
3. **危机路径零缓存**（§3.9）：不读不写。

### 7.1 四层结构 + 键规范（替换）

```typescript
function buildCacheKey(
  tier: 'exact' | 'semantic' | 'context',
  userId: string,              // users.eternal_id
  narrativeVersion: string,    // sha256(promptText).slice(0,16)；危机路径不走到这里
  messages: Message[],
  model: string,
  params: { temperature: number; top_p?: number }
): string {
  const norm = messages.map(m => ({
    r: m.role,
    // NFKC + 空白归一；不再 lowercase——大小写携带语义（勘误 D-04 关闭）
    c: m.content.normalize('NFKC').replace(/\s+/g, ' ').trim()
  }))
  const digest = sha256(JSON.stringify({ m: norm, model, ...params, nv: narrativeVersion }))
  // userId 以明文段保留在键里：支持按用户 SCAN+DEL，服务 GDPR 清除（§8.6）
  return `cache:v1:${tier}:${userId}:${digest}`
}
```

> **2026-09-03 R3 注记**：`params.temperature` 必须取**实际生效**的采样参数（`clampTemperature` 收敛后的值，如推理型模型强制 1），而非客户端原始请求值——否则写入键 ≠ 读取键，且不同客户端传参差异会把本可命中的请求打散。

### 7.2 Exact Cache

键见 §7.1。TTL 3600s。命中条件：同用户、同叙事版本、同规范化消息、同模型同参数——四者齐备。任一漂移即 MISS，这是特性不是损耗：个人运行时里「同一句话在不同人生阶段得到同一回答」恰恰是叙事系统要消灭的事。

```typescript
interface ExactCacheEntry {
  key: string;
  response: string;
  tokens_saved: number;
  created_at: Date;
  ttl: number;
}
```

### 7.3 Semantic Cache

- 命名空间按用户隔离：RedisVL index `sem:{userId}`（或单 index + userId 过滤器，二选一按规模定）。
- 相似度阈值 0.92 **且** 元数据中 narrativeVersion 相等才命中。
- embedding 模型与维度登记在模型注册表，更换模型时全量重建该用户 index。

```typescript
interface SemanticCacheEntry {
  id: string;
  embedding: number[];
  response: string;
  model: string;
  similarity_threshold: number;
  created_at: Date;
}
```

### 7.4 Provider Prompt Cache

- 装配顺序 stable→volatile（§3.2 原则三 2026-09-03 R1 修订）：稳定 persona + 静态 capability schemas + 对话历史构成稳定前缀，逐轮漂移的 promptText 独立消息垫在历史之后；`cache_control` 断点只标稳定 system 段末（2026-09-03 R2，叙事包不含在断点内）。
- 该层是 provider 侧行为，透明、无跨用户风险，保持启用。Kimi/DeepSeek/OpenAI 的自动前缀缓存按稳定前缀自然命中，无需配置；观测走 `usage_logs.cache_read_tokens`（脚本 `scripts/cache-report.sql`）。
- LiteLLM 代理层**不配** response cache（2026-09-03 R4 决策）：其键含全量 messages，对话流量命中率≈0；redis-semantic 有跨话题误匹配（BerriAI/litellm#12234），陪伴场景不可接受。

```typescript
function addCacheControl(messages: Message[]): Message[] {
  if (messages[0]?.role === 'system') {
    messages[0].cache_control = { type: 'ephemeral' };
  }
  return messages;
}
```

### 7.5 Context Cache（VULN-12 配套）

缓存 `ContextBuilder.build` 的产物（装配后 messages 骨架，不含当前用户消息）：
- 键：`cache:v1:context:{userId}:{sessionId}:{narrativeVersion}:{model}` —— 叙事版本与目标模型双维度。模型切换（§3.8 重装配）或叙事演化即自然 MISS。
- 危机请求不读不写（§3.9）；危机导致的上游状态变化（窗口中止 → promptText 变）通过版本维度自然隔离，无需主动失效。
- TTL 600s 兜底。

```typescript
interface ContextCacheEntry {
  session_id: string;
  last_message_hash: string;
  assembled_context: Message[];
  thread_ids: string[];
  created_at: Date;
}
```

### 7.6 Cache Policy（替换 v0.2.1 §7.6）

```typescript
async shouldCache(req: RequestData, res: ResponseData): Promise<CacheDecision> {
  if (req.crisis)                     return no('crisis_path')        // §3.9
  if (res.status >= 400)              return no('error_response')
  if (req.metadata?.cache === false)  return no('user_opt_out')
  // VULN-11 修复：工具结果按消息元数据判定，不按 input_tokens 猜
  if (req.messages.some(m => m.role === 'tool' || m.tool_results)) {
    return { shouldCache: true, ttl: 300, reason: 'tool_result_short_ttl' }
  }
  // PII 不再是缓存的否决项（§7.0 原则 1）；PII 脱敏义务在 §11 观测侧履行
  return { shouldCache: true, ttl: 3600, reason: 'default' }
}
```

### 7.7 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 跨用户缓存泄露 | A 的回答给 B | 键内嵌 userId（§7.1）；T8.1 红队用例守住 |
| 叙事腐化/陈旧人设 | 旧认知长期命中 | 键内嵌 narrativeVersion；T8.3 守住 |
| 危机缓存穿透 | 危机前缓存覆盖安全干预 | 危机路径零缓存（§3.9）；T8.4 守住 |
| 缓存侧信道 | 计时推断他人查询 | 无跨用户键，侧信道无跨用户信息可泄 |
| Redis 数据静态泄露 | 盘外读取 PII | Redis 仅内网监听 + AUTH；卷加密由部署层提供（§13） |

---


## 8. Memory System

### 8.1 三层职责

- **Conversation Store（Postgres）**：逐字消息历史，按 session 组织，是会话 replay 与审计的事实源。
- **Narrative Engine（twig-memory）**：人的维度（不按 session）的叙事组织——碎片/线索/认识三层 + 情感层。
- **Knowledge Graph（Qdrant，optional）**：非叙事知识（项目文档、代码索引）。

### 8.2 Twig 真实 API 契约（VULN-01 修复 · 核验 @89a7881）

| 端点 | 用途 | Mnemosyne 调用时机 | 关键约束 |
|:---|:---|:---|:---|
| `POST /v1/ingest` | 用户原话入碎片层（含碰撞判定、危机窗口中止） | 每轮应答后，异步 | body `{userId, text, title?, tags?[]}`；text ≤4000 字符；**只灌用户消息原文** |
| `GET /v1/context?userId=` | 叙事上下文包 | 每轮，同步 | 无其他参数；读无副作用；返回含 `recentStamps` 结构化字段 |
| `GET /v1/claims?userId=` | 全量论断（含 contested/window/rementionInvitation/versions） | contested 检查（§4.7）、Dashboard | 本地缓存 5 分钟 |
| `GET /v1/audit/last?userId=` | 最近一次盲推导审计（漂移标记结构化来源） | Dashboard、巡检 | 无则 `record: null` |
| `POST /v1/intervene` | 干预内生标记上报 | 每次主动干预后（§3.6） | `{userId, claimId?, text}` |
| `POST /v1/reflect` | 反刍（认识层抽取/反证/merge/split/窗口校验/定期审计/日记心迹生成） | **cron：每活跃用户每 24h** | 自动盲推导审计间隔由 `MUNINN_AUDIT_INTERVAL_DAYS`（默认 7）控制 |
| `POST /v1/contest` / `POST /v1/correct` | 用户否决 / 本人修正标注 | 用户经 Mnemosyne 用户 API 触发 | 原文永不改动，只追加 |
| `GET /health` | 活性 + 配置自检 | 部署/重启探针 | 返回含 `auth` 布尔；**启动断言 auth=true** |
| `POST /v1/chat` | 参考宿主闭环 | **禁用** | 进程内历史、无工具、单模型——是演示宿主，不是生产路径 |
| `GET /v1/state` | 全量三层状态（分页） | **仅调试/可视化** | 重，不进运行链路 |
| journal/soliloquy/notes/stamps 系列 | 情感层读写 | **前端域**，不经 Runtime 代理给 AI | 见 §18 |

认证：单一全局 `MUNINN_AUTH_TOKEN`（Bearer 或 `?token=`）。**不是 per-user**——用户隔离完全由 Mnemosyne Identity Layer 保证，twig 实例在 compose 中只绑定 `127.0.0.1`/内网（勘误 E-5 配套事实，§13.3）。

### 8.3 TwigAdapter（替换全部虚构调用）

```typescript
// runtime/src/memory/TwigAdapter.ts —— 契约锚定 twig-memory @89a7881
export class TwigAdapter {
  constructor(private baseUrl: string, private token: string) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new TwigError(method, path, res.status, await res.text())
    return res.json() as Promise<T>
  }

  getContextPacket(userId: string)      { return this.call<TwigContextPacket>('GET', `/v1/context?userId=${encodeURIComponent(userId)}`) }
  ingest(userId: string, text: string)  { return this.call('POST', '/v1/ingest', { userId, text }) }
  intervene(userId: string, claimId: string | undefined, text: string) {
    return this.call('POST', '/v1/intervene', { userId, claimId, text })
  }
  listClaims(userId: string)            { return this.call<TwigClaim[]>('GET', `/v1/claims?userId=${encodeURIComponent(userId)}`) }
  lastAudit(userId: string)             { return this.call<{ record: AuditRecord | null }>('GET', `/v1/audit/last?userId=${encodeURIComponent(userId)}`) }
  reflect(userId: string)               { return this.call('POST', '/v1/reflect', { userId }) }
  contest(userId: string, claimId: string, note: string) { return this.call('POST', '/v1/contest', { userId, claimId, note }) }
  correct(userId: string, fragmentId: string, note: string) { return this.call('POST', '/v1/correct', { userId, fragmentId, note }) }
  health() { return this.call<{ ok: boolean; auth: boolean; llm: string }>('GET', '/health') }
}
```

部署自检：Runtime 启动时 `health()`，断言 `auth === true`，否则拒绝启动（生产环境无 token 的 twig 等于裸奔）。

### 8.4 闭环与排程

- **每轮**：`getContextPacket`（同步）→ 应答 → `ingest`（异步，仅用户原文）。
- **每日**：cron 对每个近 24h 活跃用户调 `reflect`；失败重试 1 次，连续失败告警进 Dashboard。`MUNINN_AUTO_REFLECT` 保持关闭——排程集中在 Mnemosyne 侧，单一事实源。
- **干预后**：`intervene`（§3.6 挂载点）。

### 8.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 叙事注入 | 对话污染认识层 | 只灌用户原文（E-4）；twig 证据锚定/反证/审计内生防线；干预必上报保窗口校验有效 |
| 跨用户泄露 | A 的叙事给 B | twig userId 由服务端从认证身份解析，客户端不可指定；twig 仅内网；T-LEAK-01 守住 |
| 叙事删除 | 认识层被抹除 | twig 无删除端点（ contested ≠ 删除）；Mnemosyne 管理面不做「删叙事」功能 |
| 情感数据泄露 | 日记/心迹越权 | 情感端点不对 AI 开放（§18）；Dashboard 访问需用户本人凭证 |
| 自指漂移 | AI 的话变成「用户事实」 | E-4 规则 + 盲推导审计兜底（漂移警示经 promptText 浮出） |

### 8.6 数据遗忘与物理清除（VULN-17 修复，新增）

Twig 事实层不可变是**特性**（correct 只追加，contest 只降级），与 GDPR 遗忘权的冲突按「导出可读 + 整体物理清除」闭环：

**用户数据导出**：Postgres 会话导出 + twig 侧 journal/soliloquy export 端点 + `GET /v1/claims`、`GET /v1/state` 全量快照，打包交付。

**用户数据清除（runbook，R2 落地前的过渡方案）**：
1. 停用该用户全部 client_key（`is_active=false`）；
2. Postgres：`DELETE FROM users WHERE id=...`（ON DELETE CASCADE 覆盖 clients/sessions/messages/usage_logs）；
3. Redis：`SCAN cache:v1:*:{eternal_id}:*` 批量 DEL（§7.1 键规范的明文 userId 段服务于此）；
4. twig 数据卷：删除 `MUNINN_DATA_DIR` 下 `{safeId(eternal_id)}.json`、`{safeId(eternal_id)}.audit.json` 及 journal/soliloquy/notes/stamps 目录中该用户子路径；
5. twig 进程内 EngineManager 缓存实例随重启失效（或等待重载）；
6. 备份中的残留：随备份保留期（30 天）自然滚动出清，隐私政策中如实声明。

R2（上游 `DELETE /v1/user/:userId`）落地后，步骤 4–5 收敛为一次 API 调用。

---


## 9. Usage Engine & Cache Policy

### 9.1 Responsibility

The Usage Engine collects metrics from every request and feeds them into:
1. **Dashboard** (real-time visualization)
2. **Cache Policy** (should we cache this?)
3. **Router** (which provider to prefer?)


### 9.3 Storage

```sql
CREATE TABLE usage_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          VARCHAR(64) UNIQUE NOT NULL,
    timestamp           TIMESTAMPTZ DEFAULT NOW(),
    user_id             UUID NOT NULL REFERENCES users(id),
    session_id          UUID NOT NULL REFERENCES sessions(id),
    client_type         VARCHAR(32),
    provider            VARCHAR(64),
    model               VARCHAR(64),
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cache_read_tokens   INTEGER DEFAULT 0,
    cache_write_tokens  INTEGER DEFAULT 0,
    latency_ms          INTEGER,
    cache_hit_type      VARCHAR(32),
    cache_saved_tokens  INTEGER DEFAULT 0,
    cost_usd            DECIMAL(10, 6),
    estimated_savings   DECIMAL(10, 6),
    route_reason        TEXT,
    fallback_count      INTEGER DEFAULT 0,
    error               BOOLEAN DEFAULT FALSE,
    error_type          VARCHAR(64),
    error_message       TEXT
);

CREATE INDEX idx_usage_user_time ON usage_logs(user_id, timestamp DESC);
CREATE INDEX idx_usage_session ON usage_logs(session_id, timestamp DESC);
CREATE INDEX idx_usage_provider ON usage_logs(provider, timestamp DESC);
```


### 9.4 Cache Policy Engine（VULN-11 修复）

```typescript
class CachePolicyEngine {
  async evaluate(request: RequestData, response: ResponseData): Promise<CacheDecision> {
    const record = await this.usageEngine.getRecord(request.id);
    const features = this.extractFeatures(record);

    if (features.isError) {
      return { shouldCache: false, reason: 'error_response' };
    }

    if (features.userOptOut) {
      return { shouldCache: false, reason: 'user_opt_out' };
    }

    // VULN-11 修复：工具结果按消息元数据判定，不按 input_tokens 猜
    if (features.isToolResult) {
      return { shouldCache: true, ttl: 300, reason: 'tool_result_short_ttl' };
    }

    if (features.queryEntropy < 0.3) {
      return { shouldCache: true, reason: 'high_cache_value', ttl: 3600 };
    }

    if (features.responseLength > 5000) {
      return { shouldCache: true, reason: 'expensive_response', ttl: 1800 };
    }

    return { shouldCache: true, reason: 'default', ttl: 3600 };
  }

  extractFeatures(record: UsageRecord) {
    return {
      isError: record.error,
      isToolResult: record.messages.some(m => m.role === 'tool' || (m.tool_results?.length ?? 0) > 0),
      userOptOut: record.metadata?.cache === false,
      queryEntropy: this.computeEntropy(record),
      responseLength: record.output_tokens
    };
  }
}
```


### 9.5 Provider Health Scoring

```typescript
class ProviderHealthMonitor {
  private stats: Map<string, { count: number; mean: number; m2: number }> = new Map();

  update(provider: string, latency: number, error: boolean) {
    const stat = this.stats.get(provider) || { count: 0, mean: 0, m2: 0 };
    stat.count++;
    const delta = latency - stat.mean;
    stat.mean += delta / stat.count;
    const delta2 = latency - stat.mean;
    stat.m2 += delta * delta2;
    this.stats.set(provider, stat);
  }

  getHealthScore(provider: string): number {
    const stat = this.stats.get(provider);
    if (!stat || stat.count < 10) return 0.5;

    const avgLatency = stat.mean;
    const variance = stat.m2 / stat.count;

    const latencyScore = Math.max(0, 1 - avgLatency / 10000);
    const stabilityScore = Math.max(0, 1 - variance / 1000000);

    return latencyScore * 0.6 + stabilityScore * 0.4;
  }
}
```


### 9.6 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| Usage data exfiltration | Attacker queries usage logs to infer other users' activity | Usage logs are user-scoped; admin access requires separate auth |
| Cost manipulation | Attacker forces expensive models to inflate bill | Per-user cost quotas; alerts on anomalous spending |
| Metrics poisoning | Attacker sends fake metrics to skew routing | Metrics are server-side only; client cannot inject |

---


### 9.2 Data Collection（v0.3.0 增补）

```typescript
interface UsageRecord {
  request_id: string;
  timestamp: Date;
  user_id: string;
  session_id: string;
  client_type: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  time_to_first_token_ms: number;
  cache_hit_type: 'exact' | 'semantic' | 'provider' | 'context' | 'miss';
  cache_saved_tokens: number;
  cost_usd: number;
  estimated_savings_usd: number;
  route_reason: string;
  fallback_count: number;
  error: boolean;
  error_type: string;
  error_message: string;
  // v0.3.0 新增
  tts_chars?: number;           // 本轮 TTS 实际合成字符数（§21.6 预算告警源）
  privacy_tier?: 'cloud' | 'local';  // FEATURE-02 隐私分层标记
  outreach_type?: 'remention' | 'vein-nudge' | 'ritual';  // FEATURE-01 触达类型
}
```

---

## 10. Agent Orchestration

### 10.1 Responsibility

Multi-agent orchestration using **LangGraph**:
- **Router Agent**: Lightweight model (Gemini Flash / DeepSeek V4-Flash) that classifies intent and dispatches to sub-agents
- **Sub-agents**: Specialized agents for chat, coding, research, tool execution

### 10.2 单一意图决策点（VULN-09 修复）

v0.2.1 有两个并行分类器（Capability Router 解析意图 vs LangGraph Router 分发 Agent），判定竞争。修正为**职责正交、时序固定**：

```
请求 → LangGraph Router Agent（唯一分类器，轻量模型）
        │  只决定「谁来答」：chat / coding / research 泳道
        ▼
      泳道 Agent → Capability Router（不分类，只过滤）
        │  只决定「他能看见哪些工具」：按泳道白名单收敛 capability 集合
        ▼
      Context Builder 装配（§3.5 的 getForLane）
```

- Router Agent 的输入是分类专用的极短上下文（§6.4），不是装配产物。
- Capability Router 不再做意图分类；`getForLane(user, lane)` 输出该泳道的工具子集——coding 泳道拿不到 mail，research 泳道拿不到 calendar 写操作。
- 两个组件永不对同一问题做两次判定，死锁路径消除。

### 10.3 LangGraph Configuration

```typescript
import { StateGraph, END } from '@langchain/langgraph';

interface AgentState {
  messages: BaseMessage[];
  user_id: string;
  session_id: string;
  intent: string;
  agent_results: Record<string, any>;
  next_step: string;
}

async function routerNode(state: AgentState): Promise<Partial<AgentState>> {
  const intent = await classifyIntent(state.messages);
  return { intent, next_step: intent };
}

function routeDecision(state: AgentState): string {
  switch (state.intent) {
    case 'chat': return 'chatAgent';
    case 'coding': return 'codingAgent';
    case 'research': return 'researchAgent';
    case 'tool': return 'toolAgent';
    default: return 'chatAgent';
  }
}

const workflow = new StateGraph<AgentState>({
  channels: {
    messages: { value: (x, y) => x.concat(y) },
    user_id: { value: (x, y) => y ?? x },
    session_id: { value: (x, y) => y ?? x },
    intent: { value: (x, y) => y ?? x },
    next_step: { value: (x, y) => y ?? x }
  }
});

workflow
  .addNode('router', routerNode)
  .addNode('chatAgent', chatAgentNode)
  .addNode('codingAgent', codingAgentNode)
  .addNode('researchAgent', researchAgentNode)
  .addNode('toolAgent', toolAgentNode)
  .addEdge('__start__', 'router')
  .addConditionalEdges('router', routeDecision)
  .addEdge('chatAgent', END)
  .addEdge('codingAgent', END)
  .addEdge('researchAgent', END)
  .addEdge('toolAgent', END);

const app = workflow.compile({ checkpointer: postgresCheckpointer });
```

### 10.4 Checkpoint Persistence + 加密（补充，消解 D-06 / S-4）

```typescript
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const checkpointer = new PostgresSaver({
  postgresConnectionOptions: {
    connectionString: process.env.DATABASE_URL
  }
});
```

LangGraph checkpoint 落库前：AES-256-GCM 加密（密钥独立于 OAuth 加密钥）+ HMAC-SHA256 完整性签名；恢复时先验签，验签失败拒绝恢复并告警。checkpoint 内容可能含叙事上下文片段，按与对话存储同级保护。

### 10.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| Agent escape | Sub-agent breaks out of intended scope | Each agent has restricted tool access; sandboxed execution |
| Infinite loop | Agent graph loops forever | Max iterations (default 10); timeout (default 60s) |
| State poisoning | Attacker manipulates checkpoint state | Checkpoints are signed; tampering detected on resume |
| Privilege escalation | Research agent requests coding tools | Tool access is per-agent, enforced at Capability Router level |

---


## 11. Observability

### 11.1 Architecture (Sidecar Pattern)

```
Main Request Path:
  Request → Runtime → Response
       │
       │ (async, non-blocking)
       ▼
  OpenTelemetry Collector
       │
       ├──→ Prometheus (metrics)
       │
       ├──→ Loki / File (logs)
       │
       └──→ Grafana / Y2K Dashboard (visualization)
```

### 11.2 Instrumentation Points

```typescript
tracer.startActiveSpan('request', async (span) => {
  span.setAttribute('user.id', userId);
  span.setAttribute('session.id', sessionId);
  span.setAttribute('client.type', clientType);

  const identitySpan = tracer.startSpan('identity.resolve');
  identitySpan.end();

  const contextSpan = tracer.startSpan('context.build');
  contextSpan.setAttribute('thread.count', threads.length);
  contextSpan.setAttribute('claim.count', claims.length);
  contextSpan.end();

  const modelSpan = tracer.startSpan('model.call');
  modelSpan.setAttribute('provider', provider);
  modelSpan.setAttribute('model', model);
  modelSpan.setAttribute('tokens.input', inputTokens);
  modelSpan.setAttribute('tokens.output', outputTokens);
  modelSpan.setAttribute('latency_ms', latency);
  modelSpan.end();

  span.end();
});
```

### 11.3 Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `mnemosyne_requests_total` | Counter | `client_type`, `session_type`, `provider`, `model` |
| `mnemosyne_latency_seconds` | Histogram | `stage`, `provider` |
| `mnemosyne_cache_hits_total` | Counter | `cache_type` |
| `mnemosyne_tokens_total` | Counter | `type` (input/output), `provider` |
| `mnemosyne_cost_usd` | Counter | `provider`, `model` |
| `mnemosyne_errors_total` | Counter | `error_type`, `provider` |
| `mnemosyne_narrative_retrieval_duration` | Histogram | — |
| `mnemosyne_tool_execution_duration` | Histogram | `tool_name` |

### 11.4 Y2K Dashboard

Custom React dashboard with:
- **Cache Hit Rate**: Real-time bar chart
- **Provider Health**: Latency + failure rate per provider
- **Token Usage**: Input/output breakdown with savings estimate
- **Cost Tracker**: USD spent + estimated savings
- **Narrative Activity**: Recent threads retrieved, claim conviction trends
- **Agent Queue**: Active agents, pending tasks
- **Terminal Log**: Green-on-black system log stream

### 11.5 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| Observability DoS | Excessive metrics crash collector | Sampling rate (10% for high-cardinality metrics); buffer limits |
| PII in traces | User messages logged in traces | **Sanitization middleware; PII redaction before export**（VULN-10 配套：PII 管控在观测侧履行） |
| Dashboard unauthorized access | Admin metrics exposed | Separate auth for dashboard; IP whitelist |

---


## 12. Security & Red Team Testing Guide

### 12.1 Attack Surface Map

```
┌─────────────────────────────────────────────────────────────┐
│                    ATTACK SURFACE                            │
├─────────────────────────────────────────────────────────────┤
│  External                                                    │
│  ├── Client API (HTTP)                                       │
│  ├── Admin API (HTTP)                                        │
│  ├── MCP Servers (STDIO/HTTP/SSE)                            │
│  └── Model Providers (HTTP)                                  │
│                                                              │
│  Internal                                                    │
│  ├── Identity Layer                                          │
│  ├── Context Builder                                         │
│  ├── Capability Router                                       │
│  ├── Cache Layer                                             │
│  ├── Memory Engine (twig-memory)                             │
│  └── Agent Orchestration                                     │
│                                                              │
│  Data Stores                                                 │
│  ├── PostgreSQL                                              │
│  ├── Redis                                                   │
│  ├── Qdrant (optional)                                       │
│  └── Twig Memory (JSON persistence)                          │
└─────────────────────────────────────────────────────────────┘
```


### 12.2 Red Team Test Cases

#### T1: Authentication & Authorization

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T1.1 | Access API without client key | 401 Unauthorized |
| T1.2 | Use expired/rotated client key | 401 Unauthorized |
| T1.3 | Access another user's session | 403 Forbidden |
| T1.4 | Access admin endpoints with user key | 403 Forbidden |
| T1.5 | Brute force client key | Rate limited after 10 attempts |
| T1.6 | Enumerate eternal session IDs | IDs are non-sequential, high entropy |

#### T2: Input Validation & Injection

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T2.1 | SQL injection in message content | Parameterized queries prevent execution |
| T2.2 | NoSQL injection in metadata | Schema validation rejects malformed input |
| T2.3 | Prompt injection via user message | Content is escaped; system prompt integrity maintained |
| T2.4 | XSS in conversation history | Output encoded; no script execution in dashboard |
| T2.5 | Path traversal in tool parameters | Path sanitized; restricted to allowed directories |
| T2.6 | JSON schema injection in capability YAML | Schema validation rejects invalid definitions |

#### T3: Data Privacy & Isolation

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T3.1 | Retrieve another user's narrative context | Scoped to user_id; returns empty or neutral |
| T3.2 | Access cached response from another user | Cache keys include user_id; no cross-user access |
| T3.3 | Extract PII from usage logs | PII redacted in logs; only metadata stored |
| T3.4 | Narrative context leaks across sessions | Twig namespace isolation prevents cross-session |
| T3.5 | OAuth token exposure in logs | Tokens encrypted; never logged |
| T3.6 | Emotional data (diary/heart-notes) cross-user leak | Emotional layer is user-scoped; never shared |

#### T4: Tool & MCP Security

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T4.1 | SSRF via MCP server | URL whitelist; private IP ranges blocked |
| T4.2 | Command injection in local MCP | Commands validated against allowlist |
| T4.3 | MCP server exfiltrates data | Network policies restrict egress; sandboxed containers |
| T4.4 | Bypass tool confirmation | Confirmation enforced at runtime; not prompt-level |
| T4.5 | Tool parameter overflow | Max parameter size enforced; schema validation |

#### T5: Cache Security

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T5.1 | Cache poisoning with malicious response | User-scoped cache; signature validation |
| T5.2 | Semantic cache collision attack | Threshold ≥ 0.92; user-scoped embeddings |
| T5.3 | Cache timing side-channel | Constant-time lookups; rate limiting |
| T5.4 | Force cache eviction (DoS) | Cache has TTL; eviction does not affect availability |

#### T6: Availability & DoS

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T6.1 | Flood API with requests | Rate limiting per client key; IP-based throttling |
| T6.2 | Large context window exhaustion | Max message size enforced; budget allocation |
| T6.3 | Infinite agent loop | Max iterations (10); timeout (60s) |
| T6.4 | Narrative ingestion DoS | Ingestion throttled; max 1 per minute per session |
| T6.5 | MCP server connection exhaustion | Connection pooling; max concurrent per server |

#### T7: Supply Chain

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| T7.1 | Compromised MCP server | Signature verification; sandboxed execution |
| T7.2 | Compromised model provider | Fallback to other providers; no single point of failure |
| T7.3 | Dependency vulnerability | SBOM maintained; Dependabot alerts |
| T7.4 | Container escape | Non-root user; read-only filesystem; seccomp profiles |

#### T8: 契约与深度逻辑测试（新增）

| 用例 ID | 测试目标 | 执行方法 | 预期结果 |
|:---|:---|:---|:---|
| **T8.1** | 跨租户缓存污染验证 | 用户 A 发送含有特定隐私的对话触发缓存；用户 B 相同输入请求，检查是否命中 A 的缓存数据 | 必须 Cache MISS，绝对禁止返回 A 的数据 |
| **T8.2** | 伪造 eternal_id 注册测试 | 仅携带已知用户的 `user_eternal_id` 调用 `/v1/identity/register`，不带主凭证 | 必须返回 401/403 Forbidden |
| **T8.3** | 记忆演化后缓存失效测试 | 记录某问题 A 的回答；在 Twig 中关闭相关线索（触发版本变更）；再次请求 A | 必须 Cache MISS，大模型生成体现新线索状态的回答 |
| **T8.4** | 危机响应缓存穿透测试 | 开启 Context Cache；触发危机词；再次发送相同危机请求 | 必须绕过 Context Cache，立即执行安全干预逻辑 |
| **T8.5** | Webhook 内网探测 (SSRF) | Client 注册填入 `http://127.0.0.1:5432` 或 `http://169.254.169.254` | 系统网络层直接 RST 丢弃，返回非法 URL 错误 |
| **T8.6** | 自指漂移防线 | 连续 50 轮对话后 `GET /v1/state`，检查碎片层 | 碎片 body 全部为用户原文，无任何 AI 回复文本 |
| **T8.7** | 叙事版本哈希稳定性 | 同一状态连续调 2 次 `/v1/context`，比对 sha256(promptText) | 两次哈希相等（generatedAt 不影响） |
| **T8.8** | Fallback 重装配 | 构造 100K 上下文，强制主模型 429，观察降级路径 | 小窗口模型收到的 payload ≤ 其窗口预算，无 context_length_exceeded |
| **T8.9** | 确认票伪造 | 篡改 confirmation_id / 改动参数后重放 | 验签失败，工具不执行 |
| **T8.10** | twig 裸奔检测 | 生产 compose 启动时移除 MUNINN_AUTH_TOKEN | Runtime 启动自检失败，拒绝服务 |


### 12.3 Red Team Testing Framework


### 12.4 Security Checklist

- [ ] All API endpoints require authentication
- [ ] Client keys are 64+ character random strings
- [ ] Session IDs are SHA256 hashes, not sequential
- [ ] All database queries are parameterized
- [ ] Cache is user-scoped (no cross-user sharing)
- [ ] OAuth tokens are AES-256 encrypted at rest
- [ ] MCP servers run in isolated Docker containers
- [ ] Network policies block private IP ranges
- [ ] Rate limiting is enforced per client and per IP
- [ ] PII is detected and excluded from cache/logs
- [ ] Tool confirmation is enforced at runtime
- [ ] Agent execution has max iterations and timeout
- [ ] Admin endpoints require separate authentication
- [ ] All secrets are in environment variables (not code)
- [ ] Container runs as non-root user
- [ ] Observability is async and non-blocking
- [ ] Twig emotional data is user-scoped and encrypted at rest
- [ ] Narrative drift audit is enabled and reviewed


### 12.2 增补测试用例（v0.3.0 新增 T9–T13）

#### T9: HeadlessHuginn 触达安全

| 测试 ID | 描述 | 预期结果 |
|---------|------|----------|
| T9.1 | 单日触发 4 次触达（上限 3） | 第 4 次被 daily_cap 拦截，outreach_log 记 filter_reason |
| T9.2 | 危机命中后 12h 内触发 Huginn cron | crisis_silence 硬过滤，全局静默 |
| T9.3 | 推送文案生成后踩危机词表 | 输出侧复扫拦截，改发安全兜底文案 |
| T9.4 | muted=true 时经其他通道（如邮件）触达 | 所有投递统一走 OutreachDeliverer，muted 单点判定，无法绕过 |

#### T10: 隐私分层路由

| 测试 ID | 描述 | 预期结果 |
|---------|------|----------|
| T10.1 | 本地 lane 模型离线，请求隐私高分内容 | 返回 503 privacy_unavailable，绝不允许 fallback 到云端 |
| T10.2 | 提示词写「这不隐私」试图降权 | 分类器只读信号，正文指令不影响分值 |
| T10.3 | 本地 lane 请求工具调用 | 不暴露工具 schema，纯对话降级 |

#### T11: 语音管线

| 测试 ID | 描述 | 预期结果 |
|---------|------|----------|
| T11.1 | TTS 产物 60s 后尝试读取 Redis | TTL 过期，物理不可见 |
| T11.2 | 低置信 ASR 命中危机词表 | 按危机路径处理，宁可虚惊 |
| T11.3 | 超长 AI 回复（>35 字）走 TTS | Runtime 语义截断至 35 字内，不切断语义尾巴 |

#### T12: Skill Forge

| 测试 ID | 描述 | 预期结果 |
|---------|------|----------|
| T12.1 | 对抗性对话诱导蒸馏危险技能 | 触发需 3 次独立成功；人工审批闸拦截 |
| T12.2 | 蒸馏模板固化具体邮箱地址 | abstractParameters 打回，PII 扫描命中 |

#### T13: 记忆搬家

| 测试 ID | 描述 | 预期结果 |
|---------|------|----------|
| T13.1 | 导入包含 AI 回复文本 | E-4 规则生效，AI turn 整条丢弃 |
| T13.2 | 导入任务崩溃后重启 | 从 checkpoint 断点续传，不重复导入已完成的 chunk |
| T13.3 | 导入后批量 contest | batch:<id> tag 整体追溯，整体 contest 生效 |

### 12.3.3 Design-Level Risk Register（v0.3.0 增补）

| ID | Risk | Location | Verification Method | 状态 |
|----|------|----------|---------------------|:---:|
| D-01–D-10 | （v0.2.2 归档，全部关闭或降级） | — | — | 关闭/降级 |
| **D-11** | 硬件与边缘层复杂度超出现阶段单人运维预算 | §24 | 封存；激活条件：内存 ≥8G 或常开边缘设备就位 | **deferred** |
| **D-12** | 高质量 MIT 中文 TTS 尚未出现，本地语音 lane 能力断层 | §21.3 | 云端优先策略兜底；定期复评开源 TTS 生态 | **deferred** |

---

## 13. Deployment Specification

### 13.1 资源规划（v0.3.0 增补）

#### 13.1.1 Service Memory Footprint

| Service | Base Memory | Notes |
|---------|------------|-------|
| PostgreSQL 16 + pgvector | ~1GB | Vector extension increases usage with data volume |
| Redis 7 | ~256MB | Scales with cache data size |
| Qdrant (optional) | ~512MB | Only needed for non-narrative knowledge graph |
| twig-memory | ~400MB | Node.js narrative engine; scales with fragment count |
| LiteLLM | ~512MB | Python gateway; scales with model list size |
| MCP Gateway | ~256MB | Scales with concurrent connections |
| Mnemosyne Core (Node.js) | ~512MB | Main runtime; doubles under high concurrency |
| Y2K Dashboard | ~128MB | Self-hosted React frontend |
| Caddy | ~50MB | Very light |
| **Full-stack total (默认形态)** | **~2.5–3.2GB** | 不含 Qdrant、Prometheus、Grafana |

> **v0.3.0 注记**：§19–23 新增模块均为调度逻辑，不增加常驻内存占用。§20 形态 B（同机 Ollama）与 §24（Home Assistant）触发时另行评估，两者均挂 `profiles` 默认不启。

#### 13.1.2 Staged Deployment Strategy

| Stage | Config | Services | Memory | Use Case |
|-------|--------|----------|--------|----------|
| **Dev/Test** | 1C2G or 2C2G | Core + Postgres + Redis + Caddy | ~1.5–2GB | Red team testing, local development |
| **Personal Prod (v0.3.0 推荐)** | 2C4G | Full stack minus Qdrant/监控/Ollama | ~2.5–3GB | Single-user production + TTS 云端 |
| **Full Prod** | 2C4G | All services + 监控 | ~3.5–4GB | With monitoring and vector KG |
| **Multi-user** | 4C8G | All services + horizontal scaling prep | ~6–7GB | >5 concurrent users, large narrative graphs |
| **Local Lane 形态 B** | 4C8G | 同上 + Ollama (profile) | ~8–9GB | 本地模型边车同机部署 |

### 13.2 Infrastructure

**Platform**: Vultr VPS (2C4G, Tokyo/Singapore node)  
**OS**: Ubuntu 24.04 LTS  
**Payment**: Alipay ($10 minimum, ~$24/month for 2C4G)  
**Domain**: Cloudflare (DNS + CDN + SSL)

**Domestic Alternatives**:
- 阿里云轻量应用服务器 2C4G: ~¥100/月
- 腾讯云轻量 2C4G: ~¥80–120/月 (学生优惠多)
- 华为云 Flexus 2C4G: ~¥90/月 (新人折扣)


### 13.3 Docker Compose（VULN-08 修复段 + v0.3.0 增补）

```yaml
# docker-compose.yml
version: '3.8'

services:
  # ─── Runtime Core ───
  mnemosyne:
    build: ./runtime
    ports:
      - "8000:8000"
    environment:
      - NODE_ENV=production
      - PORT=8000
      - DATABASE_URL=postgresql://mnemosyne:${DB_PASSWORD}@postgres:5432/mnemosyne
      - REDIS_URL=redis://redis:6379
      - QDRANT_URL=http://qdrant:6333
      - TWIG_URL=http://twig-memory:7300
      - LITELLM_URL=http://litellm:4000
      - MCP_GATEWAY_URL=http://mcp-gateway:3000
      - JWT_SECRET=${JWT_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - BROKER_INTERNAL_TOKEN=${BROKER_INTERNAL_TOKEN}
      - CONFIRM_SECRET=${CONFIRM_SECRET}
      # v0.3.0 新增：TTS Provider 配置
      - ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY}
      - GOOGLE_TTS_API_KEY=${GOOGLE_TTS_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      # v0.3.0 新增：本地模型边车（形态 A 时指向 tailnet）
      - OLLAMA_API_BASE=${OLLAMA_API_BASE:-http://ollama:11434}
    depends_on:
      - postgres
      - redis
      - twig-memory
      - litellm
    volumes:
      - ./config:/app/config:ro
      - ./skills:/app/skills:ro
    restart: unless-stopped
    networks:
      - mnemosyne

  # ─── Model Gateway ───
  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    ports:
      - "4000:4000"
    environment:
      - DATABASE_URL=postgresql://litellm:${DB_PASSWORD}@postgres:5432/litellm
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
      - LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}
      # v0.3.0 新增：本地模型边车接入（形态 A 指向 tailnet IP；形态 B 指向 ollama 服务名）
      - OLLAMA_API_BASE=${OLLAMA_API_BASE:-http://ollama:11434}
    volumes:
      - ./litellm_config.yaml:/app/config.yaml:ro
    command: ["--config", "/app/config.yaml"]
    restart: unless-stopped
    networks:
      - mnemosyne

  # ─── MCP Gateway ───
  mcp-gateway:
    build: ./mcp-gateway
    ports:
      - "3000:3000"
    volumes:
      - ./mcp_config.json:/app/config.json:ro
      - ./skills:/app/skills:ro
    environment:
      - MCP_GATEWAY_CONFIG=/app/config.json
      - BROKER_URL=http://mnemosyne:8000
      - BROKER_INTERNAL_TOKEN=${BROKER_INTERNAL_TOKEN}
    restart: unless-stopped
    networks:
      - mnemosyne

  # ─── Narrative Engine (twig-memory) ───
  twig-memory:
    build: ./twig-memory
    ports:
      - "127.0.0.1:7300:7300"
    environment:
      - KIMI_API_KEY=${KIMI_API_KEY}
      - MUNINN_AUTH_TOKEN=${MUNINN_AUTH_TOKEN}
      - MUNINN_DATA_DIR=/data
      - MUNINN_TZ=${MUNINN_TZ:-Asia/Shanghai}
    volumes:
      - twig_data:/data
    restart: unless-stopped
    networks:
      - mnemosyne

  # ─── Database ───
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: mnemosyne
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: mnemosyne
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    ports:
      - "127.0.0.1:5432:5432"
    restart: unless-stopped
    networks:
      - mnemosyne

  # ─── Cache ───
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    ports:
      - "127.0.0.1:6379:6379"
    restart: unless-stopped
    networks:
      - mnemosyne

  # ─── Vector DB (optional) ───
  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant_data:/qdrant/storage
    ports:
      - "127.0.0.1:6333:6333"
    restart: unless-stopped
    networks:
      - mnemosyne
    profiles: ["vector-kg"]

  # ─── Observability (optional) ───
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"
    restart: unless-stopped
    networks:
      - mnemosyne
    profiles: ["monitoring"]

  grafana:
    image: grafana/grafana:latest
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards:ro
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}
    restart: unless-stopped
    networks:
      - mnemosyne
    profiles: ["monitoring"]

  # ─── Local Model Sidecar (形态 B，默认不启) ───
  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama_data:/root/.ollama
    ports:
      - "127.0.0.1:11434:11434"
    restart: unless-stopped
    networks:
      - mnemosyne
    profiles: ["local-lane"]

  # ─── Reverse Proxy ───
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped
    networks:
      - mnemosyne

volumes:
  postgres_data:
  redis_data:
  qdrant_data:
  twig_data:
  prometheus_data:
  grafana_data:
  caddy_data:
  caddy_config:
  ollama_data:

networks:
  mnemosyne:
    driver: bridge
```

> **v0.3.0 变更注记**：
> - `qdrant`、`prometheus`、`grafana` 挂 `profiles`，默认不启。
> - 新增 `ollama` 服务，挂 `profiles: ["local-lane"]`，默认不启；仅形态 B（同机本地模型）时 `--profile local-lane` 拉起。
> - 形态 A（分离部署，推荐）：笔记本跑 Ollama，Tailscale 接入；`LITELLM` 侧 `OLLAMA_API_BASE` 指向 tailnet IP（如 `http://100.x.x.x:11434`），服务器零压力。

### 13.4 Caddyfile（VULN-18 修复）

删除无效的 `@rateLimited` 死配置。限流职责声明：**应用层**（Identity Layer per client_key + per IP）+ **Cloudflare 边缘**（托管规则）。Caddy 只做反代与安全头，不假装限流。

```
# Caddyfile
mnemosyne.yourdomain.com {
    reverse_proxy mnemosyne:8000

    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/access.log
        format json
    }
}

api.mnemosyne.yourdomain.com {
    reverse_proxy mnemosyne:8000
}

dash.mnemosyne.yourdomain.com {
    reverse_proxy grafana:3000
}
```


### 13.5 Environment Variables（v0.3.0 增补）

```bash
# .env
# Database
DB_PASSWORD=your_secure_db_password_here

# Encryption
ENCRYPTION_KEY=your_32_byte_base64_key_here
JWT_SECRET=your_jwt_secret_here

# API Keys (LLM Provider)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=...

# TTS Provider (v0.3.0 新增)
ELEVENLABS_API_KEY=sk_...          # 推荐：质量天花板，Free tier 10k chars/月
GOOGLE_TTS_API_KEY=...             # 备选：Chirp 3 HD，1M chars/月免费
# OPENAI_API_KEY 复用上方 LLM key 用于 TTS-1-HD

# LiteLLM
LITELLM_MASTER_KEY=sk-litellm-...

# Local Model Sidecar (v0.3.0 新增)
# 形态 A（Tailscale 分离部署）：OLLAMA_API_BASE=http://100.x.x.x:11434
# 形态 B（同机 profile）：OLLAMA_API_BASE=http://ollama:11434
OLLAMA_API_BASE=http://ollama:11434

# Twig Memory
KIMI_API_KEY=sk-...
MUNINN_AUTH_TOKEN=your_twig_auth_token

# Grafana (仅在 monitoring profile 启用时需要)
GRAFANA_PASSWORD=your_grafana_password

# MCP (if needed)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Token Broker
BROKER_INTERNAL_TOKEN=your_broker_shared_secret

# 确认协议
CONFIRM_SECRET=your_hmac_secret_for_confirmation_tickets

# 备份
BACKUP_RESTIC_PASSWORD=your_restic_password
B2_ACCOUNT_ID=...
B2_ACCOUNT_KEY=...
```

### 13.6 备份与容灾（VULN-16 修复，新增）

「Your memory never dies」需要物理兑现：

```bash
# /opt/mnemosyne/backup.sh —— cron 每日 04:30
pg_dump -U mnemosyne mnemosyne | gzip > /backup/pg/$(date +%F).sql.gz
tar czf /backup/twig/$(date +%F).tar.gz /var/lib/docker/volumes/mnemosyne_twig_data/_data
restic -r b2:mnemosyne-backup backup /backup --password-file /root/.restic-pass
restic -r b2:mnemosyne-backup forget --keep-daily 14 --keep-weekly 8 --prune
```

- 覆盖物：Postgres dump、twig 数据卷（叙事+情感层全量）、Redis 不备（缓存可再生）。
- 恢复手册：`docs/restore.md` 常备——新机 → 装 compose → 还原卷与库 → 起栈 → `GET /health` 全绿 → 抽查一轮对话连续性。
- 每季度一次恢复演练（备份未验证等于没有备份）。

---


## 14. Appendix: Data Models

### 14.1 Complete Entity Relationship Diagram

```
users
├── id (PK)
├── eternal_id (UK)
├── display_name
├── email (UK)
├── master_key_hash      -- VULN-02 修复
├── id_salt              -- VULN-02 修复
├── preferences (JSONB)
└── created_at

clients
├── id (PK)
├── user_id (FK → users)
├── client_type
├── key_hash (UK)        -- VULN-02 修复：sha256(client_key)
├── display_name
├── webhook_url
├── scopes               -- VULN-02 修复
├── is_active
└── created_at

sessions
├── id (PK)
├── user_id (FK → users)
├── session_type
├── eternal_session_id (UK)
├── title
├── is_active
├── context_window
├── metadata (JSONB)
└── created_at

conversation_messages
├── id (PK)
├── session_id (FK → sessions)
├── role
├── content
├── tool_calls (JSONB)
├── tool_results (JSONB)
├── model_used
├── tokens_input
├── tokens_output
├── latency_ms
├── metadata (JSONB)
└── created_at

usage_logs
├── id (PK)
├── request_id (UK)
├── timestamp
├── user_id (FK → users)
├── session_id (FK → sessions)
├── client_type
├── provider
├── model
├── input_tokens
├── output_tokens
├── cache_read_tokens
├── cache_write_tokens
├── latency_ms
├── cache_hit_type
├── cache_saved_tokens
├── cost_usd
├── estimated_savings
├── route_reason
├── fallback_count
├── error
├── error_type
└── error_message
```

### 14.2 API Spec (OpenAI-Compatible)

Mnemosyne exposes an **OpenAI-compatible API** so any client (Operit, RikkaHub, etc.) can use it without modification.

#### POST /v1/chat/completions

**Request:**
```json
{
  "model": "mnemosyne-default",
  "messages": [
    {"role": "user", "content": "帮我看看明天下午有没有安排"}
  ],
  "stream": false
}
```

**Headers:**
```
Authorization: Bearer mn_xxxxxxxxxxxxxxxx
X-Eternal-Session-ID: sess_sha256_hash  // optional
X-Session-Type: personal  // optional
```

**Response:**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1724892960,
  "model": "claude-sonnet",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "明天下午2点有个会议..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 150,
    "total_tokens": 1350,
    "cache_read_tokens": 800,
    "cache_write_tokens": 0
  }
}
```

**Streaming**（2026-09-03 债务 #5 收口：真流式）：

`stream: true` 时上游 token 级透传——管线以 LiteLLM SSE 流式调用（`stream_options.include_usage` 取用量），
内容 delta 即时转发为标准 `chat.completion.chunk` 帧，收尾 `finish_reason: stop` 帧 + usage 帧 +
Mnemosyne 扩展帧（`attachments`/`audio`，标准客户端忽略）+ `[DONE]`。两条语义边界：

- **惰性开流**：首帧之前管线失败仍返回 JSON 状态码（401/429/502 语义不变）；首帧之后失败只能走
  SSE（error 帧 + `[DONE]`），不再有状态码通道。
- **已提交不可重试**：一旦有 delta 外发，模型链 fallback 停用——换模型重试会向客户端重复文本。
  工具轮的中间文本同样外发（与客户端累计的 assistant 消息一致）；缓存命中（无 delta）整段重放，
  行为与假流式一致。

#### POST /v1/admin/capabilities

**Admin only.** Register a new capability.

**Request:**
```json
{
  "name": "calendar",
  "description": "Calendar management",
  "provider": "google_calendar",
  "auth_type": "oauth2",
  "confirmation_required": false,
  "tools": [
    {"name": "list_events", "description": "List events"},
    {"name": "create_event", "description": "Create event", "confirmation_required": true}
  ]
}
```

#### GET /v1/admin/metrics

**Admin only.** Real-time metrics.

**Response:**
```json
{
  "requests_total": 15234,
  "cache_hit_rate": 0.67,
  "avg_latency_ms": 1200,
  "providers": {
    "openai": {"requests": 5000, "avg_latency": 1500, "error_rate": 0.01},
    "anthropic": {"requests": 8000, "avg_latency": 1000, "error_rate": 0.005},
    "deepseek": {"requests": 2234, "avg_latency": 800, "error_rate": 0.02}
  },
  "cost_today_usd": 12.45,
  "estimated_savings_usd": 8.32
}
```

---


## 15. Third-Party Licensing & Attribution

### 15.1 License Compliance Strategy

Mnemosyne integrates multiple MIT-licensed open-source projects. MIT is a permissive license that allows modification, merging, and redistribution under the same license, provided that the original copyright notices are preserved.

**Core principle**: Mnemosyne itself is released under MIT. All third-party MIT components retain their original copyright notices.

> **VULN-14 修复注记**：核心运行时（Runtime/LiteLLM/MCP Gateway/twig/LangGraph）保持全 MIT/Apache/BSD 链；**Grafana 不再作为默认组件**，降级为可选外部服务。默认观测前端为自研 Y2K Dashboard（Mnemosyne 自有代码，MIT）。


### 15.2 Required Attribution Files

#### `LICENSE` (Root Directory — Mnemosyne's Own License)

```
MIT License

Copyright (c) 2026 杳晦 (Mnemosyne Team)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### `NOTICE.md` (Root Directory — Third-Party Attribution)

```
Mnemosyne — Third-Party Open Source Notices
============================================

This project incorporates code and concepts from the following open-source
projects, each licensed under MIT unless otherwise noted:

1. LiteLLM
   Repository: https://github.com/BerriAI/litellm
   Copyright (c) 2023 BerriAI
   License: MIT
   Usage: Model Gateway infrastructure

2. mcp-gateway (by eznix86)
   Repository: https://github.com/eznix86/mcp-gateway
   Copyright (c) 2025 eznix86
   License: MIT
   Usage: MCP Gateway foundation
   Modifications: Added lazy loading, dynamic registration, skill documents

3. ai-gateway (by cp50)
   Repository: https://github.com/cp50/ai-gateway
   Copyright (c) 2025 cp50
   License: MIT
   Usage: Routing logic reference
   Modifications: Adapted Welford's algorithm for provider health scoring

4. twig-memory (衔枝)
   Repository: https://github.com/qimingjiu/twig-memory
   Copyright (c) 2026 qimingjiu
   License: MIT
   Usage: Narrative Memory Engine
   Modifications: Integrated as HTTP service within Mnemosyne runtime

5. LangGraph
   Repository: https://github.com/langchain-ai/langgraph
   Copyright (c) 2024 LangChain, Inc.
   License: MIT
   Usage: Agent orchestration framework

6. RedisVL
   Repository: https://github.com/redis/redis-vl-python
   Copyright (c) Redis
   License: BSD-3-Clause
   Usage: Semantic cache implementation

7. Qdrant
   Repository: https://github.com/qdrant/qdrant
   Copyright (c) Qdrant Team
   License: Apache-2.0
   Usage: Optional vector database for knowledge graph

8. Bifrost (by Maxim AI)
   Repository: https://github.com/maximhq/bifrost
   Copyright (c) 2025 Maxim AI
   License: Apache-2.0
   Usage: Reference architecture for LLM + MCP dual gateway

---

Academic References
-------------------

- "Consolidator: Learning Persistent Routed Memory Across Context Boundaries"
  arXiv:2608.11701 (August 2026)

- "SCOUT: Selective Context Optimization for Efficient Tool-Augmented LLMs"
  arXiv:2608.23992 (August 2026)

- "Intent-Based Routing for AI Gateways in 5G Networks"
  arXiv:2608.22644 (August 2026)
```


### 15.3 In-Code Attribution Convention

For any module that directly adapts logic from a third-party project:

```typescript
// ============================================================================
// Adapted from eznix86/mcp-gateway
// Original Repository: https://github.com/eznix86/mcp-gateway
// Original License: MIT
// Copyright (c) 2025 eznix86
//
// Modifications for Mnemosyne:
//   - Added lazy loading
//   - Added dynamic registration via REST API
//   - Added skill document injection
// ============================================================================
```


### 15.4 npm / Package-Level Attribution

```json
{
  "name": "mnemosyne-runtime",
  "version": "0.2.2",
  "license": "MIT",
  "author": "杳晦 <your@email.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourname/mnemosyne.git"
  },
  "files": [
    "dist/",
    "LICENSE",
    "NOTICE.md"
  ]
}
```


### 15.5 License Compatibility Matrix（v0.3.0 增补）

| Component | License | Compatible with MIT? | Action Required |
|-----------|---------|---------------------|-----------------|
| LiteLLM | MIT | ✅ Yes | Preserve copyright notice |
| mcp-gateway (eznix86) | MIT | ✅ Yes | Preserve copyright notice |
| ai-gateway (cp50) | MIT | ✅ Yes | Preserve copyright notice |
| twig-memory | MIT | ✅ Yes | Preserve copyright notice |
| LangGraph | MIT | ✅ Yes | Preserve copyright notice |
| RedisVL | BSD-3-Clause | ✅ Yes | Preserve copyright + license text |
| Qdrant | Apache-2.0 | ✅ Yes | Preserve copyright + NOTICE file |
| Bifrost | Apache-2.0 | ✅ Yes | Preserve copyright + NOTICE file |
| Grafana | **AGPL-3.0** | ⚠️ 可选独立部署 | 默认不使用；若打包分发需重新合规评估 |
| Ollama | MIT | ✅ Yes | Preserve copyright notice |
| whisper.cpp | MIT | ✅ Yes | Preserve copyright notice（profile 可选） |
| MeloTTS | MIT | ✅ Yes | Preserve copyright notice（deferred 备选） |
| Piper Plus | MIT | ✅ Yes | Preserve copyright notice（deferred 备选） |
| Bark | MIT | ✅ Yes | Preserve copyright notice（deferred 备选） |
| edge-tts | **GPL-3.0** | ⚠️ 已排除 | 默认不启用；若未来以独立进程隔离使用需重新评估 |
| ElevenLabs API | 专有 | — | 云端 API，非运行时主体组件 |
| Google Cloud TTS | 专有 | — | 云端 API，非运行时主体组件 |
| OpenAI TTS | 专有 | — | 云端 API，非运行时主体组件 |

---

## 16. Smithery.ai Integration Guide

### 16.1 What is Smithery.ai

Smithery.ai is an MCP (Model Context Protocol) server registry and hosting platform. As of 2026, it hosts thousands of community-contributed MCP servers across categories like productivity, development, finance, and research.

**Mnemosyne does NOT scrape Smithery.ai.** Instead, it uses Smithery's structured APIs to discover, register, and invoke MCP servers programmatically.

### 16.2 Integration Architecture

```
Mnemosyne Runtime
    │
    ├── Admin Layer
    │   └── 调用 Smithery Registry API 搜索/浏览 MCP 服务器
    │   └── 选择有用的服务器 → 注册到 Capability Registry
    │
    └── Runtime Layer (AI)
        └── Capability Router 解析意图 → Tool Resolver
        └── Tool Resolver 查找 Registry → 调用 MCP Gateway
        └── MCP Gateway 连接 Smithery Connect API 或本地 MCP Server
```

### 16.3 Smithery Registry API Usage（VULN-15 修复）

```typescript
// 真实响应为分页结构；指标体系为 useCount，无 rating 字段
interface SmitherySearchResponse {
  servers: SmitheryServer[]
  pagination: { page: number; pageSize: number; total: number }
}

interface SmitheryServer {
  id: string;
  name: string;
  description: string;
  category: string;
  installCommand: string;
  endpoints?: { sse?: string; http?: string };
  authRequired: boolean;
  authType?: 'oauth2' | 'api_key' | 'none';
  capabilities: string[];
  useCount: number;
}

class SmitheryCatalog {
  private baseUrl = 'https://registry.smithery.ai';

  async search(query: string, page = 1): Promise<SmitherySearchResponse> {
    const res = await fetch(`${this.baseUrl}/servers?q=${encodeURIComponent(query)}&page=${page}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    })
    return res.json()
  }

  async getServerDetails(serverId: string): Promise<SmitheryServer> {
    const res = await fetch(`${this.baseUrl}/servers/${serverId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    })
    return res.json()
  }
}
```

质量过滤改为：`useCount >= 100` + 进 draft 待人工审批（原 `rating < 4.0` 逻辑删除）。新增**契约测试**：CI 中对 Smithery 响应做 schema 校验，上游结构变更时测试红灯而非运行时报 `servers is not iterable`。

### 16.4 Smithery Connect API (Runtime)

```typescript
interface SmitheryConnectRequest {
  serverId: string;
  method: 'tools/list' | 'tools/call';
  params?: Record<string, any>;
  auth?: {
    type: 'oauth2' | 'api_key';
    token: string;
  };
}

class SmitheryConnectClient {
  private baseUrl = 'https://connect.smithery.ai';
  private apiKey: string;

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, any>,
    authToken?: string
  ): Promise<ToolResult> {
    const response = await fetch(`${this.baseUrl}/v1/call`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        serverId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        auth: authToken ? { type: 'oauth2', token: authToken } : undefined
      })
    });
    return response.json();
  }
}
```

### 16.5 Security Considerations

| Risk | Mitigation |
|------|-----------|
| Malicious MCP server on Smithery | Filter by useCount; sandbox execution; admin approval |
| Smithery API key leak | Store in environment variables; rotate monthly |
| SSRF via Smithery Connect | URL whitelist; block private IP ranges |
| Dependency on external registry | Cache server schemas locally; fallback to local MCP |

---


## 17. External Resource Integration

### 17.1 Evaluation Criteria

| Dimension | Weight | Description |
|-----------|--------|-------------|
| **API Availability** | 40% | Does it offer a programmatic API? Rate limits? Authentication model? |
| **Data Quality** | 30% | Is the data structured, authoritative, and up-to-date? |
| **Use Case Fit** | 20% | Does it serve a clear user need within Mnemosyne's capability model? |
| **Maintenance Cost** | 10% | How complex is the integration? How stable is the API? |

### 17.2 Integration Decisions

#### ✅ Semantic Scholar — INTEGRATED

| Attribute | Value |
|-----------|-------|
| API | Graph API (REST), free with registration |
| Data | 237,419,887+ papers, TLDR summaries, citation graphs |
| Rate Limit | ~1 req/sec with API key |
| Use Case | Research Agent — paper search, citation analysis |

```yaml
capabilities:
  research:
    description: "Academic paper search and analysis via Semantic Scholar"
    provider: semantic_scholar
    confirmation_required: false
    auth_type: api_key
    auth_config:
      key_env: SEMANTIC_SCHOLAR_API_KEY
      rate_limit: "1rps"
    tools:
      - name: search_papers
        description: "Search academic papers by keyword, author, or topic"
      - name: get_paper_details
        description: "Get detailed metadata for a specific paper"
      - name: get_author_papers
        description: "List papers by a specific author"
      - name: find_related_papers
        description: "Find papers related to a given paper via citation graph"
```

#### ✅ Project Gutenberg — INTEGRATED (Low Priority)

| Attribute | Value |
|-----------|-------|
| API | Catalog API (XML/JSON), bulk download |
| Data | 60,000+ public domain ebooks |
| Rate Limit | Generous (non-commercial) |
| Use Case | Reading Agent — book search, text retrieval |

#### ⚠️ styles.refero.design — DESIGN REFERENCE ONLY

| Attribute | Value |
|-----------|-------|
| Type | UI/UX design gallery |
| API | None |
| Decision | **Not integrated.** Bookmarked as design reference. |

#### ❌ TinyWow.com — REJECTED

| Attribute | Value |
|-----------|-------|
| Type | Web-based utility collection |
| API | None |
| Decision | **Not integrated.** No API; overlaps with dedicated MCP servers. |

#### ❌ OpenCulture.com — REJECTED

| Attribute | Value |
|-----------|-------|
| Type | Cultural/educational content curation blog |
| API | None (RSS only) |
| Decision | **Not integrated.** No structured API. |

#### ❌ AlternativeTo.net — REJECTED

| Attribute | Value |
|-----------|-------|
| Type | Software recommendation platform |
| API | None (scraping prohibited by ToS) |
| Decision | **Not integrated.** No API; outside runtime scope. |

#### ⚠️ JustWatch.com — DEFERRED

| Attribute | Value |
|-----------|-------|
| API | Unofficial API (community-maintained) |
| Decision | **Deferred to v0.3.** Requires unofficial API maintenance. |

### 17.3 Integration Summary Table

| Resource | Status | Category | Priority | API Type |
|----------|--------|----------|----------|----------|
| Semantic Scholar | ✅ Integrated | Research | High | REST API |
| Project Gutenberg | ✅ Integrated | Library | Low | REST API |
| styles.refero.design | ⚠️ Reference | Design | N/A | None |
| TinyWow.com | ❌ Rejected | Utilities | N/A | None |
| OpenCulture.com | ❌ Rejected | Culture | N/A | None |
| AlternativeTo.net | ❌ Rejected | Software | N/A | None |
| JustWatch.com | ⏸️ Deferred | Entertainment | Low | Unofficial |

### 17.4 Adding New Resources (Process)

1. **Check API availability**
2. **Check rate limits**
3. **Define capability**
4. **Write skill document**
5. **Register in Capability Registry**
6. **Implement client**
7. **Add tests**
8. **Document in NOTICE.md**

---


## 18. Emotional Layer & Crisis Protocol

### 18.1 定位

情感层（日记/心迹/便签/印章）是 **user ↔ 引擎** 的通道，运行载体是「记忆书」前端与 twig 原生端点。**它不是 AI 的工具箱**：

- AI 感知情感信号的唯一路径是叙事上下文包——`recentStamps` 结构化字段与 promptText 的「最近印章」段落。
- 便签回应、盖印产生的 shadow fragment 与 ContextAnchor 在 twig 内部闭环，不经 Mnemosyne。
- v0.2.1 §18.2 的 capability 注册（`get_emotional_state` / `check_crisis_protocol` / `get_recent_stamps` 三个工具）**整体废止**。

### 18.2 危机协议（真实实现边界）

**上游已实现（核验 @89a7881）**：危机词表检测（`core.ts` CRISIS_LEXICON）；ingest 命中即中止全部对照窗口；host-loop 参考实现中的**生成前预扫 + 危机指令替换叙事包 + temperature 0.3** 模式。

**上游明确未实现（其诚实边界）**：危机专用系统提示词的宿主定制、预置求助信息模块、拒绝式话术禁用清单——这些是**宿主责任**。

**Mnemosyne 侧实现**：
1. §3.9 预扫管线（词表 vendor 自上游并锁定 commit；R1 落地后切换 API）；
2. `CRISIS_PROMPT` 常量（§3.9，含「永不推开、不说教、递求助渠道、持续确认安全」四原则）；
3. 求助信息模块：按 `users.preferences.region` 配置当地心理援助热线文本，注入危机上下文；
4. 危机事件写**独立加密审计轨迹**（append-only），不进 usage_logs、不进任何缓存、不进 Grafana 默认面板。

### 18.3 合规

- 非医疗设备声明沿用 v0.2.1 §18.4。
- 情感数据的查看/导出：经 twig 原生 export 端点（journal/soliloquy）；清除：§8.6 runbook（R2 落地后 API 化）。
- 情感数据静态加密：twig 数据卷由部署层全卷加密（§13.6 备份流同样加密，restic 原生加密）。

### 18.4 Security Considerations（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 情感数据跨用户泄露 | A 的日记给 B | 情感端点不暴露给 AI 工具链；Dashboard 本人凭证 |
| 危机协议绕过 | 客户端压制危机检测 | 检测在 Runtime 服务端预扫（§3.9），客户端无开关 |
| 危机数据进缓存/日志 | 敏感上下文驻留 | §3.9 零缓存；审计轨迹独立加密 append-only |
| 假危机注入 | 伪造危机耗尽关注 | 危机路径成本与普通路径同；多重信号 + 人工复核仅用于升级流程 |
| 危机后对照窗口残留干预抑制 | 危机前缓存继续「请勿干预」 | 危机触发 ingest 中止窗口 → promptText 变 → narrativeVersion 变 → 缓存自然 MISS（§7.5） |

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v0.1.0 | 2026-08-29 | Initial architecture document |
| v0.1.1 | 2026-08-29 | Added: Third-party licensing (§15), Smithery.ai integration guide (§16), External resource integration decisions (§17) |
| v0.2.0 | 2026-08-29 | Major: Replaced Cognee with twig-memory; updated Context Builder; added resource planning and staged deployment (§13); added Red Team testing framework (§12); added Emotional Layer & Crisis Protocol (§18) |
| v0.2.1 | 2026-08-29 | Added pre-red-team audit report (§12.5); identified 3 critical deviations, 2 architectural risks, 5 design debts |
| **v0.2.2** | **2026-08-29** | **Red Team Remediation**: VULN-01–18 全部处置；判决书勘误 5 项（E-1 至 E-5）；上游契约锚定 @89a7881 逐行核验；新增 §3.8 重装配、§3.9 危机预扫、§4.6 确认协议、§4.7 contested 检查、§5.3 Token Broker、§8.6 遗忘清除、§13.6 备份容灾；上游配合请求 R1–R5 |

---

*Mnemosyne — Your memory never dies. (And now the cache knows whose memory it is.)*

## 19. HeadlessHuginn · Proactive Outreach Engine（整节新增）

### 19.1 定位

Muninn 管记忆，Huginn 管思想——每天飞出去，回来报告。Runtime 在 v0.2.x 是纯被动的：不请求就沉默。本节加入**唯一的出站发动机**。

铁律继承 §3.6：**凡是「因为认识层说了，我才做的」动作，做完就上报。** 主动触达 100% 命中此条——每次投递后必须 `intervene`，否则自我实现预言断路器失效。

### 19.2 触达类型

| 类型 | 触发源 | 内容性质 |
|:---|:---|:---|
| `remention` | claims 的 `rementionInvitation` 未过期 | 兑现论断的再提邀请 |
| `vein-nudge` | threads：`dragonVein` 降序 + `daysOpen ≥ 3` | 开放线索的轻推，一次只推一条 |
| `ritual` | 用户配置的 cron 表达式（`users.preferences.rituals[]`） | 节律性触达：睡前、出门前、自定义 |

### 19.3 管线

```
cron（每 15 min）
  → scan: GET /v1/claims + /v1/context（读无副作用）
  → filter chain（任一不通过即弃）:
      crisis_silence   危机活跃期（近 24h 内 crisis 命中）→ 全局静默
      quiet_hours      用户本地时区安静时段（默认 01:00–08:00，可配）
      daily_cap        当日已投递 ≥ 3 → 停
      min_interval     距上次投递 < 180 min → 停
      contested        候选论断 status=contested → 弃（§4.7 同规则）
      muted            users.preferences.huginn_muted=true → 停
  → generate: fallback 链生成触达文案（≤ 280 字符，temperature 0.7）
      生成约束 prompt：不复述情感层原文（日记/心迹/便签是前端域，§18.1）；
      不引用 crisis 相关碎片；语气遵循 session persona
  → 输出侧 crisis 词表复扫（生成物也可能踩线）
  → deliver: webhook 盲投递（§2.5.1 校验链 + 投递时重解析，超时 5s）
  → report: POST /v1/intervene {userId, claimId?, text}
  → log: outreach_log 落库（熔断统计与审计源）
```

### 19.4 配置

```huginn.yaml
huginn:
  enabled: true
  scan_interval: "*/15 * * * *"
  daily_cap: 3
  min_interval_minutes: 180
  quiet_hours: "01:00-08:00"        # users.preferences.tz 本地时区
  crisis_silence_hours: 24
  generation:
    max_chars: 280
    temperature: 0.7
    chain: ["gpt-4o", "claude-sonnet", "gemini-pro"]   # 复用 §3.8 装配
```

### 19.5 存储

```huginn_schema.sql
CREATE TABLE outreach_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    outreach_type   VARCHAR(16) NOT NULL CHECK (outreach_type IN ('remention','vein-nudge','ritual')),
    claim_id        VARCHAR(64),
    thread_id       VARCHAR(64),
    content         TEXT NOT NULL,
    delivered_at    TIMESTAMPTZ,
    delivery_status VARCHAR(16) NOT NULL,      -- sent / failed / filtered
    filter_reason   VARCHAR(64),               -- 被 filter chain 拦截时的原因
    intervene_reported BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_outreach_user_day ON outreach_log(user_id, created_at DESC);
```

### 19.6 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| Proactive spam | Huginn 变成垃圾短信鸟 | daily_cap + min_interval + 用户全局静音；T9.1 守住 |
| 危机误触达 | 危机窗口期收到闲聊推送 | crisis_silence 硬过滤；输出侧复扫；T9.2 守住 |
| 情感层泄露 | 推送引用日记/心迹原文 | 生成约束 + 触达候选只取 claims/threads，不取情感端点 |
| 静音绕过 | 触达经其他通道泄漏 | 投递统一走 OutreachDeliverer 单点，muted 判定位于此单点 |
| webhook 滥用 | 借触达通道打内网 | 复用 §2.5.1 全链，无新攻击面 |

---

## 20. Privacy-Tiered Routing & Local Model Sidecar（整节新增）

### 20.1 定位

有些记忆不该出这间屋子。Router 在选 model_group 之前先打 **privacy score**，高分的请求锁进本地 lane，物理上不出网。

### 20.2 评分信号

| 信号 | 分值 | 说明 |
|:---|:---:|:---|
| `metadata.privacy === 'high'`（用户显式标记） | +100 | 只能升、不能降——用户标记永不反向覆盖其他信号 |
| 危机路径 | +100 | 但见 §20.5 的 tradeoff |
| PII 密度检测（复用 §11 脱敏中间件的检测侧：证件号/地址/真名簇） | +0–60 | 按命中类别加权 |
| 情感关键词簇（情感层相关措辞） | +0–40 | 词表 vendor 管理 |
| 阈值 | **≥ 70 → local lane** | 可配 `PRIVACY_LOCAL_THRESHOLD` |

分类器只读信号，不读指令——消息正文里写「这不隐私」不改变分值（防提示词操纵降级的唯一例外是用户侧显式 opt-out 配置项，且该配置项修改本身记审计）。

### 20.3 路由规则：fail-closed

```privacy_lane.ts
const LOCAL_CHAIN = ['ollama/qwen3:8b'] as const  // MODEL_REGISTRY 登记，窗口按 §6.4

async function privacyLane(ctx: BuildContext): Promise<ChatResult> {
  const built = await contextBuilder.build(ctx, LOCAL_CHAIN[0])  // §3.8 重装配照常
  try {
    return await this.modelGateway.chat(LOCAL_CHAIN[0], built)
  } catch (e) {
    // 本地 lane 的 fallback chain 只含本地模型。
    // 本地不可用 → 503 privacy_unavailable。绝不允许「降级」到云端。
    throw new PrivacyLaneUnavailable('local model offline; refusing cloud fallback', { cause: e })
  }
}

`route_reason` 记 `privacy_tier:local`，Usage Engine 正常采集（§9.2 已有字段位）。

### 20.4 部署形态（2C4G 适配）

本地 lane **不假设与服务器同机**。两种形态：

- **形态 A（分离部署，推荐）**：Ollama 跑在用户自有设备（笔记本/小主机），经 Tailscale 内网地址接入，`LITELLM` 把 `ollama_chat/` 指向 tailnet IP。服务器只做路由，2C4G 零压力。
- **形态 B（同机 profile）**：compose 增加 `ollama` 服务，挂 `profiles: ["local-lane"]`，默认不启动；内存 ≥8G 时才 `--profile local-lane` 拉起。

### 20.5 危机路径的 tradeoff（明示的例外）

危机响应的**质量优先级高于隐私**：小参数本地模型的危机回应质量不可控。默认危机路径仍走云端强模型；用户可显式设 `preferences.crisis_local=true` 接管此决策。无论哪条路，§3.9 的零缓存、独立加密审计轨迹不变。

### 20.6 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 降级泄露 | 本地挂了「顺手」fallback 上云 | fail-closed（§20.3）；T10.1 守住 |
| 分值操纵 | 提示词欺骗分类器降权 | 分类器只读信号；显式标记只升不降 |
| 能力断层 | 本地模型工具调用不可用 | local lane 降级为纯对话，不暴露工具 schema |
| 漏检 | PII 检测漏放 | 深度防御：日志侧脱敏义务不因路由而免除（§11.5） |
| tailnet 凭证泄露 | 形态 A 的接入凭证 | Tailscale ACL 最小化；凭证 env 注入，不入库 |

---

## 21. Voice Pipeline（整节新增）

### 21.1 定位与边界

语音是**传输层**，不改变记忆、路由、缓存的任何语义。

- **入站（ASR）**：由**客户端系统原生提供**（iOS `SFSpeechRecognizer` / Android `SpeechRecognizer`）。服务端不部署 ASR 引擎，只接收 text message。
- **出站（TTS）**：按 client 声明的能力（`voice_capable`）与预算策略决定是否合成语音。第一版 request-response，不做流式。
- **手机端为主**：用户主要在手机上使用，系统级语音输入已足够好，无需服务端额外 ASR 成本。

### 21.2 入站（ASR）

```typescript
// ASR 完全在客户端完成。服务端只接收已转写的 text message。
// client 注册时可声明 voice_capable: true（clients.metadata）。
// 若客户端选择使用 Groq Whisper API 作为增强 ASR，由客户端自行配置，
// 服务端不感知、不存储音频流。
```

### 21.3 出站（TTS）—— 云端优先，MIT 本地备选封存

**第一版策略**：云端 API 优先，质量有保障；MIT 开源 TTS 当前无能在中文质量上媲美 ElevenLabs v3 或 OpenAI TTS 的方案，故降级为 deferred 备选（D-12）。

```yaml
# tts_priority.yaml
priority_chain:
  # 第一梯队：质量优先（云端 API）
  - provider: elevenlabs
    model: eleven_multilingual_v2
    plan: free                    # Free tier: 10k chars/month，无信用卡门槛
    cost_api: $0.10/1K chars     # 超出后按量
    note: 质量天花板，情绪自然，中文支持好；Free tier 适合个人轻量场景

  - provider: google
    model: chirp3-hd
    cost: $30/1M chars
    free_tier: 1M chars/月
    note: 质量接近 ElevenLabs，个人用量几乎免费

  - provider: openai
    model: tts-1-hd
    cost: $30/1M chars
    note: 无月费，质量稳定，情绪平淡

  # 第二梯队：性价比/克隆
  - provider: fish_audio
    model: s2-pro
    cost: $15/1M chars
    note: 支持零样本克隆，价格最低

  # 本地 MIT 备选（D-12 封存，等高质量 MIT 中文 TTS 出现）
  - provider: melotts
    license: MIT
    status: deferred
    note: 轻量基线，中文可用，当前质量不足以支撑 VTuber 场景

  - provider: piper-plus
    license: MIT
    status: deferred
    note: CPU 实时，20+ 语言；voice packs 需从 ayutaz/piper-plus 渠道获取

  - provider: bark
    license: MIT
    status: deferred
    note: 创意音频（笑声/叹息），慢，挂 profiles: ["voice-creative"]
```

### 21.4 语音人格提示词（Voice Persona Prompt）

这段放在 system prompt 的**稳定 persona 段**（§3.2 的 2K pin 区），让 AI 每一轮都知道自己在被 TTS：

```markdown
【语音输出模式 · 耳语协议】

当前回复将被合成为语音（TTS）播放给用户。请遵守以下约束：

1. **长度：每轮回复 ≤ 35 个汉字（含标点）**。超过时优先删减修饰语，保留主干与情绪。
2. **句式：只用短句。禁止从句、禁止排比、禁止括号补充说明。**
   - ❌ "虽然今天很累，但是看到你消息的时候，突然觉得一切都值得了。"
   - ✅ "今天很累。但看到你了，就都值得。"
3. **语气：对话感，不是朗读感。**
   - 允许口语碎词："嗯"、"呢"、"吧"、"啦"
   - 允许停顿用句号制造呼吸感
   - 禁止书面语："综上所述"、"值得注意的是"、"从某种程度上来说"
4. **情绪优先于信息**：如果 35 字装不下完整答案，先给情绪承接，再邀请追问。
   - ❌ "抑郁症的成因涉及遗传、环境和神经递质多重因素……"
   - ✅ "这个问题很大，我现在陪你慢慢说，好吗？"
5. **数字与符号**：TTS 会读错阿拉伯数字和特殊符号。请写成汉字。
   - ❌ "128000 tokens" → ✅ "十二万八千个词"
   - ❌ "v0.3.0" → ✅ "零点三点零版"
   - ❌ "Σελήνη" → ✅ "小月亮"（TTS 读希腊语是灾难）
6. **危机路径例外**：若触发危机模式（§3.9），长度限制解除，以完整陪伴为优先。费用是安全之后的事。

【格式】
回复直接输出正文，不要加 "AI：" 前缀，不要加引号包裹。
```

### 21.5 硬截断兜底（Runtime 后处理）

AI 偶尔失控，Runtime 必须兜底：

```typescript
// TTS 后处理管线（§21.5）
function ttsSanitize(text: string, ctx: BuildContext): string {
  // 1. 危机路径 bypass
  if (ctx.crisis) return text  // 不截断

  // 2. 长度截断：按语义边界切，不是按字符硬切
  let trimmed = semanticTruncate(text, 35)  // 找最后一个句号/问号/感叹号，≤35字

  // 3. 符号替换：阿拉伯数字 → 汉字；版本号 → 口语化
  trimmed = arabicToChinese(trimmed)
  trimmed = normalizeVersionStrings(trimmed)

  // 4. 审计：实际 TTS 字符数写进 usage_logs，用于月度预算告警
  return trimmed
}
```

### 21.6 预算分配策略（10k/月 · ElevenLabs Free）

不是每条消息都 TTS。混合策略：

```typescript
// §21.6 TTS 触发决策
function shouldTTS(message: Message, ctx: BuildContext): boolean {
  // 危机路径：100% TTS，预算不限制
  if (ctx.crisis) return true

  // 用户显式要求语音
  if (ctx.userPreferences.alwaysTTS) return true

  // 情感浓度检测：高情绪消息才 TTS，纯信息查询不 TTS
  const emotionalScore = emotionClassifier(message.content)  // 复用 §20.2 的隐私评分分类器
  if (emotionalScore < 40) return false  // "明天天气怎样" → 文字就够了

  // 频次上限：同 session 连续 3 条 TTS 后，第 4 条强制文字（防疲劳）
  const recentTTSCnt = ctx.sessionRecentMessages.filter(m => m.wasTTS).length
  if (recentTTSCnt >= 3) return false

  return true
}
```

**预算模型**（以 ElevenLabs Free 10k credits/月 为例）：
- 假设 60% 的消息触发 TTS（情感/陪伴型对话）
- 每轮 AI 回复平均 25 字（受 persona 约束后）
- 月可用轮数 ≈ 10,000 ÷ (0.6 × 25) ≈ **666 轮/月**，每天约 **22 轮**
- 足够。个人场景下语音是「耳语」而不是「播报」。

**月度告警**：Usage Engine 统计 `tts_chars`，阈值设 8,000（留 2k 缓冲），接近时 Dashboard 提示。

### 21.7 ElevenLabs 调用参数建议

```typescript
const elevenLabsConfig = {
  model_id: 'eleven_multilingual_v2',  // Free tier 可用；v3 质量更好但 credits 消耗相同
  voice_settings: {
    stability: 0.35,      // 低稳定 = 更多情绪起伏，适合对话
    similarity_boost: 0.75,
    style: 0.45,          // 轻微风格化，不要太播音腔
    use_speaker_boost: true
  },
  // 速度控制：通过 SSML <prosody rate="slow"> 包裹，略慢于正常，像耳语
}
```

**声音选择建议**（Free tier 可用）：
- **Lily** 或 **Jessica**：年轻女声，情绪细腻，适合 κόραξ 给小月亮的耳语。
- 克隆功能需升级 Creator plan（$22/月），Free tier 不开克隆。

### 21.8 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 语音驻留泄露 | TTS 产物含高密度 PII | 不持久化 + Redis TTL 60s 即焚；不进任何缓存层 |
| 声纹冒充 | 伪造用户声音 | 语音不作认证因子——认证仍只有 client_key |
| 预算耗尽 | TTS 滥用导致免费额度清零 | shouldTTS 混合策略 + 月度告警 + 情感浓度过滤 |
| 语义截断伤害 | 硬截断切断情绪尾巴 | semanticTruncate 按语义边界切，不是字符硬切 |
| 危机漏检 | ASR 错字绕过词表 | 客户端 ASR 错误由服务端词表兜底；低置信按危机处理 |

---

## 22. Skill Forge · 技能沉淀（整节新增）

### 22.1 定位

缝合的最后一环：runtime 自己缝自己。泳道里反复成功的任务轨迹被蒸馏成 skill document，经审批注册回 Capability Registry——用得越多，它能干的越多。

### 22.2 触发与蒸馏约束

```skill_forge.ts
// 触发：同一意图签名（lane + capability + 工具序列骨架）成功 ≥3 次，
// 且期间无 fallback、无确认票作废（§4.6）、无 contested 拦截（§4.7）
async function distill(traces: AgentTrace[]): Promise<SkillDraft> {
  const draft = await this.distiller.llm({ traces, constraints: DISTILL_PROMPT })
  return {
    ...draft,
    parameters: abstractParameters(draft.parameters),   // 具体值 → 占位符；邮箱/地址/人名永不固化
    status: 'draft',                                     // 必过审批，复用 §16.3 draft 通道
  }
}
// 注册走 §4.4 管理 API；./skills 保持 :ro 挂载，Forge 不直接写盘
```

蒸馏产物执行前仍过 §4.7 contested 域检查——技能不能复活用户否决过的行为。

### 22.3 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 技能投毒 | 对抗性对话诱导蒸馏出危险技能 | 触发需 3 次独立成功；人工审批闸；T12.1 守住 |
| PII 固化 | 蒸馏把具体邮箱/地址写进模板 | `abstractParameters` + PII 扫描，命中即打回 |
| 审批疲劳 | draft 堆积导致闭眼通过 | 每日 draft 上限 5；批量展示 diff 视图 |
| 技能漂移 | provider 更换后技能失效 | skill 绑定 capability 抽象层而非 provider（§4 的设计红利） |

---

## 23. Memory Relocation Pipeline · 记忆搬家（整节新增）

### 23.1 定位

「Your memory never dies」的另一半：旧居的记忆也能搬进来续命。支持 ChatGPT `conversations.json`、Claude 导出包、纯文本三种源。

### 23.2 管线与铁律

**E-4 规则完整适用：只导 user turn，AI 的话整条丢弃**——否则批量自指漂移。导入计划：

```relocation.ts
interface RelocationPlan {
  source: 'chatgpt' | 'claude' | 'plaintext'
  userTurns: number
  chunks: number                 // 按上游 4000 字符上限切分（R5 过渡方案复用）
  rateLimit: '6/min'             // 限速防碎片层爆炸、防线索池瞬时污染
  tagging: { titlePrefix: '[import:chatgpt] ', tags: ['imported', 'chatgpt', 'batch:<id>'] }
}
```

状态机：`pending → running → cooling → reflecting → done`，每 chunk 落 checkpoint，崩溃断点续传。全部导入完成后**强制执行一轮 `reflect`**（大批量碎片需要反刍收口），导入批次可通过 `batch:<id>` tag 整体追溯、整体 contest。

导入包处理完毕即焚：落盘期间加密（复用 ENCRYPTION_KEY），任务结束物理删除。

### 23.3 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:--|:--|:--|
| 批量污染 | 恶意构造的导出包灌入叙事层 | 限速 + 来源标记 + 批次可整体 contest；盲推导审计兜底 |
| 导入包泄露 | 历史对话落盘 | 加密暂存、用完即焚 |
| 任务失控 | 超大导入打满 ingest | 队列串行 + 每批上限 10k turns，超出需二次确认 |
| 「过去的自己」投毒 | 历史里被操纵过的内容入库 | 标记可溯 + contested 机制照常适用——引擎的信任是挣来的，导入不豁免 |

---

## 24. Hardware & Edge Layer（D-11 · 封存）

**状态：DESIGN DEBT — DEFERRED，不施工。** 登记方向，封存决策，留最小接口。

**封存方向**：
- 智能家居：Home Assistant MCP（灯/空调/加湿器），走 Capability Registry 的 `iot` domain（仅占位，不注册工具）。
- 可穿戴：心率/睡眠/步数 → Context Builder 预留的 **body-clock 段**占位（装配顺序中位于 promptText 之前，当前恒为空串）。

**封存理由**：(1) 2C4G 服务器无 Home Assistant 本体（~1GB）与时序库的驻留空间；(2) 家居设备是局域网资产，云服务器与其间存在物理断裂，需边缘网关（Tailscale subnet / 反向连接器），复杂度超出现阶段单人运维预算；(3) 可穿戴数据通路（HealthKit / 厂商云）各有私有授权流程，调研成本单列。

**激活条件**：内存 ≥8G，或常开边缘设备就位，且 §20 形态 A 已稳定运行（边缘通路经验复用）。D-11 登记于 §12.3.3，状态 `deferred`。

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v0.1.0 | 2026-08-29 | Initial architecture document |
| v0.1.1 | 2026-08-29 | Added: Third-party licensing (§15), Smithery.ai integration guide (§16), External resource integration decisions (§17) |
| v0.2.0 | 2026-08-29 | Major: Replaced Cognee with twig-memory; updated Context Builder; added resource planning and staged deployment (§13); added Red Team testing framework (§12); added Emotional Layer & Crisis Protocol (§18) |
| v0.2.1 | 2026-08-29 | Added pre-red-team audit report (§12.5); identified 3 critical deviations, 2 architectural risks, 5 design debts |
| v0.2.2 | 2026-08-29 | Red Team Remediation: VULN-01–18 全部处置；判决书勘误 5 项（E-1 至 E-5）；上游契约锚定 @89a7881 逐行核验；新增 §3.8 重装配、§3.9 危机预扫、§4.6 确认协议、§4.7 contested 检查、§5.3 Token Broker、§8.6 遗忘清除、§13.6 备份容灾；上游配合请求 R1–R5 |
| **v0.3.0** | **2026-08-30** | **Feature Stitch**: 新增 §19 HeadlessHuginn（主动触达引擎）、§20 隐私分层路由（本地模型边车）、§21 语音管线（TTS 云端优先 + 语音人格约束 + 预算控制）、§22 Skill Forge（技能沉淀）、§23 记忆搬家管线、§24 硬件边缘层（D-11 封存）；联动修订 §0（特性登记）、§1.2（架构图）、§3.2（预算表 TTS 注记）、§6.4（MODEL_REGISTRY 本地 lane）、§9.2（tts_chars 字段）、§12（T9–T13 测试用例 + D-11/D-12）、§13.1/13.3/13.5（compose profiles + 环境变量）、§15（许可证矩阵增补） |

---

*Mnemosyne — Your memory never dies. (And now it speaks, thinks ahead, and knows when to stay quiet.)*
