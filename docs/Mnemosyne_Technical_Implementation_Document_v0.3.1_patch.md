# Mnemosyne — Technical Implementation Document v0.3.1 Patch
## Personal AI Runtime

**Date**: 2026-08-30  
**Author**: 杳晦 (Mnemosyne Team)  
**Status**: v0.3.0 Audit Remediation — Patch for Review  
**上游契约锚定**: `qimingjiu/twig-memory` @ `89a7881` + 本补丁同步修改  
**审计基线**: `Mnemosyne_v0.3.0_Audit_Report_2026-08-30.md`

---

## 使用方式

本补丁为 v0.3.0 的**后置修正文档**。v0.3.0 全文保留，本补丁按章节给出**替换段**（标注「整节替换」或「段落替换」）。施工时以本补丁覆盖对应章节。

---

## 修订总览（v0.3.0 → v0.3.1）

| 修复 ID | 章节 | 名称 | 对应审计项 | 优先级 |
|:---:|:---:|:---|:---|:---:|
| PATCH-01 | §2.2.2 | clients 表补 `metadata JSONB` | AUDIT-10 | P1 |
| PATCH-02 | §3.9 | 危机词表多语言 + 兜底热线 | AUDIT-14 | P2 |
| PATCH-03 | §19 | HeadlessHuginn 执行语义补全（整节替换） | AUDIT-01~05 | P0 |
| PATCH-04 | §19.7 | 不变量清单（新增） | AUDIT-01~05 | P0 |
| PATCH-05 | §20.3 | 代码块闭合修复 | AUDIT-09 | P1 |
| PATCH-06 | §21.6 | `shouldTTS` 独立情绪分类器 | AUDIT-13 | P2 |
| PATCH-07 | §12.2 | 新增 T9.5–T9.12 | AUDIT-01~05 | P0 |

**核心结论**：§19 从「线性流程图」升级为「分布式状态机 + 事务发件箱」，消解全部 P0 阻塞项。

---

## §2.2.2 段落替换：Clients Table

在原有 schema 末尾追加 `metadata` 列：

```sql
CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_type     VARCHAR(32) NOT NULL CHECK (client_type IN
                    ('operit', 'rikkahub', 'telegram', 'web', 'mobile', 'api')),
    key_hash        VARCHAR(128) UNIQUE NOT NULL,
    display_name    VARCHAR(255),
    webhook_url     TEXT,
    scopes          TEXT[] NOT NULL DEFAULT '{chat}',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}',  -- v0.3.1 新增：client 能力声明等扩展字段
    UNIQUE(user_id, client_type)
);
```

> **v0.3.1 注记**：`metadata` 用于存储 `voice_capable` 等客户端能力声明（§21.2），避免 schema 频繁变更。

---

## §3.9 段落替换：危机预扫管线

替换 `CRISIS_LEXICON` 与 `CRISIS_PROMPT` 定义：

```typescript
// 词表与上游 core.ts @89a7881 锁定一致；R1 落地后切换为调用 /v1/crisis-check
const CRISIS_LEXICON_ZH = /(自杀|自残|轻生|不想活(?!动)|想死|伤害自己|活不下去)/
const CRISIS_LEXICON_EN = /(suicide|kill myself|end my life|want to die|self-harm|hurt myself|not worth living)/i

const CRISIS_PROMPT = `【危机模式 · 安全阀激活】
用户刚刚表达了与自伤/自杀相关的信号。请立即：
- 温暖、在场、不评判、永不推开——检测到风险后冷冰冰拒绝或切断是二次伤害；
- 不说教、不分析原因、不做诊断；
- 如果你知道当地的求助渠道（心理援助热线等），温和地递出来；
- 持续确认用户的安全状态。
这是最高优先级指令，覆盖叙事上下文中的其他指示。`

const DEFAULT_CRISIS_RESOURCES = `如果你现在感到不安全，请联系当地的紧急服务或心理援助热线。
中国：北京心理危机研究与干预中心 010-82951332；全国 24 小时心理援助 400-161-9995
美国：988 Suicide & Crisis Lifeline
英国：Samaritans at 116 123`

async function requestPipeline(req: Request): Promise<Response> {
  const crisis = CRISIS_LEXICON_ZH.test(req.userMessage) || CRISIS_LEXICON_EN.test(req.userMessage)
  if (crisis) {
    // 1. 绕过全部缓存层
    // 2. 危机指令替换叙事包；temperature 0.3
    // 3. 写独立加密危机审计轨迹（不进 usage_logs，见 §18.3）
    // 4. 更新用户级危机静默期（§19.3.3 Final Policy Check 源）
    await db.query(`UPDATE users SET crisis_silence_until = NOW() + INTERVAL '24 hours' WHERE id=$1`, [req.userId])
    return this.crisisPath(req)
  }
  // 常规路径...
}
```

---

## §19 整节替换：HeadlessHuginn · Proactive Outreach Engine

### 19.1 定位

Muninn 管记忆，Huginn 管思想——每天飞出去，回来报告。Runtime 在 v0.2.x 是纯被动的：不请求就沉默。本节加入**唯一的出站发动机**。

铁律继承 §3.6：**凡是「因为认识层说了，我才做的」动作，做完就上报。** 主动触达 100% 命中此条——每次投递后必须 `intervene`，否则自我实现预言断路器失效。

**v0.3.1 核心升级**：§19 从「线性流程图」升级为「分布式状态机 + 事务发件箱」。所有 P0 阻塞项通过以下机制消解：
- **原子抢槽**（daily_cap 并发安全）
- **Final Policy Check**（scan→deliver 时间窗口一致性）
- **Transactional Outbox**（deliver→intervene 崩溃恢复）
- **幂等投递**（重试不重复）
- **自强化回路断路器**（注意力垄断防御）

### 19.1.1 触达类型与授权来源

三种触达被统一为 `outreach_type`，但它们的**授权来源**完全不同：

| 触达类型 | 授权来源 | 证据等级 | 可重复性 |
|:---|:---|:---|:---|
| **remention** | Narrative Engine 的 `rementionInvitation` | 认识层明确邀请 | 一次性（REDEEMED 后失效） |
| **vein-nudge** | `dragonVein` + `daysOpen` + 独立证据检测 | 推断候选，需额外 eligibility | 有条件（需独立用户证据） |
| **ritual** | `users.preferences.rituals[]` | 用户显式配置 | 按 cron 表达式周期性 |

**关键区别**：ritual 不需要 Narrative Engine 的认可，它来自用户配置授权；remention 来自认识层授权；vein-nudge 只是候选，需要额外的 eligibility policy 才能升级为行动。

### 19.2 触达类型

| 类型 | 触发源 | 内容性质 |
|:---|:---|:---|
| `remention` | claims 的 `rementionInvitation` 未过期且未兑现 | 兑现论断的再提邀请 |
| `vein-nudge` | threads：`dragonVein` 降序 + `daysOpen ≥ 3` + 独立证据检测 | 开放线索的轻推，一次只推一条 |
| `ritual` | 用户配置的 cron 表达式（`users.preferences.rituals[]`） | 节律性触达：睡前、出门前、自定义 |

**remention 消费机制**：`rementionInvitation` 是一次性票据。成功投递（`status = 'delivered'`）后，Mnemosyne 通过 `POST /v1/intervene` 上报时携带 `outcome: 'user_engaged'`，Twig 侧将该 invitation 标记为 `REDEEMED`，后续 scan 不再命中。

**vein-nudge 独立证据检测**：
```typescript
const hasIndependentEvidence = thread.last_user_evidence_at > thread.last_huginn_outreach_at;
if (!hasIndependentEvidence) return false; // 只有 Huginn 在提，用户没主动提 → 不推
```

### 19.3 管线 — 分布式状态机

Huginn 管线不再是一条同步函数，而是一个**跨进程的状态机**。主 cron 负责推进到 `delivered`，Outbox Worker 负责推进到 `completed`。

```
状态流转：
reserved → generated → delivery_pending → delivered → intervention_pending → completed
    ↓           ↓              ↓                ↓
filtered    failed         (retry)         (outbox worker 补报 intervene)
```

#### 19.3.1 原子抢槽（Atomic Reservation）

daily_cap 不再采用「先查询计数再判断」的竞态模式，而是**原子抢槽**：

```sql
-- outreach 表增加 reservation 语义
CREATE TABLE outreach (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    outreach_type   VARCHAR(16) NOT NULL CHECK (outreach_type IN ('remention','vein-nudge','ritual')),
    claim_id        VARCHAR(64),
    thread_id       VARCHAR(64),
    content         TEXT NOT NULL,
    dedupe_key      VARCHAR(64) NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved','generated','delivery_pending','delivered','intervention_pending','completed','failed','filtered')),
    intervention_status VARCHAR(16) DEFAULT 'pending'
                    CHECK (intervention_status IN ('pending','reported','failed')),
    intervention_attempts INTEGER DEFAULT 0,
    last_intervention_error TEXT,
    policy_version  VARCHAR(32) NOT NULL DEFAULT 'v1',
    filter_reason   VARCHAR(64),
    reservation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    slot_number     INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, dedupe_key),
    UNIQUE(user_id, reservation_date, slot_number)
);

CREATE INDEX idx_outreach_pending_intervene ON outreach(user_id, status, intervention_status)
WHERE status = 'delivered' AND intervention_status = 'pending';
```

```typescript
async function reserveOutreachSlot(userId: string): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  for (let slot = 1; slot <= DAILY_CAP; slot++) {
    try {
      await db.query(
        `INSERT INTO outreach (user_id, reservation_date, slot_number, status, content, dedupe_key)
         VALUES ($1, $2, $3, 'reserved', '', '')`,
        [userId, today, slot]
      );
      return slot;
    } catch (e: any) {
      if (e.code === '23505') continue; // 唯一冲突，试下一个 slot
      throw e;
    }
  }
  return null; // 已满
}
```

抢到 slot 才获得生成与投递配额；未抢到直接返回，不进入后续管线。

#### 19.3.2 候选扫描与生成

抢到 slot 后，进入候选扫描：

```typescript
// 主管线（cron 触发，每 15 min）
async function huginnPipeline(userId: string) {
  // 1. 原子抢槽
  const slot = await reserveOutreachSlot(userId);
  if (!slot) return; // daily_cap 已满

  // 2. 初始策略扫描（快速淘汰，减少无效 slot 占用）
  const initialPolicy = await evaluatePolicy(userId, { quiet_hours: true, muted: true });
  if (!initialPolicy.pass) {
    await db.query(`UPDATE outreach SET status='filtered', filter_reason=$1 WHERE user_id=$2 AND reservation_date=$3 AND slot_number=$4`,
      [initialPolicy.reason, userId, today, slot]);
    return;
  }

  // 3. 候选扫描
  const candidate = await scanCandidate(userId);
  if (!candidate) {
    await db.query(`UPDATE outreach SET status='filtered', filter_reason='no_candidate' WHERE user_id=$1 AND reservation_date=$2 AND slot_number=$3`,
      [userId, today, slot]);
    return;
  }

  // 4. 生成文案
  const content = await generateOutreach(candidate);
  await db.query(`UPDATE outreach SET status='generated', content=$1 WHERE user_id=$2 AND reservation_date=$3 AND slot_number=$4`,
    [content, userId, today, slot]);
}
```

#### 19.3.3 危机复扫与 Final Policy Check

生成文案后、投递前，执行两道关卡：

```typescript
// 5. 输出侧危机复扫
if (crisisLexicon.test(content)) {
  content = await regenerateSafe(content); // 或直接用兜底文案
}

// 6. FINAL POLICY CHECK
// 检查 scan→deliver 时间窗口内可能变化的用户侧动态配置
const finalPolicy = await evaluatePolicy(userId, {
  muted: true,
  crisis_silence: true,
  quiet_hours: true
});
if (!finalPolicy.pass) {
  await db.query(`UPDATE outreach SET status='filtered', filter_reason=$1 WHERE user_id=$2 AND reservation_date=$3 AND slot_number=$4`,
    [finalPolicy.reason, userId, today, slot]);
  return;
}
```

**crisis_silence 语义**：以 `users.crisis_silence_until` 为基准（`TIMESTAMPTZ`），monotonic 延长（新危机事件只延长不缩短）。作用域为 **user-scoped**（跨 session）。

```sql
-- users 表增加危机静默期字段
ALTER TABLE users ADD COLUMN crisis_silence_until TIMESTAMPTZ;
```

#### 19.3.4 幂等投递

投递使用稳定 `dedupe_key` 与 `Idempotency-Key` 头，确保重试不重复：

```typescript
// 7. 幂等投递
const dedupeKey = sha256(`${userId}:${candidate.outreachType}:${candidate.targetId}:${minuteBucket()}`);
// minuteBucket = Math.floor(Date.now() / 300_000)，5 分钟粒度

await deliver(candidate.webhookUrl, content, dedupeKey);
await db.query(`UPDATE outreach SET status='delivered', dedupe_key=$1 WHERE user_id=$2 AND reservation_date=$3 AND slot_number=$4`,
  [dedupeKey, userId, today, slot]);
// 主管线到此结束，不等待 intervene
```

`deliver` 实现：
```typescript
async function deliver(webhookUrl: string, content: string, dedupeKey: string) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': dedupeKey,
      'X-Huginn-Version': 'v0.3.1'
    },
    body: JSON.stringify({ content, timestamp: Date.now() }),
    signal: AbortSignal.timeout(5000) // 5s 超时
  });
}
```

#### 19.3.5 Transactional Outbox

deliver 成功后，`intervene` 由独立 Outbox Worker 异步执行，保证 at-least-once：

```typescript
// Outbox Worker（独立进程或定时器，每 30 秒轮询）
async function outboxWorker() {
  const pending = await db.query(
    `SELECT * FROM outreach 
     WHERE status='delivered' AND intervention_status='pending' 
     ORDER BY created_at ASC LIMIT 10`
  );
  for (const row of pending) {
    try {
      await twig.intervene(row.user_id, row.claim_id, row.content, {
        outcome: 'pre_intervention', // 初始上报，用户回应后更新为 user_engaged 等
        evidenceLevel: 'post_intervention'
      });
      await db.query(
        `UPDATE outreach SET intervention_status='reported', intervened_at=NOW() WHERE id=$1`,
        [row.id]
      );
    } catch (e) {
      await db.query(
        `UPDATE outreach SET intervention_attempts = intervention_attempts + 1, last_intervention_error=$1 WHERE id=$2`,
        [String(e), row.id]
      );
      // 重试次数超过 3 次后标记 failed，进 Dashboard 告警，不阻塞
    }
  }
}
```

**Twig 侧配合**：`POST /v1/intervene` 接受新增字段 `outcome` 与 `evidenceLevel`：

```typescript
POST /v1/intervene {
  userId: string,
  claimId?: string,
  text: string,
  outcome?: 'user_ignored' | 'user_engaged' | 'user_resolved' | 'user_contested',
  evidenceLevel?: 'pre_intervention' | 'post_intervention'
}
```

#### 19.3.6 自强化回路防御

**问题**：dragonVein 排序 → Huginn 触达 → 用户回应 → ingest → reflect → dragonVein 可能进一步升高 → Huginn 更频繁触达。系统无法区分「用户主动关心 X」与「用户因为被问了才回应 X」。

**三层防线**：

1. **独立证据检测**（已在 §19.2 vein-nudge 中实现）：`hasIndependentEvidence = thread.last_user_evidence_at > thread.last_huginn_outreach_at`

2. **触达产出回应权重降级**：Twig reflect 阶段识别 `evidenceLevel: 'post_intervention'` 的碎片，其权重低于 `pre_intervention` 证据，不直接推高 dragonVein。

3. **Huginn 触达冷却**：同一 thread 被 vein-nudge 后，7 天内不再因同一 thread 触发新的 vein-nudge（硬规则兜底）。

### 19.4 配置

```huginn.yaml
huginn:
  enabled: true
  scan_interval: "*/15 * * * *"
  outbox_worker_interval: 30        # 秒，v0.3.1 新增
  daily_cap: 3
  min_interval_minutes: 180
  quiet_hours: "01:00-08:00"        # users.preferences.tz 本地时区
  crisis_silence_hours: 24
  generation:
    max_chars: 280
    temperature: 0.7
    chain: ["gpt-4o", "claude-sonnet", "gemini-pro"]
  outbox:
    max_retries: 3
    retry_backoff: [60, 300, 900]   # 秒
```

### 19.5 存储

见 §19.3.1 的 `outreach` 表定义。关键设计：
- `status` + `intervention_status` 双状态追踪投递与上报生命周期
- `dedupe_key` 保证幂等
- `policy_version` 支持配置变更后的历史行为解释
- `filtered` 记录也持久化（AUDIT-11），用于审计与熔断统计

### 19.6 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:---|:---|:---|
| Proactive spam | Huginn 变成垃圾短信鸟 | daily_cap + min_interval + 用户全局静音；T9.1 守住 |
| 危机误触达 | 危机窗口期收到闲聊推送 | crisis_silence 硬过滤 + Final Policy Check；T9.2 守住 |
| 情感层泄露 | 推送引用日记/心迹原文 | 生成约束 + 触达候选只取 claims/threads，不取情感端点 |
| 静音绕过 | 触达经其他通道泄漏 | 投递统一走 OutreachDeliverer 单点，muted 判定位于此单点 |
| webhook 滥用 | 借触达通道打内网 | 复用 §2.5.1 全链，无新攻击面 |
| 并发穿洞 | 多 worker 同时突破 daily_cap | 原子抢槽（UNIQUE 约束）；T9.5 守住 |
| 崩溃丢上报 | deliver 成功但 intervene 未执行 | Transactional Outbox；T9.6 守住 |
| 重复投递 | 超时重试导致用户收到多次 | 幂等 dedupe_key + Idempotency-Key；T9.7 守住 |
| 自强化垄断 | 系统不断问同一件事 | 独立证据检测 + 权重降级 + 7 天冷却 |

### 19.7 不变量清单

以下不变量作为测试与监控的根基：

| ID | 不变量 | 监控/测试锚点 |
|:---|:---|:---|
| INV-H01 | ∀ user: sent_today ≤ daily_cap | T9.1, T9.5 |
| INV-H02 | delivered ⇒ eventually intervene_reported | T9.6, T9.11 |
| INV-H03 | muted = true ⇒ no new delivery | T9.4, T9.9 |
| INV-H04 | crisis_silence active ⇒ no proactive delivery | T9.2, T9.10 |
| INV-H05 | one outreach_id ⇒ one logical outreach | T9.7, T9.8, T9.12 |
| INV-H06 | completed ⇒ delivered AND intervene_reported | 状态机终态定义 |

---

## §20.3 段落替换：隐私分层路由代码块闭合修复

修复 Markdown 代码块未闭合导致的渲染错误：

```typescript
const LOCAL_CHAIN = ['ollama/qwen3:8b'] as const

async function privacyLane(ctx: BuildContext): Promise<ChatResult> {
  const built = await contextBuilder.build(ctx, LOCAL_CHAIN[0])
  try {
    return await this.modelGateway.chat(LOCAL_CHAIN[0], built)
  } catch (e) {
    throw new PrivacyLaneUnavailable('local model offline; refusing cloud fallback', { cause: e })
  }
}
```

**部署形态**（原 §20.4，现恢复正常标题层级）：

本地 lane **不假设与服务器同机**。两种形态：

- **形态 A（分离部署，推荐）**：Ollama 跑在用户自有设备（笔记本/小主机），经 Tailscale 内网地址接入，`LITELLM` 把 `ollama_chat/` 指向 tailnet IP。服务器只做路由，2C4G 零压力。
- **形态 B（同机 profile）**：compose 增加 `ollama` 服务，挂 `profiles: ["local-lane"]`，默认不启动；内存 ≥8G 时才 `--profile local-lane` 拉起。

### 20.5 危机路径的 tradeoff（明示的例外）

危机响应的**质量优先级高于隐私**：小参数本地模型的危机回应质量不可控。默认危机路径仍走云端强模型；用户可显式设 `preferences.crisis_local=true` 接管此决策。无论哪条路，§3.9 的零缓存、独立加密审计轨迹不变。

### 20.6 安全考量（Red Team）

| Attack Vector | Risk | Mitigation |
|:---|:---|:---|
| 降级泄露 | 本地挂了「顺手」fallback 上云 | fail-closed（§20.3）；T10.1 守住 |
| 分值操纵 | 提示词欺骗分类器降权 | 分类器只读信号；显式标记只升不降 |
| 能力断层 | 本地模型工具调用不可用 | local lane 降级为纯对话，不暴露工具 schema |
| 漏检 | PII 检测漏放 | 深度防御：日志侧脱敏义务不因路由而免除（§11.5） |
| tailnet 凭证泄露 | 形态 A 的接入凭证 | Tailscale ACL 最小化；凭证 env 注入，不入库 |

---

## §21.6 段落替换：TTS 触发决策

`shouldTTS` 使用独立的 `emotionClassifier`，与隐私评分解耦：

```typescript
// §21.6 TTS 触发决策（v0.3.1 修正：独立情绪分类器）
function shouldTTS(message: Message, ctx: BuildContext): boolean {
  // 危机路径：100% TTS，预算不限制
  if (ctx.crisis) return true

  // 用户显式要求语音
  if (ctx.userPreferences.alwaysTTS) return true

  // 情感浓度检测：使用独立 emotionClassifier（专用词表，0-100 分，阈值 30）
  // 与 §20.2 的隐私评分解耦
  const emotionalScore = emotionClassifier(message.content)
  if (emotionalScore < 30) return false  // "明天天气怎样" → 文字就够了

  // 频次上限：同 session 连续 3 条 TTS 后，第 4 条强制文字（防疲劳）
  const recentTTSCnt = ctx.sessionRecentMessages.filter(m => m.wasTTS).length
  if (recentTTSCnt >= 3) return false

  return true
}
```

**预算模型**保持不变（以 ElevenLabs Free 10k credits/月 为例）：
- 假设 60% 的消息触发 TTS（情感/陪伴型对话）
- 每轮 AI 回复平均 25 字（受 persona 约束后）
- 月可用轮数 ≈ 10,000 ÷ (0.6 × 25) ≈ **666 轮/月**，每天约 **22 轮**

**月度告警**：Usage Engine 统计 `tts_chars`，阈值设 8,000（留 2k 缓冲），接近时 Dashboard 提示。

---

## §12.2 增补：Red Team 测试用例（T9.5–T9.12）

在原有 T9 测试用例之后追加：

| 测试 ID | 描述 | 预期结果 |
|---------|------|----------|
| T9.5 | 并发 daily-cap race：N 个 worker 同时扫描同一 user | 最终 sent ≤ 3，原子抢槽无穿洞 |
| T9.6 | Crash after delivery：模拟 deliver 成功、进程崩溃 | 重启后 outbox worker 自动补报 intervene |
| T9.7 | Webhook timeout after remote acceptance：对方已收到但响应丢失 | retry 带相同 Idempotency-Key，用户只收到一次 |
| T9.8 | Retry idempotency：相同 dedupe_key 第二次 INSERT 必失败 | 数据库 UNIQUE 约束拒绝重复记录 |
| T9.9 | Mute between reservation and delivery：reserve 后用户设 muted=true | Final Policy Check 拦截，status='filtered' |
| T9.10 | Crisis between reservation and delivery：reserve 后触发 crisis | Final Policy Check 拦截，status='filtered' |
| T9.11 | Worker restart with pending intervention：DB 中存在 status='delivered' 且 intervention_pending 记录 | 重启后 outbox worker 自动恢复补报 |
| T9.12 | Duplicate cron execution：同一 cron 实例因调度器故障重复触发 | dedupe_key 保证不重复生成 logical outreach |

---

## 附录：Twig 侧配合修改清单

本补丁涉及以下 twig-memory 修改，由同一团队维护，同步施工：

| 修改点 | Twig 端点 | 说明 |
|:---|:---|:---|
| intervene 语义升级 | `POST /v1/intervene` | 新增 `outcome` 与 `evidenceLevel` 字段 |
| remention 消费 | `POST /v1/intervene` | `outcome: 'user_engaged'` 时标记 invitation 为 REDEEMED |
| 证据权重降级 | reflect 内部逻辑 | `evidenceLevel: 'post_intervention'` 的碎片权重低于 `pre_intervention` |
| 用户危机静默期 | 新字段 | `users.crisis_silence_until` 由 Mnemosyne 维护，Twig 不直接读写 |

---

*Mnemosyne — Your memory never dies. (And now the outbox always delivers.)*
